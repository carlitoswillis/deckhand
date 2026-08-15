// Provider router — Ollama local first, Gemini free tier as fallback.
//
// Shaped after a sibling project's provider router, but trimmed hard and turned
// text-first. That one exists to get validated JSON out of a model: every call carries a `parse` callback, requests
// responseMimeType: 'application/json', and treats unparseable output as a
// terminal 'unusable' outcome. Deckhand wants prose — "your three qwen models
// total 15 GB" — so that whole apparatus would be dead weight here.
//
// What IS worth keeping from it, and is kept:
//   - a cached liveness probe, so a dead Ollama doesn't cost 120 s per call;
//   - refusing to route to Ollama when the configured model isn't pulled;
//   - the distinction between "provider unavailable" (cascade) and "provider
//     answered badly" (don't cascade — escalating won't help and costs quota).
//
// Ordering is deliberately the reverse of that one. There, Gemini leads
// because its free tier is the point. Here Ollama leads: the whole promise is a
// tool that knows this Mac and runs offline and free forever (PLAN.md Phase 2),
// and the snapshot is already-structured facts, which is the easy case for a
// local model. Gemini is the escape hatch, not the default.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.DECKHAND_MODEL ?? 'qwen2.5-coder:14b';
const OLLAMA_TIMEOUT_MS = 180_000; // a 14B on first token after a cold load is slow
const PROBE_TIMEOUT_MS = 1_500;
const PROBE_TTL_MS = 30_000;

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const GEMINI_TIMEOUT_MS = 45_000;
// Gemini 2.5 Flash has a 1M-token window. The entire snapshot is ~45k, so the
// digest never needs to drop a section for Gemini — this ceiling exists only to
// stop a runaway future snapshot, not to squeeze anything today.
const GEMINI_BUDGET_TOKENS = 200_000;

// Rough allowance for the persona plus the question, subtracted from the local
// model's context before the snapshot gets what's left.
const PERSONA_RESERVE_TOKENS = 600;

// The server's configured context, probed once. Falls back to ollama's own
// default rather than to the value this machine happens to use today.
let ctxCache;

async function ollamaContextLength() {
  if (ctxCache !== undefined) return ctxCache;

  const fromEnv = Number(process.env.OLLAMA_CONTEXT_LENGTH);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return (ctxCache = fromEnv);

  try {
    // A loaded model reports the context it was actually loaded with, which is
    // the number that matters — not what the server would use next time.
    const res = await fetch(`${OLLAMA_HOST}/api/ps`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const json = await res.json();
    const loaded = (json.models ?? []).find((m) => m.name === OLLAMA_MODEL);
    if (loaded?.context_length) return (ctxCache = loaded.context_length);
  } catch {
    // Fall through to the default.
  }

  return (ctxCache = 4096); // ollama's own default when nothing is configured
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Ask a provider for prose.
 *
 * `prompt` may be a string, or a function receiving that provider's context
 * budget and returning the prompt to send it. The function form exists because
 * shrinking the snapshot is a QWEN problem, not a universal one: the local model
 * runs at OLLAMA_CONTEXT_LENGTH (16384 here), while Gemini 2.5 Flash has a 1M
 * window and can simply be handed the whole thing. Building one small prompt and
 * sending it to both would throw away Gemini's biggest advantage for no reason.
 *
 * @param {string | ((ctx: {provider: string, budgetTokens: number}) => string)} prompt
 * @returns {Promise<{ok: boolean, text: string|null, provider: string|null, model: string|null, ms: number, error: string|null, attempts: object[], budgetTokens: number|null}>}
 */
export async function ask(prompt, { system, temperature = 0.2, maxTokens = 800, provider: forced } = {}) {
  const attempts = [];
  const started = Date.now();

  // ONE model answers everything, and the order is fixed rather than chosen per
  // question. An earlier version routed arithmetic questions to a bigger model
  // because the local one kept getting them wrong — but the real cause was a
  // bug here: the digest read `ollamaModels.items` when the field is `.models`,
  // so model sizes were never in the prompt and qwen was guessing at a number
  // it had never been shown. With the sizes present it answers correctly
  // (verified 2026-08-14). Routing around a bad prompt would have hidden that
  // permanently, which is the argument against mixing models in general.
  //
  // Everything below the first entry is FAILOVER — for when a provider is
  // down, not for when an answer is hard.
  const order = resolveOrder(forced);

  for (const provider of order) {
    const available = await provider.isAvailable();
    if (!available.ok) {
      attempts.push({ provider: provider.name, outcome: 'unavailable', why: available.why });
      continue;
    }

    const budgetTokens = await provider.budgetTokens(maxTokens);
    const body =
      typeof prompt === 'function'
        ? prompt({ provider: provider.name, budgetTokens, billed: Boolean(provider.billed) })
        : prompt;

    const res = await provider.run(body, { system, temperature, maxTokens });
    res.budgetTokens = budgetTokens;
    attempts.push({ provider: provider.name, outcome: res.ok ? 'ok' : 'error', why: res.error, ms: res.ms });

    if (res.ok) {
      return {
        ok: true,
        text: res.text,
        provider: provider.name,
        model: res.model,
        costUsd: res.costUsd ?? null,
        budgetTokens,
        ms: Date.now() - started,
        error: null,
        attempts,
      };
    }
  }

  return {
    ok: false,
    text: null,
    provider: null,
    model: null,
    budgetTokens: null,
    ms: Date.now() - started,
    error: attempts.map((a) => `${a.provider}: ${a.why ?? a.outcome}`).join('; ') || 'no provider configured',
    attempts,
  };
}

// Default order: local first (free, offline, fast), then Gemini's free tier,
// then Claude — which is last because it is the only one that bills.
// DECKHAND_PROVIDER overrides it, e.g. "claude" or "claude,ollama".
const DEFAULT_ORDER = ['ollama', 'gemini', 'claude'];

function registry() {
  return { ollama: ollamaProvider, gemini: geminiProvider, claude: claudeProvider };
}

function resolveOrder(forced) {
  const all = registry();
  const names = forced
    ? [forced]
    : (process.env.DECKHAND_PROVIDER?.split(',').map((s) => s.trim()).filter(Boolean) ?? DEFAULT_ORDER);

  const resolved = names.map((n) => all[n]).filter(Boolean);
  return resolved.length ? resolved : [all.ollama];
}

/** What the router would do right now, without spending a call. */
export async function providerStatus() {
  const all = registry();
  const order = resolveOrder();
  const entries = await Promise.all(
    Object.entries(all).map(async ([name, p]) => [name, await p.isAvailable()]),
  );

  const out = {};
  for (const [name, status] of entries) {
    out[name] = {
      ...status,
      rank: order.findIndex((p) => p.name === name) + 1 || null,
      ...(name === 'ollama' ? { model: OLLAMA_MODEL, host: OLLAMA_HOST } : {}),
      ...(name === 'gemini' ? { models: GEMINI_MODELS } : {}),
      ...(name === 'claude' ? { model: CLAUDE_MODEL, billed: true } : {}),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ollama
// ---------------------------------------------------------------------------

let probeCache = { at: 0, value: null };

const ollamaProvider = {
  name: 'ollama',

  // Read the real context length off the running server rather than assuming
  // 16384 — it's configured by a LaunchAgent (../multimodel/PLAN.md) and has
  // already changed once during development. Reserve room for the system
  // prompt, the question, and the answer; the rest is the snapshot's.
  async budgetTokens(maxOutputTokens) {
    const ctx = await ollamaContextLength();
    const reserve = maxOutputTokens + PERSONA_RESERVE_TOKENS;
    return Math.max(1_000, ctx - reserve);
  },

  // Cached, bounded probe. Without this a stopped Ollama costs the full
  // generate timeout on every single question.
  async isAvailable() {
    if (probeCache.value && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.value;

    let value;
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) {
        value = { ok: false, why: `ollama returned HTTP ${res.status}` };
      } else {
        const json = await res.json();
        const names = (json.models ?? []).map((m) => m.name);
        // Being up is not enough — if the configured model isn't pulled, the
        // generate call would fail after a long wait. Better to skip straight
        // to the fallback, which is a good rule worth keeping.
        value = names.includes(OLLAMA_MODEL)
          ? { ok: true, why: null, models: names }
          : { ok: false, why: `ollama is up but ${OLLAMA_MODEL} is not pulled (have: ${names.join(', ')})` };
      }
    } catch (err) {
      value = { ok: false, why: `ollama unreachable: ${err?.message ?? err}` };
    }

    probeCache = { at: Date.now(), value };
    return value;
  },

  async run(prompt, { system, temperature, maxTokens }) {
    const started = Date.now();
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt,
          system,
          stream: false,
          options: { temperature, num_predict: maxTokens },
        }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      });

      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, ms: Date.now() - started };
      }

      const json = await res.json();
      const text = (json.response ?? '').trim();
      if (!text) return { ok: false, error: 'empty response', ms: Date.now() - started };

      return { ok: true, text, model: OLLAMA_MODEL, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err), ms: Date.now() - started };
    }
  },
};

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

// Environment first, then this project's own .env (gitignored). An earlier
// version also read a sibling project's .env as a convenience — reaching into
// another checkout for a secret is the kind of shortcut that only works on the
// machine it was written on, and it has no business in a published tool.
// DECKHAND_ENV_FILE points somewhere else if you keep keys elsewhere.
let cachedKey;

async function geminiKey() {
  if (cachedKey !== undefined) return cachedKey;

  cachedKey = process.env.DECKHAND_GEMINI_KEY ?? process.env.GOOGLE_AI_API_KEY ?? null;
  if (!cachedKey) {
    const envFile = process.env.DECKHAND_ENV_FILE ?? path.join(ROOT, '.env');
    try {
      const m = /^GOOGLE_AI_API_KEY=(.+)$/m.exec(await readFile(envFile, 'utf8'));
      if (m) cachedKey = m[1].trim();
    } catch {
      // Missing .env is the normal case, not an error.
    }
  }
  return cachedKey;
}

const geminiProvider = {
  name: 'gemini',

  // No shrinking needed — see GEMINI_BUDGET_TOKENS.
  async budgetTokens() {
    return GEMINI_BUDGET_TOKENS;
  },

  async isAvailable() {
    const key = await geminiKey();
    return key
      ? { ok: true, why: null }
      : { ok: false, why: 'no GOOGLE_AI_API_KEY / DECKHAND_GEMINI_KEY' };
  },

  async run(prompt, { system, temperature, maxTokens }) {
    const started = Date.now();
    const key = await geminiKey();

    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              systemInstruction: system ? { parts: [{ text: system }] } : undefined,
              generationConfig: {
                temperature,
                maxOutputTokens: maxTokens,
                // Gemini 2.5 counts THINKING tokens against maxOutputTokens, so
                // a reasoning pass silently eats the budget and the reply comes
                // back truncated mid-sentence (verified 2026-08-14: an answer
                // ended at "Loading the `qwen2.5-coder:14b"). These are short
                // factual answers over facts already laid out for the model —
                // there's nothing here worth a thinking pass.
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
            signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
          },
        );

        // 429 means the free tier is spent for now; a different model in the
        // list may still have quota, so try the next one rather than giving up.
        if (res.status === 429) continue;
        if (!res.ok) {
          return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, ms: Date.now() - started };
        }

        const json = await res.json();
        const text = (json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '').trim();
        if (!text) continue;

        return { ok: true, text, model, ms: Date.now() - started };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err), ms: Date.now() - started };
      }
    }

    return { ok: false, error: 'all gemini models rate-limited or empty', ms: Date.now() - started };
  },
};

// ---------------------------------------------------------------------------
// Claude (via the local CLI)
// ---------------------------------------------------------------------------

// Added on request 2026-08-14. Note this is a deliberate departure
// from PLAN.md's "free only — Claude scaffolds, never runs it": these calls are
// billed (a trivial one measured at $0.038, mostly cache creation), so it is
// not free the way Ollama and Gemini's tier are. Opt-in, never the default.
//
// Two flags matter. `--system-prompt` REPLACES Claude Code's own agent prompt
// rather than appending to it — without it every call drags ~25k tokens of
// tooling context that has nothing to do with this Mac. `--strict-mcp-config`
// keeps the user's MCP servers out of a question about disk space.
const CLAUDE_MODEL = process.env.DECKHAND_CLAUDE_MODEL ?? 'haiku';
const CLAUDE_TIMEOUT_MS = 120_000;
const CLAUDE_BUDGET_TOKENS = 150_000;

const CLAUDE_PATHS = [
  `${process.env.HOME}/.local/bin/claude`,
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
];

const claudeProvider = {
  name: 'claude',
  // The only provider that costs money per question — see the raw-snapshot
  // decision in ask.mjs.
  billed: true,

  async budgetTokens() {
    return CLAUDE_BUDGET_TOKENS;
  },

  async isAvailable() {
    const { existsSync } = await import('node:fs');
    const found = CLAUDE_PATHS.find((p) => existsSync(p));
    return found ? { ok: true, why: null, path: found } : { ok: false, why: 'claude CLI not found' };
  },

  async run(prompt, { system }) {
    const started = Date.now();
    const { path: bin } = await this.isAvailable();

    try {
      // The prompt goes over stdin, not argv: with the raw snapshot attached it
      // runs to ~260 KB, which is the wrong thing to put in an argument list.
      const out = await spawnCapture(
        bin,
        [
          '-p',
          '--model', CLAUDE_MODEL,
          '--output-format', 'json',
          '--strict-mcp-config',
          '--system-prompt', system ?? '',
        ],
        prompt,
        CLAUDE_TIMEOUT_MS,
      );

      const json = JSON.parse(out);
      if (json.is_error) {
        return { ok: false, error: json.result ?? 'claude reported an error', ms: Date.now() - started };
      }

      const text = (json.result ?? '').trim();
      if (!text) return { ok: false, error: 'empty response', ms: Date.now() - started };

      return {
        ok: true,
        text,
        model: CLAUDE_MODEL,
        costUsd: json.total_cost_usd ?? null,
        ms: Date.now() - started,
      };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err), ms: Date.now() - started };
    }
  },
};

function spawnCapture(file, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.split('\n')[0] || `exited ${code}`));
    });

    child.stdin.end(input);
  });
}

#!/usr/bin/env node
// deckhand — a deckhand who knows every inch of this Mac.
//
// Node v22, ESM, built-in modules only, zero runtime dependencies.
//
// Phase 1 is deliberately AI-free: `scan` writes a structured snapshot, and the
// snapshot alone should answer the interesting questions by grep. The LLM comes
// in Phase 2 and reads this same file — that seam is the whole architecture
// (PLAN.md), so nothing in the collectors may assume a model is present.
//
// READ-ONLY. Deckhand observes and suggests; it never deletes, kills, or
// reconfigures. Suggestions end as a printed command for you to run.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScan } from './src/scan.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = process.env.DECKHAND_SNAPSHOT ?? path.join(ROOT, 'data', 'snapshot.json');

// Hand-rolled, like every other CLI in the workspace — no arg-parsing dep.
const command = process.argv[2] ?? 'help';
const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const COMMANDS = {
  scan: cmdScan,
  show: cmdShow,
  ask: cmdAsk,
  fact: cmdFact,
  providers: cmdProviders,
  serve: cmdServe,
  help: cmdHelp,
};

const handler = COMMANDS[command];
if (!handler) {
  console.error(`deckhand: unknown command '${command}'\n`);
  cmdHelp();
  process.exit(1);
}
await handler();

// ---------------------------------------------------------------------------

async function cmdScan() {
  const { snapshot, results, bytes, durationMs } = await runScan(SNAPSHOT_PATH, {
    only: opt('only'), // e.g. --only=memory, for iterating on one collector
    refreshHardware: flag('refresh-hardware'),
  });

  const failed = results.filter((r) => !r.ok);

  console.log(
    `scanned in ${durationMs}ms · ${results.length} collectors` +
      (failed.length ? ` · ${failed.length} failed` : '') +
      ` · ${(bytes / 1024).toFixed(1)} KB → ${path.relative(process.cwd(), SNAPSHOT_PATH)}`,
  );
  for (const r of results) {
    console.log(
      `  ${r.ok ? '·' : '!'} ${r.name.padEnd(12)} ${String(r.ms).padStart(6)}ms` +
        (r.error ? `  ${r.error}` : ''),
    );
  }
  void snapshot;
}

async function cmdShow() {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  } catch {
    console.error(`no snapshot yet — run: node deckhand.mjs scan`);
    process.exit(1);
  }

  if (flag('json')) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  console.log(`snapshot ${ago(snapshot.capturedAt)} · scanned in ${snapshot.durationMs}ms\n`);

  const hw = snapshot.hardware;
  if (hw?.machine) {
    const mc = hw.machine;
    console.log(
      `machine  ${mc.name} · ${mc.chip} · ${mc.cores} cores (${mc.performanceCores}P/${mc.efficiencyCores}E)` +
        `${hw.gpu?.cores ? ` · ${hw.gpu.cores}-core GPU` : ''} · ${mc.memory} · macOS ${mc.osBuild}`,
    );
  }

  const m = snapshot.memory;
  if (m) {
    const h = m.headroom;
    console.log(
      `\nmemory   ${h.availableGiB} GiB free of ${m.totalGiB} GiB (unified) · pressure ${h.pressureState}`,
    );
    if (h.pinnedByOllamaGiB > 0) {
      console.log(
        `         ${h.pinnedByOllamaGiB} GiB pinned by ollama on purpose · ${h.availableIfUnpinnedGiB} GiB free if released`,
      );
    } else if (m.ollama?.reachable) {
      // Absence of a loaded model is itself the answer to "what happened to my
      // RAM" — say so rather than printing nothing.
      console.log(
        `         ollama up, no model resident (keep_alive ${m.ollama.keepAlive ?? 'default'} → ${m.ollama.keepAlivePolicy})`,
      );
    }
    if (m.swap?.usedBytes) console.log(`         swap in use: ${gib(m.swap.usedBytes)} GiB`);
    const hogs = m.topProcesses?.processes?.slice(0, 3) ?? [];
    if (hogs.length) {
      console.log(`         top RSS: ${hogs.map((p) => `${short(p.command)} ${gib(p.rssBytes)}G`).join(' · ')}`);
    }
  }

  const p = snapshot.processes;
  if (p?.load?.ok) {
    console.log(
      `\ncpu      load ${p.load.one} / ${p.load.five} / ${p.load.fifteen} on ${p.load.cores} cores` +
        ` · ${p.load.perCore} per core · ${p.load.trend}`,
    );
    const busy = p.processes?.topByCpu?.slice(0, 3) ?? [];
    if (busy.length) {
      // Flagged, not hidden: ps reports a lifetime average, so this answers
      // "what has been busy", not "what is busy this second".
      console.log(`         busiest (lifetime avg): ${busy.map((x) => `${short(x.command)} ${x.cpuPercent}%`).join(' · ')}`);
    }
    if (p.pm2?.installed) {
      console.log(
        `         pm2: ${p.pm2.count} process${p.pm2.count === 1 ? '' : 'es'} — ${p.pm2.processes.map((x) => `${x.name}(${x.status})`).join(' ')}`,
      );
    }
    if (p.launchd?.ok) {
      console.log(`         launchd: ${p.launchd.running} running of ${p.launchd.total} · ${p.launchd.failingCount} nonzero status`);
    }
  }

  const n = snapshot.network;
  if (n?.listeners) {
    console.log(`\nports    ${n.summary.total} listening · ${n.summary.identified} identified`);
    const named = n.listeners.filter((l) => l.known);
    if (named.length) {
      console.log(`         ${named.map((l) => `${l.port} ${l.known}`).join(' · ')}`);
    }
    if (n.summary.knownButNotListening?.length) {
      console.log(`         not running: ${n.summary.knownButNotListening.map((k) => `${k.port} ${k.name}`).join(' · ')}`);
    }
    if (n.tailscale?.installed) {
      console.log(
        `         tailscale ${n.tailscale.backendState}` +
          `${n.tailscale.self?.tailscaleIPs?.length ? ` · ${n.tailscale.self.tailscaleIPs[0]}` : ''}` +
          ` · ${n.tailscale.peers?.length ?? 0} peers`,
      );
    }
  }

  const d = snapshot.disk;
  if (d?.headline) {
    const h = d.headline;
    console.log(
      `\ndisk     ${gib(h.usedBytes)} GiB used of ${gib(h.totalBytes)} GiB · ${h.capacityPercent}% full · ${gib(h.availableBytes)} GiB free`,
    );
    const top = d.topDirs.filter((t) => t.totalBytes).slice(0, 4);
    if (top.length) {
      console.log(`         biggest: ${top.map((t) => `${t.label} ${gib(t.totalBytes)}G`).join(' · ')}`);
    }
    const c = d.cleanupCandidates;
    console.log(
      `         ${gib(c.regenerableBytes)} GiB regenerable (node_modules etc) · ${gib(c.staleFilesBytes)} GiB in ${c.staleFiles.length} stale archives`,
    );
  }

  const inst = snapshot.installed;
  if (inst) {
    console.log(
      `\ninstalled ${inst.apps.count} apps · ${inst.homebrew.formulae?.count ?? 0} formulae` +
        ` (${inst.homebrew.outdated?.count ?? 0} outdated) · ${inst.npmGlobal.count} npm globals` +
        ` · ${inst.ollamaModels.count} ollama models ${gib(inst.ollamaModels.totalBytes)}G`,
    );
    // Only the confident ones: the rest fall back to bundle mtime, which
    // answers "not updated in a year", a different question entirely.
    const sure = inst.staleApps.filter((a) => a.confident);
    if (sure.length) {
      console.log(
        `          unopened >1y (confident): ${sure.slice(0, 5).map((a) => `${a.name} ${a.daysSinceUsed}d`).join(' · ')}`,
      );
    }
    console.log(
      `          ${inst.staleApps.length - sure.length} more look stale by file date only — not proof they went unopened`,
    );
  }

  const a = snapshot.autostart;
  if (a?.plists) {
    console.log(
      `\nautostart ${a.plists.count} plists · ${a.orphaned.length} orphaned · ${a.failing.length} nonzero exit` +
        ` · ${a.unobservable.count} unobservable without sudo`,
    );
    if (a.loginItems?.ok) {
      console.log(`          login items: ${a.loginItems.items.map((i) => i.name).join(' · ') || 'none'}`);
    }
    const broken = a.failing.filter((f) => f.likelyBroken);
    if (broken.length) {
      console.log(`          likely broken: ${broken.map((f) => f.label).join(' · ')}`);
    }
    if (a.stalePlists.length) {
      console.log(`          inert files: ${a.stalePlists.map((s) => s.file).join(' · ')}`);
    }
  }

  const failedCollectors = Object.entries(snapshot.collectors ?? {}).filter(([, v]) => !v.ok);
  if (failedCollectors.length) {
    console.log(`\n! failed: ${failedCollectors.map(([k, v]) => `${k} (${v.error})`).join(' · ')}`);
  }
}

// Short, stable process labels — full argv lines are unreadable in a summary.
function short(command) {
  return path.basename((command ?? '').split(' ')[0] || command || '?').slice(0, 22);
}

function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// ---------------------------------------------------------------------------
// Phase 2 — the LLM reads the same snapshot everything else reads
// ---------------------------------------------------------------------------

async function cmdAsk() {
  const question = process.argv.slice(3).filter((a) => !a.startsWith('--')).join(' ');
  if (!question) {
    console.error('usage: node deckhand.mjs ask "what\'s eating my disk?"');
    process.exit(1);
  }

  const snapshot = await loadSnapshot();
  const { askAboutMac } = await import('./src/ask.mjs');
  const res = await askAboutMac(snapshot, question, { provider: opt('provider') });

  render(res, snapshot);
}

async function cmdFact() {
  const snapshot = await loadSnapshot();
  const { factAboutMac } = await import('./src/ask.mjs');
  const res = await factAboutMac(snapshot, { provider: opt('provider') });

  render(res, snapshot);
}

async function cmdServe() {
  const { serve } = await import('./src/server.mjs');
  serve(SNAPSHOT_PATH);
}

async function cmdProviders() {
  const { providerStatus } = await import('./src/llm.mjs');
  const status = await providerStatus();
  for (const [name, s] of Object.entries(status)) {
    const rank = s.rank ? `#${s.rank}` : ' -';
    console.log(
      `${s.ok ? '·' : '!'} ${rank} ${name.padEnd(8)} ${s.ok ? 'ready' : s.why}` +
        (s.billed ? '   ← billed, not free' : ''),
    );
    if (s.ok && name === 'ollama') console.log(`        ${s.model} @ ${s.host}`);
    if (s.ok && name === 'claude') console.log(`        ${s.model} via CLI`);
  }
  console.log('\nfailover order only — one model answers, the rest are for when it is down.');
  console.log('override with DECKHAND_PROVIDER=claude or --provider=claude');
}

function render(res, snapshot) {
  if (!res.ok) {
    console.error(`no provider could answer: ${res.error}`);
    process.exit(1);
  }

  console.log(`\n${res.text}\n`);

  if (flag('quiet')) return;

  // Always show the receipts: which provider answered, how much of the
  // snapshot it actually saw, and how stale that snapshot is. An answer about
  // a machine is only as good as when it was last looked at.
  const d = res.digest;
  console.log(
    `— ${res.provider}/${res.model} · ${(res.ms / 1000).toFixed(1)}s · ` +
      `${d.approxTokens} tok [${d.sections.join(', ') || 'core only'}] · snapshot ${ago(snapshot.capturedAt)}` +
      (res.costUsd ? ` · $${res.costUsd.toFixed(4)}` : ''),
  );
  if (d.dropped.length) console.log(`  (dropped for space: ${d.dropped.join(', ')})`);

  // Loud on purpose. A number the model made up is the one failure mode that
  // looks exactly like a good answer.
  if (res.check?.unsupported?.length) {
    console.log(
      `  ⚠ ${res.check.unsupported.length} figure(s) not found in or derivable from the facts: ${res.check.unsupported.join(', ')}`,
    );
  }
  if (res.check?.badComparisons?.length) {
    console.log(`  ⚠ false comparison: ${res.check.badComparisons.join('; ')}`);
  }
}

async function loadSnapshot() {
  try {
    return JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
  } catch {
    console.error('no snapshot yet — run: node deckhand.mjs scan');
    process.exit(1);
  }
}

function cmdHelp() {
  console.log(`deckhand — knows every inch of this Mac. Read-only.

  node deckhand.mjs scan                  snapshot the machine → data/snapshot.json
  node deckhand.mjs scan --only=X         run one collector while iterating
                                          (hardware memory processes network
                                           installed autostart disk)
  node deckhand.mjs scan --refresh-hardware   re-probe the cached specs
  node deckhand.mjs show                  human summary of the last snapshot
  node deckhand.mjs show --json           the raw snapshot

  node deckhand.mjs ask "..."             ask the Mac about itself
  node deckhand.mjs fact                  one non-obvious observation
  node deckhand.mjs serve                 web UI on :7789
  node deckhand.mjs providers             which LLM would answer, and why
      --provider=ollama|gemini|claude     force one for this call
      --quiet                             answer only, no provenance line

env: DECKHAND_SNAPSHOT        override the snapshot path
     DECKHAND_HARDWARE_CACHE  override the cached-specs path
     OLLAMA_HOST              default http://127.0.0.1:11434
     DECKHAND_MODEL           default qwen2.5-coder:14b
     DECKHAND_PROVIDER        order, e.g. "claude" or "ollama,claude"
     DECKHAND_CLAUDE_MODEL    default haiku (sonnet also works)
     DECKHAND_GEMINI_KEY      gemini free tier
     DECKHAND_FULL_SNAPSHOT=1 send the raw snapshot to billed providers too
     DECKHAND_PORT            web UI port, default 7789
     DECKHAND_HOST            bind address, default 0.0.0.0`);
}

function gib(bytes) {
  return (bytes / 1024 ** 3).toFixed(2);
}

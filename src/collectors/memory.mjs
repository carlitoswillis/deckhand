// Memory (RAM) collector — unified-memory aware.
//
// The whole point of this collector is that "free RAM" is a misleading number
// on this machine, for two reasons, and deckhand must not repeat the mistake:
//
//   1. The 32 GB is *unified* — the GPU allocates from the same pool. A model
//      resident on the GPU is not "free memory that happens to be busy", it is
//      gone until something unloads it.
//   2. Ollama runs under a dedicated LaunchAgent with OLLAMA_KEEP_ALIVE=-1
//      (../multimodel/PLAN.md), which pins a model in VRAM *forever* — that's
//      deliberate, it's what kills the 21 s warmup. So the pinned bytes are not
//      a leak and not a problem to report; they're a standing reservation.
//      Deckhand reports headroom net of it, names it as intentional, and only
//      surfaces it as the unpin candidate when memory actually gets tight.
//
// Verified live 2026-08-14: memory_pressure/vm_stat/sysctl all return in <5 ms
// and need no sudo. Ollama's HTTP API is used instead of `ollama ps` because
// the CLI's columns ("11 GB", "100% GPU") don't split on whitespace cleanly.

import { run } from '../run.mjs';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const OLLAMA_PROBE_TIMEOUT_MS = 1_500;

export async function collectMemory() {
  const [pressure, vmstat, sysctl, hogs, ollama] = await Promise.all([
    memoryPressure(),
    vmStat(),
    sysctlMemory(),
    topProcesses(),
    ollamaResident(),
  ]);

  const totalBytes = sysctl.totalBytes;
  const pinnedBytes = ollama.pinnedBytes;

  return {
    totalBytes,
    totalGiB: round2(totalBytes / 1024 ** 3),
    unified: true, // Apple silicon: CPU and GPU share this pool.
    pressure,
    vmstat,
    swap: sysctl.swap,
    topProcesses: hogs,
    ollama,

    // The headline deckhand should actually answer questions with.
    headroom: headroom({ totalBytes, pinnedBytes, pressure, vmstat }),
  };
}

// ---------------------------------------------------------------------------
// Headroom
// ---------------------------------------------------------------------------

// "Can I afford to load the 14B and run a DAW at once?" is the question this
// exists to answer, so it reports two numbers: what's free right now, and what
// would be free if the deliberate Ollama pin were released.
function headroom({ totalBytes, pinnedBytes, pressure, vmstat }) {
  const availableBytes = vmstat.ok ? vmstat.availableBytes : null;

  return {
    availableBytes,
    availableGiB: availableBytes == null ? null : round2(availableBytes / 1024 ** 3),
    freePercent: pressure.freePercent,
    pressureState: pressure.state,

    pinnedByOllamaBytes: pinnedBytes,
    pinnedByOllamaGiB: round2(pinnedBytes / 1024 ** 3),
    // What you'd get back by unpinning — NOT a recommendation to do it.
    availableIfUnpinnedBytes: availableBytes == null ? null : availableBytes + pinnedBytes,
    availableIfUnpinnedGiB:
      availableBytes == null ? null : round2((availableBytes + pinnedBytes) / 1024 ** 3),

    // Read-only guardrail: this is the *explanation*, and the command is
    // printed for you to run, never run on your behalf (PLAN.md).
    unpinCandidate:
      pinnedBytes > 0
        ? {
            why: 'OLLAMA_KEEP_ALIVE=-1 pins the loaded model in unified memory on purpose (kills the 21 s warmup).',
            tighteningsFirst:
              'Prefer a finite keep_alive (e.g. 2h) over unloading — it keeps sessions warm and releases memory overnight.',
            command: 'launchctl unload ~/Library/LaunchAgents/com.local.ollama.plist',
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function memoryPressure() {
  const res = await run('/usr/bin/memory_pressure', [], { timeoutMs: 5_000 });
  if (!res.ok) return { ok: false, error: res.error, freePercent: null, state: null };

  // The only line worth having is the last one; the page counts above it
  // duplicate vm_stat, which we parse properly anyway.
  const free = /System-wide memory free percentage:\s*(\d+)%/.exec(res.stdout);
  const state = /System-wide memory pressure:\s*(\w+)/.exec(res.stdout);

  return {
    ok: true,
    error: null,
    freePercent: free ? Number(free[1]) : null,
    // memory_pressure only prints an explicit state when it isn't normal, so
    // absence means normal rather than unknown.
    state: state ? state[1].toLowerCase() : free ? 'normal' : null,
  };
}

async function vmStat() {
  const res = await run('/usr/bin/vm_stat', [], { timeoutMs: 5_000 });
  if (!res.ok) return { ok: false, error: res.error, availableBytes: null };

  // Page size is 16384 here, not the 4096 every StackOverflow snippet assumes —
  // hardcoding 4096 would under-report memory by 4x. Read it from the header.
  const pageSize = Number(/page size of (\d+) bytes/.exec(res.stdout)?.[1] ?? 16384);
  const pages = {};
  for (const line of res.stdout.split('\n')) {
    const m = /^"?([^":]+)"?:\s+(\d+)\.?$/.exec(line.trim());
    if (m) pages[m[1].trim()] = Number(m[2]);
  }

  const bytes = (key) => (pages[key] ?? 0) * pageSize;
  const free = bytes('Pages free');
  const inactive = bytes('Pages inactive');
  const speculative = bytes('Pages speculative');
  const purgeable = bytes('Pages purgeable');

  return {
    ok: true,
    error: null,
    pageSize,
    freeBytes: free,
    activeBytes: bytes('Pages active'),
    inactiveBytes: inactive,
    wiredBytes: bytes('Pages wired down'),
    speculativeBytes: speculative,
    purgeableBytes: purgeable,
    compressedBytes: bytes('Pages occupied by compressor'),
    // "Available" the way Activity Monitor means it: what a new process could
    // get without swapping — free plus the pages the kernel would evict first.
    availableBytes: free + inactive + speculative + purgeable,
    // Cumulative since boot. Non-zero swapouts with zero current swap usage
    // means it happened earlier, which is a different story than swapping now.
    swapinsSinceBoot: pages['Swapins'] ?? null,
    swapoutsSinceBoot: pages['Swapouts'] ?? null,
  };
}

async function sysctlMemory() {
  const res = await run('/usr/sbin/sysctl', ['-n', 'hw.memsize', 'vm.swapusage'], {
    timeoutMs: 5_000,
  });
  if (!res.ok) {
    return { totalBytes: 0, swap: { ok: false, error: res.error } };
  }

  const [memsize, swapline = ''] = res.stdout.trim().split('\n');
  const mb = (label) => {
    const m = new RegExp(`${label}\\s*=\\s*([\\d.]+)M`).exec(swapline);
    return m ? Math.round(Number(m[1]) * 1024 * 1024) : null;
  };

  return {
    totalBytes: Number(memsize) || 0,
    swap: {
      ok: true,
      error: null,
      totalBytes: mb('total'),
      usedBytes: mb('used'),
      freeBytes: mb('free'),
      encrypted: /\(encrypted\)/.test(swapline),
    },
  };
}

// `ps` rather than `top -l 1`: top's per-process block needs a second sample to
// mean anything for CPU, and we only want resident size here.
async function topProcesses(limit = 15) {
  const res = await run('/bin/ps', ['axo', 'rss=,pid=,%cpu=,comm='], { timeoutMs: 8_000 });
  if (!res.ok) return { ok: false, error: res.error, processes: [] };

  const processes = res.stdout
    .split('\n')
    .map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line);
      if (!m) return null;
      return {
        rssBytes: Number(m[1]) * 1024, // ps reports KiB
        pid: Number(m[2]),
        cpuPercent: Number(m[3]),
        command: m[4].trim(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.rssBytes - a.rssBytes)
    .slice(0, limit);

  return { ok: true, error: null, processes };
}

// ---------------------------------------------------------------------------
// Ollama — the deliberate reservation
// ---------------------------------------------------------------------------

async function ollamaResident() {
  const loaded = await ollamaApi('/api/ps');
  const env = await ollamaServerEnv();

  if (!loaded.ok) {
    return {
      ok: false,
      error: loaded.error,
      reachable: false,
      loadedModels: [],
      pinnedBytes: 0,
      env,
    };
  }

  const models = (loaded.json?.models ?? []).map((m) => {
    // keep_alive=-1 shows up as an absurd expiry (year 2318), which is the
    // cleanest machine-readable signal that the pin is on. Anything more than
    // a year out is a pin, not a session.
    const expiresAt = m.expires_at ? new Date(m.expires_at) : null;
    const pinned =
      expiresAt != null && expiresAt.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000;

    return {
      name: m.name,
      sizeBytes: m.size ?? 0,
      vramBytes: m.size_vram ?? 0,
      contextLength: m.context_length ?? null,
      quantization: m.details?.quantization_level ?? null,
      parameterSize: m.details?.parameter_size ?? null,
      expiresAt: m.expires_at ?? null,
      pinned,
    };
  });

  return {
    ok: true,
    error: null,
    reachable: true,
    loadedModels: models,
    // On unified memory, VRAM *is* RAM — these bytes are unavailable to apps.
    pinnedBytes: models.filter((m) => m.pinned).reduce((sum, m) => sum + (m.vramBytes || m.sizeBytes), 0),
    residentBytes: models.reduce((sum, m) => sum + (m.vramBytes || m.sizeBytes), 0),
    keepAlive: env.OLLAMA_KEEP_ALIVE ?? null,
    // Not a boolean: every one of these is deliberate config, they just differ
    // in how long memory stays claimed. Verified 2026-08-14 this flipped from
    // '-1' to '2h' mid-session and the model unloaded — which is precisely the
    // tradeoff multimodel/PLAN.md left open ("a finite value would keep
    // sessions warm while releasing memory overnight"). Reading it live is the
    // only reason deckhand noticed.
    keepAlivePolicy: keepAlivePolicy(env.OLLAMA_KEEP_ALIVE),
    env,
  };
}

function keepAlivePolicy(keepAlive) {
  if (keepAlive == null) return 'default'; // ollama's own 5-minute default
  if (keepAlive === '-1') return 'permanent'; // pinned forever, memory never returns
  if (keepAlive === '0') return 'immediate'; // unload as soon as the call ends
  return 'timed'; // e.g. '2h' — warm for a while, then released
}

async function ollamaApi(path) {
  // fetch is built in on Node 22 — no dependency, and it keeps the zero-deps
  // rule intact.
  try {
    const res = await fetch(`${OLLAMA_HOST}${path}`, {
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, json: null };
    return { ok: true, error: null, json: await res.json() };
  } catch (err) {
    // Ollama being down is a fact about the machine, not an error in deckhand.
    return { ok: false, error: err?.message ?? String(err), json: null };
  }
}

// The tuning lives in env vars on the running server, so read them off the
// process rather than the plist — the plist is what was *intended*, `ps eww` is
// what's actually in effect. (multimodel/PLAN.md hit exactly this: brew's
// formula silently reverted custom vars.)
async function ollamaServerEnv() {
  const pgrep = await run('/usr/bin/pgrep', ['-f', 'ollama serve'], { timeoutMs: 5_000 });
  const pid = pgrep.stdout.trim().split('\n')[0];
  if (!pgrep.ok || !pid) return {};

  const res = await run('/bin/ps', ['eww', '-o', 'command=', pid], { timeoutMs: 5_000 });
  if (!res.ok) return {};

  const env = {};
  for (const token of res.stdout.split(/\s+/)) {
    const m = /^(OLLAMA_[A-Z_]+)=(.*)$/.exec(token);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

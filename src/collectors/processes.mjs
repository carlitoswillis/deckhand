// Processes collector — what is actually running right now, and who started it.
//
// Four sources, because on this Mac "running" means four different things and
// no single tool sees all of them:
//
//   ps          every process the kernel knows about (712 of them today)
//   sysctl      load average — the only honest "how busy is it" number here
//   pm2         the long-living apps you deliberately run (PLAN.md)
//   launchctl   the OS's own autostart surface, including things that failed
//
// Verified live 2026-08-14 on Darwin 23.3.0: `ps aux` 0.06 s / 708 lines,
// `sysctl -n vm.loadavg` 0.001 s, `pm2 jlist` 0.14 s / 5 processes,
// `launchctl list` 0.01 s / 481 lines. All four need no sudo, and none of them
// mutates anything — deckhand is read-only by contract (PLAN.md ground rules).
//
// Deliberately NOT using `top`. PLAN.md lists `top -l 1`, but that was written
// before measuring it: with a single sample top's "CPU usage" header is the
// average *since boot*, not the current load, so it reads calm on a machine
// that is pegged right now and vice versa. Getting a real delta needs
// `top -l 2 -n 0`, which costs ~2 s of pure sleep — more than the entire rest
// of the snapshot. `sysctl -n vm.loadavg` is 1 ms and is a true recent
// average, so it replaces top outright.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

import { run } from '../run.mjs';

const TOP_CPU_LIMIT = 20;

// Chrome/Electron helpers carry ~2 KB argv apiece. The snapshot is meant to be
// injected wholesale into a prompt (PLAN.md), so commands are capped — the
// executable and its first few flags are what identifies a process anyway.
const COMMAND_MAX_CHARS = 500;

export async function collectProcesses() {
  const [load, processes, pm2, launchd] = await Promise.all([
    loadAverage(),
    processTable(),
    pm2List(),
    launchdList(),
  ]);

  return { load, processes, pm2, launchd };
}

// ---------------------------------------------------------------------------
// Load average
// ---------------------------------------------------------------------------

// hw.ncpu comes along in the same call (still ~1 ms) because a raw load of 6.5
// means nothing without the core count — on this 20-core machine that's a third
// of capacity, on a 4-core laptop it would be a fire.
async function loadAverage() {
  const res = await run('/usr/sbin/sysctl', ['-n', 'vm.loadavg', 'hw.ncpu'], { timeoutMs: 5_000 });
  if (!res.ok) return { ok: false, error: res.error, one: null, five: null, fifteen: null };

  const [loadLine = '', ncpuLine = ''] = res.stdout.trim().split('\n');
  // sysctl formats it as `{ 6.51 6.68 6.88 }` — braces and all.
  const nums = loadLine.match(/[\d.]+/g)?.map(Number) ?? [];
  const cores = Number(ncpuLine.trim()) || null;

  const [one = null, five = null, fifteen = null] = nums;

  return {
    ok: nums.length === 3,
    error: nums.length === 3 ? null : `unparseable vm.loadavg: ${loadLine.trim()}`,
    one,
    five,
    fifteen,
    cores,
    // The number to actually reason with: 1.0 means "every core busy".
    perCore: one != null && cores ? round2(one / cores) : null,
    trend: trend(one, fifteen),
  };
}

// A single load figure can't say whether the machine is winding up or down;
// comparing the 1-minute against the 15-minute can.
function trend(one, fifteen) {
  if (one == null || fifteen == null || fifteen === 0) return null;
  const ratio = one / fifteen;
  if (ratio > 1.25) return 'rising';
  if (ratio < 0.8) return 'falling';
  return 'steady';
}

// ---------------------------------------------------------------------------
// ps
// ---------------------------------------------------------------------------

// `ps axo` with explicit columns rather than `ps aux`: aux's header is
// positional and its COMMAND column swallows the ones before it whenever a user
// name or a %CPU runs wide, so parsing it is guesswork. With `axo ...=` there
// is no header at all and the column order is ours.
async function processTable() {
  const res = await run('/bin/ps', ['axo', 'pid=,ppid=,user=,%cpu=,%mem=,rss=,etime=,command='], {
    timeoutMs: 8_000,
  });
  if (!res.ok) return { ok: false, error: res.error, total: 0, topByCpu: [] };

  const all = [];
  for (const line of res.stdout.split('\n')) {
    // Everything up to etime is whitespace-free; command is the rest, spaces
    // and all, so it must be the only greedy group.
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[8].trim();
    all.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      user: m[3],
      cpuPercent: Number(m[4]),
      memPercent: Number(m[5]),
      rssBytes: Number(m[6]) * 1024, // ps reports RSS in KiB
      elapsed: m[7], // as ps prints it: [[DD-]HH:]MM:SS
      elapsedSeconds: elapsedSeconds(m[7]),
      command:
        command.length > COMMAND_MAX_CHARS ? `${command.slice(0, COMMAND_MAX_CHARS)}…` : command,
    });
  }

  const byCpu = [...all].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, TOP_CPU_LIMIT);

  return {
    ok: true,
    error: null,
    total: all.length,
    // %CPU from ps is a per-process average over that process's *lifetime*, not
    // an instantaneous sample. For "what's eating my CPU" that's usually the
    // right question anyway (a 4-hour runaway shows up; a 200 ms spike doesn't),
    // but the distinction matters and callers shouldn't have to guess.
    cpuPercentIsLifetimeAverage: true,
    byUser: countBy(all, (p) => p.user),
    topByCpu: byCpu,
  };
}

// ps prints elapsed time as MM:SS, HH:MM:SS or DD-HH:MM:SS depending on age —
// launchd today reads `12-04:28:35`. Normalising to seconds is what lets the
// snapshot answer "what started recently?" without string surgery downstream.
function elapsedSeconds(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
}

// ---------------------------------------------------------------------------
// pm2
// ---------------------------------------------------------------------------

// pm2 lives in ~/.local/bin here, which is on the login-shell PATH but not on
// the one run.mjs patches in (/opt/homebrew/bin:/usr/local/bin). Under launchd
// or pm2 itself — exactly how deckhand will eventually run (PLAN.md: long-living
// pm2 app on :7799) — a bare `pm2` would resolve to nothing, so the known
// install locations are tried first and the bare name is only the fallback.
const PM2_CANDIDATES = [
  `${homedir()}/.local/bin/pm2`,
  '/opt/homebrew/bin/pm2',
  '/usr/local/bin/pm2',
].filter((p) => existsSync(p));

async function pm2List() {
  const res = await run(PM2_CANDIDATES[0] ?? 'pm2', ['jlist'], { timeoutMs: 8_000 });
  if (!res.ok) {
    return { ok: false, error: res.error, installed: res.error !== 'not installed (command not found)', count: 0, processes: [] };
  }

  // Not runJson(): pm2 prints a "Spawning PM2 daemon" banner on stdout ahead of
  // the JSON when the daemon happens to be cold, which would make a strict
  // JSON.parse fail on a perfectly good listing. Slicing to the outer array is
  // tolerant of the banner and still fails loudly on genuine garbage.
  const start = res.stdout.indexOf('[');
  const end = res.stdout.lastIndexOf(']');
  let list;
  try {
    list = JSON.parse(res.stdout.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `unparseable pm2 jlist: ${err.message}`, installed: true, count: 0, processes: [] };
  }

  return {
    ok: true,
    error: null,
    installed: true,
    count: list.length,
    processes: list.map(pm2Process),
  };
}

// Strict whitelist, and it is a privacy control, not tidiness. Every entry's
// `pm2_env` embeds the entire environment pm2 inherited when the app was
// started — ~50-90 vars on this machine, including API keys and session tokens.
// Verified 2026-08-14: 5 processes serialise to 29.5 KB raw, almost all of it
// that env blob. The snapshot gets injected wholesale into an LLM prompt
// (PLAN.md), so the env must never reach it. Copy fields by name; never spread.
function pm2Process(p) {
  const env = p.pm2_env ?? {};
  // cpu/memory live under `monit`, NOT at the top level — the top-level object
  // has no such fields and reading p.memory silently yields undefined.
  const monit = p.monit ?? {};
  const uptimeMs = typeof env.pm_uptime === 'number' ? Date.now() - env.pm_uptime : null;

  return {
    name: p.name ?? null,
    pmId: p.pm_id ?? null,
    pid: p.pid ?? null,
    status: env.status ?? null,
    cpuPercent: monit.cpu ?? null,
    memoryBytes: monit.memory ?? null,
    execPath: env.pm_exec_path ?? null,
    cwd: env.pm_cwd ?? null,
    execMode: env.exec_mode ?? null,
    restarts: env.restart_time ?? null,
    // pm_uptime is a ms epoch of the last (re)start, not a duration.
    startedAt: typeof env.pm_uptime === 'number' ? new Date(env.pm_uptime).toISOString() : null,
    uptimeSeconds: uptimeMs == null ? null : Math.round(uptimeMs / 1000),
    outLogPath: env.pm_out_log_path ?? null,
    // pm2 has no port field at all — an app's port is only ever in its own
    // config or argv. The way to answer "what's listening on 4400?" is to
    // correlate this pid against the network collector's lsof listeners, which
    // do carry pids. Same join key both sides: `pid`.
    port: null,
  };
}

// ---------------------------------------------------------------------------
// launchctl
// ---------------------------------------------------------------------------

// `launchctl list` is TSV — `PID\tStatus\tLabel` — with a header row, 481 lines
// today. Note this is the modern-ish legacy subcommand and it is read-only;
// deckhand never calls load/unload/bootout (PLAN.md: suggestions are printed,
// never run).
async function launchdList() {
  const res = await run('/bin/launchctl', ['list'], { timeoutMs: 8_000 });
  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
      total: 0,
      running: 0,
      appleCount: 0,
      failingCount: 0,
      failing: [],
      thirdParty: [],
    };
  }

  const services = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [pidField, statusField, label] = line.split('\t');
    if (pidField === 'PID' || !label) continue; // header row
    services.push({
      // A '-' pid means loaded but not currently running — that's the normal
      // state for on-demand agents, not a fault.
      pid: pidField === '-' ? null : Number(pidField),
      status: statusField === '-' ? null : Number(statusField),
      label,
    });
  }

  // Nonzero status is the interesting bucket: the last run didn't end cleanly.
  // Measured 2026-08-14: 19 of 487, and the statuses were mostly negative
  // (-9 ×12, -11 ×2, -6, -15) — launchd reports a *negated signal number* when
  // the job was killed rather than an exit code, so a bare `status: -9` looks
  // alarming while only meaning "SIGKILLed", which is routine for on-demand
  // agents the system reaps. Decoding it is what stops the LLM in Phase 2 from
  // reading a tidy shutdown as a crash.
  const failing = services
    .filter((s) => s.status !== 0 && s.status != null)
    .map((s) => ({ ...s, reason: failureReason(s.status) }));

  // The full 487-label inventory is ~31 KB of almost entirely com.apple.*
  // plumbing — too much to carry in a prompt for what it says. The non-Apple
  // labels are the ones that are actually about *this* machine's setup (31 of
  // them today: ollama, tailscale, docker, plus your own agents), and
  // they're the autostart surface PLAN.md wants inventoried, so they're kept in
  // full while the Apple bulk stays as counts.
  // Per-GUI-app jobs are labelled `application.<bundle-id>.<numbers>`, so the
  // prefix has to come off before the com.apple. test or Mail and Safari get
  // filed as third-party software.
  const thirdParty = services.filter(
    (s) => !s.label.replace(/^application\./, '').startsWith('com.apple.'),
  );

  return {
    ok: true,
    error: null,
    total: services.length,
    running: services.filter((s) => s.pid != null).length,
    appleCount: services.length - thirdParty.length,
    failingCount: failing.length,
    failing,
    thirdParty,
  };
}

// launchd overloads one field: >0 is an exit status, <0 is -(signal number).
function failureReason(status) {
  if (status < 0) return `killed by ${signalName(-status)}`;
  // 128+N is the shell's convention for the same thing, and wrappers leak it
  // through — 143 is a plain SIGTERM, i.e. a normal stop, not a failure.
  if (status > 128 && status < 160) return `killed by ${signalName(status - 128)} (via shell)`;
  return `exited ${status}`;
}

function signalName(n) {
  return { 2: 'SIGINT', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM' }[n] ?? `signal ${n}`;
}

// ---------------------------------------------------------------------------

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  // Biggest first, so "who owns most of the 712 processes" reads off the top.
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

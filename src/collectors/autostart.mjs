// Autostart-surface collector — LaunchAgents, LaunchDaemons, login items, pm2.
//
// The question behind this collector is "what starts itself on this Mac, and is
// any of it dead weight?" (PLAN.md, `suggest` mode: orphaned LaunchAgents). So
// the interesting output is not the inventory, it's the cross-reference: a
// plist sitting on disk that launchd has never heard of is an orphan, and a
// plist launchd is running with a nonzero exit status is broken. Both are
// derived lists; both end as a printed command for you, never an action.
//
// Verified live 2026-08-14:
//   - readdir on all three plist directories succeeds with no permission
//     errors and no sudo: ~/Library/LaunchAgents (16), /Library/LaunchAgents
//     (11), /Library/LaunchDaemons (18).
//   - `launchctl list` is 0.01 s and emits `PID\tStatus\tLabel` with a header.
//   - ~/Library/LaunchAgents holds com.local.ollama.plist, which owns the
//     ollama server (../multimodel/PLAN.md — the OLLAMA_KEEP_ALIVE=-1 pin that
//     memory.mjs reports), alongside a backup named
//     homebrew.mxcl.ollama.plist.bak-20260813. launchd only ever loads *.plist,
//     so a .bak-* file is inert forever — a textbook cleanup candidate, and
//     exactly the kind of leftover `suggest` should surface.
//
// Login items are the expensive, dangerous part — see collectLoginItems().

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { run } from '../run.mjs';

// `observable` is the important flag here, and it cost a wrong answer to learn:
// `launchctl list` without sudo only sees the CALLING USER'S domain. Measured
// 2026-08-14: 0 of 18 /Library/LaunchDaemons labels appear in its output, while
// 4 of 11 /Library/LaunchAgents do. So for daemons, "absent from launchctl
// list" means "we can't see the system domain", NOT "not loaded" — reporting
// all 18 as orphans (which the first version of this file did) is pure noise.
// Deckhand doesn't sudo, so daemons get loaded:null and stay out of `orphaned`.
const PLIST_DIRS = [
  { dir: join(homedir(), 'Library/LaunchAgents'), scope: 'user-agent', observable: true },
  { dir: '/Library/LaunchAgents', scope: 'global-agent', observable: true },
  { dir: '/Library/LaunchDaemons', scope: 'global-daemon', observable: false },
];

// launchd loads `*.plist` and nothing else, so anything wearing one of these
// suffixes is a file that can never start — regardless of what's inside it.
const STALE_SUFFIXES = [/\.bak(-[\w.-]+)?$/i, /\.disabled$/i, /\.old$/i, /\.orig$/i, /\.save$/i, /~$/];

// pm2's `startup` command installs this; it's the hook that resurrects the
// saved process list at login. Named explicitly because pm2 owning a service is
// a deliberate house pattern (PLAN.md), not an orphan to clean up.
// `pm2 startup` names this file after the installing user (pm2.<user>.plist),
// so it must be discovered, not hardcoded — a literal filename would report the
// hook as missing on every machine but the one it was written on.
const PM2_PLIST_RE = /^pm2\..+\.plist$/;

// No options any more: login items used to be gated behind a flag because
// `sfltool dumpbtm` was slow and (as it turned out) prompted for a password.
// Reading the store directly is instant and silent, so it's simply always on.
export async function collectAutostart() {
  const [inventory, launchctl, loginItems, pm2] = await Promise.all([
    inventoryPlists(),
    launchctlList(),
    collectLoginItems(),
    pm2Hook(),
  ]);

  const items = crossReference(inventory.items, launchctl);

  return {
    plists: {
      ok: inventory.ok,
      error: inventory.error,
      dirs: inventory.dirs,
      count: items.length,
      items,
    },
    launchctl,

    // The three derived lists this collector exists to produce.
    //
    // `loaded === false` strictly, never `!loaded` — the null (unobservable)
    // daemons must not fall into this list, which is exactly the bug that made
    // the first version report 29 orphans instead of 11.
    orphaned: items
      .filter((i) => i.loadable && i.loaded === false)
      .map((i) => ({
        label: i.label,
        labelSource: i.labelSource,
        path: i.path,
        scope: i.scope,
        mtime: i.mtime,
      })),
    // Split by whether it's a crash or just a clean signal stop, so `suggest`
    // can lead with the ones that are genuinely broken.
    failing: items
      .filter((i) => i.loaded === true && i.exitStatus != null && i.exitStatus !== 0)
      .map((i) => ({
        label: i.label,
        path: i.path,
        scope: i.scope,
        pid: i.pid,
        exitStatus: i.exitStatus,
        ...i.exitReason,
        // The distinction that keeps this list honest.
        likelyBroken: i.exitReason?.kind === 'exit-code',
      })),
    // System daemons we are structurally unable to check without sudo. Named
    // so the gap is visible in the snapshot rather than silently absent.
    unobservable: {
      count: items.filter((i) => i.loaded === null).length,
      why: '`launchctl list` without sudo only reports the calling user\'s domain; 0 of 18 /Library/LaunchDaemons labels appear in it (verified 2026-08-14). Deckhand does not sudo, so their load state is unknown rather than "not loaded".',
    },
    stalePlists: items
      .filter((i) => i.stale)
      .map((i) => ({
        file: i.file,
        path: i.path,
        scope: i.scope,
        mtime: i.mtime,
        sizeBytes: i.sizeBytes,
        reason: i.staleReason,
      })),

    loginItems,
    pm2,
  };
}

// ---------------------------------------------------------------------------
// Plist inventory
// ---------------------------------------------------------------------------

async function inventoryPlists() {
  const scans = await Promise.all(PLIST_DIRS.map((d) => scanDir(d.dir, d.scope, d.observable)));

  return {
    ok: scans.some((s) => s.summary.ok),
    error: scans.every((s) => !s.summary.ok) ? (scans[0]?.summary.error ?? null) : null,
    dirs: scans.map((s) => s.summary),
    items: scans.flatMap((s) => s.items),
  };
}

async function scanDir(dir, scope, observable) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    return {
      summary: { dir, scope, observable, ok: false, error: err?.message ?? String(err), count: 0 },
      items: [],
    };
  }

  const items = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith('.') && !e.isDirectory())
      // Keep non-.plist files: the whole point is to catch the .bak-* leftovers
      // that a `*.plist` filter would hide.
      .filter((e) => e.name.includes('.plist'))
      .map((e) => describePlist(join(dir, e.name), dir, scope, observable)),
  );

  return {
    summary: {
      dir,
      scope,
      observable,
      ok: true,
      error: null,
      count: items.length,
      loadable: items.filter((i) => i.loadable).length,
    },
    items: items.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

async function describePlist(path, dir, scope, observable) {
  const file = basename(path);
  const staleReason = STALE_SUFFIXES.find((re) => re.test(file)) ? suffixOf(file) : null;

  const [info, label] = await Promise.all([statSafe(path), readLabel(path, file)]);

  return {
    file,
    dir,
    path,
    scope,
    observable,
    label: label.label,
    labelSource: label.source,
    loadable: file.endsWith('.plist'),
    stale: staleReason != null,
    staleReason,
    mtime: info.mtime,
    sizeBytes: info.sizeBytes,
  };
}

async function statSafe(path) {
  try {
    const info = await stat(path);
    return { mtime: info.mtime.toISOString(), sizeBytes: info.size };
  } catch {
    // A file that vanished between readdir and stat is not worth a failure.
    return { mtime: null, sizeBytes: null };
  }
}

// The filename is only *conventionally* the label, and assuming it produced a
// flatly wrong answer: pm2.<user>.plist declares Label `com.PM2`
// (verified 2026-08-14), so filename-matching reported the single most
// important service on this box as an orphan. Read the real Label key instead.
//
// `plutil -extract Label raw` handles binary and XML plists alike and costs
// ~4 ms; all 45 files run concurrently, well inside the 1 s budget. Some plists
// genuinely have no Label key (/Library/LaunchAgents/com.google.keystone.agent
// .plist is one) — those legitimately fall back to the filename, which is what
// launchd effectively does too.
async function readLabel(path, file) {
  const fallback = file.replace(/\.plist.*$/, '');
  const res = await run('/usr/bin/plutil', ['-extract', 'Label', 'raw', '-o', '-', path], {
    timeoutMs: 5_000,
  });

  const label = res.stdout.trim();
  if (!res.ok || !label || label.includes('\n')) {
    return { label: fallback, source: 'filename' };
  }
  return { label, source: 'plist-Label' };
}

function suffixOf(file) {
  const m = /\.plist(\..+)$/.exec(file);
  return m ? `non-loadable suffix "${m[1]}" — launchd only loads *.plist` : 'non-loadable filename';
}

// ---------------------------------------------------------------------------
// launchctl cross-reference
// ---------------------------------------------------------------------------

// `launchctl list` is TSV with a header row: PID, Status, Label. A '-' PID
// means loaded but not currently running (on-demand), which is normal and not a
// fault; the Status column is the last exit code, where nonzero is the real
// signal that something is crash-looping or misconfigured.
async function launchctlList() {
  const res = await run('/bin/launchctl', ['list'], { timeoutMs: 5_000 });
  if (!res.ok) return { ok: false, error: res.error, ms: res.ms, count: 0, byLabel: {} };

  const byLabel = {};
  const lines = res.stdout.split('\n').slice(1); // drop the header
  for (const line of lines) {
    if (!line.trim()) continue;
    const [pid, status, label] = line.split('\t');
    if (!label) continue;
    byLabel[label.trim()] = {
      pid: pid === '-' ? null : Number(pid),
      exitStatus: status === '-' ? null : Number(status),
    };
  }

  return {
    ok: true,
    error: null,
    ms: res.ms,
    count: Object.keys(byLabel).length,
    byLabel,
  };
}

function crossReference(items, launchctl) {
  return items.map((item) => {
    const entry = launchctl.byLabel?.[item.label] ?? null;
    // Tri-state on purpose. false = launchd knows this domain and has not
    // loaded this job (a real orphan). null = we are not allowed to look
    // (system daemons), so any claim either way would be invented.
    const loaded = entry != null ? true : item.observable ? false : null;

    return {
      ...item,
      loaded,
      pid: entry?.pid ?? null,
      running: entry?.pid != null,
      exitStatus: entry?.exitStatus ?? null,
      exitReason: describeExit(entry?.exitStatus ?? null),
    };
  });
}

// A nonzero status is not automatically a problem. 143 (128+SIGTERM) and -15
// both mean "stopped cleanly by a signal" — that's what pm2 restarting a
// service or `launchctl bootout` leaves behind, and both appear on this machine
// (two user agents at 143 and -15, verified 2026-08-14).
// Only a genuine nonzero *exit code* suggests something is actually broken.
function describeExit(status) {
  if (status == null || status === 0) return null;
  if (status < 0) return { kind: 'signal', signal: -status, note: `killed by signal ${-status}` };
  if (status > 128 && status < 160) {
    return { kind: 'signal', signal: status - 128, note: `exited on signal ${status - 128}` };
  }
  return { kind: 'exit-code', code: status, note: `exited ${status} — likely a real failure` };
}

// ---------------------------------------------------------------------------
// Login items (background task management)
// ---------------------------------------------------------------------------

// DO NOT reach for osascript here. `tell application "System Events"` raises a
// BLOCKING Automation consent modal — this shell has no Full Disk Access, so
// the scan would hang on a dialog nobody is there to click. Verified 2026-08-14.
//
// DO NOT reach for `sfltool dumpbtm` either. An earlier version of this file
// used it, on a scouting report that it needed "no sudo, no prompt, exit 0".
// That was wrong: it PROMPTS FOR AN ADMIN PASSWORD, and the exit 0 was observed
// only after someone typed one. Confirmed on this machine 2026-08-14 that every
// sfltool run asked him for a password.
//
// That rules it out on three counts, any one of which is fatal here:
//   - deckhand is a read-only observer and has no business asking for admin
//     rights to look at a list;
//   - Phase 3 runs scans on a schedule, and a blocking password dialog with
//     nobody at the keyboard is a hung scan, not a slow one;
//   - it cost 43.9 s cold besides.
//
// So: read the store directly. backgrounditems.btm is world-readable (verified
// 2026-08-14: 9,119 bytes, mode 644, no prompt). It's an NSKeyedArchiver blob
// that `plutil -convert json` refuses, but the app paths sit in plain ASCII
// inside the bookmark data, which is all we actually want.
//
// Two honest limitations, recorded in the payload rather than hidden:
//   - this is the LEGACY store. macOS 13+ keeps the authoritative list in
//     /private/var/db/com.apple.backgroundtaskmanagement, which needs Full Disk
//     Access (verified: "Operation not permitted"). So this can be stale.
//   - it yields no enabled/disabled state, only membership.
const BTM_PATH = join(
  homedir(),
  'Library/Application Support/com.apple.backgroundtaskmanagementagent/backgrounditems.btm',
);

async function collectLoginItems() {
  let buf;
  try {
    buf = await readFile(BTM_PATH);
  } catch (err) {
    return {
      ok: false,
      error: `${err.code ?? 'unreadable'}: ${BTM_PATH}`,
      source: 'backgrounditems.btm',
      count: 0,
      items: [],
    };
  }

  const items = parseBackgroundItems(buf);

  return {
    ok: true,
    error: null,
    source: 'backgrounditems.btm (legacy store, world-readable)',
    // Stated so nothing downstream reports "4 login items" as gospel.
    caveats: [
      'legacy store; the authoritative BTM database needs Full Disk Access',
      'membership only — no enabled/disabled state',
      'sfltool dumpbtm would give richer data but prompts for an admin password, so deckhand does not use it',
    ],
    mtime: (await stat(BTM_PATH)).mtime.toISOString(),
    count: items.length,
    items,
  };
}

// The bookmark blobs store paths lowercased, and each login item appears twice:
// once as the app itself ("/applications/docker.app") and once as the helper it
// actually registers, whose path fragment starts at
// "/library/loginitems/dockerhelper.app". The helper is the mechanism, not the
// item — nobody thinks of "DockerHelper" as a login item — so only top-level
// bundles count. Anchoring on /applications and /users/<name>/applications does
// that without needing to reason about the fragments.
//
// Original-case names ("Docker.app") also appear in the blob as separate
// strings, so case is recovered by lookup rather than guessed from the path.
function parseBackgroundItems(buf) {
  const text = buf.toString('latin1');

  const properCase = new Map();
  for (const m of text.matchAll(/([A-Za-z0-9 ._-]+)\.app/g)) {
    const name = m[1];
    // Only record tokens that carry real case information.
    if (name !== name.toLowerCase()) properCase.set(name.toLowerCase(), name);
  }

  const seen = new Map();
  for (const m of text.matchAll(/\/(?:applications|users\/[^/\0;]+\/applications)\/[^/\0;]+\.app/gi)) {
    const p = m[0];
    if (seen.has(p)) continue;
    const raw = basename(p).replace(/\.app$/i, '');
    seen.set(p, { path: p, name: properCase.get(raw.toLowerCase()) ?? raw });
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}


// ---------------------------------------------------------------------------
// pm2
// ---------------------------------------------------------------------------

// pm2 is the house pattern for anything long-living (PLAN.md), and deckhand
// itself is destined to run under it — so whether the resurrect hook is
// actually installed is a fact worth asserting rather than assuming. Verified
// present 2026-08-14.
async function pm2Hook() {
  const dir = join(homedir(), 'Library/LaunchAgents');

  let match;
  try {
    match = (await readdir(dir)).find((f) => PM2_PLIST_RE.test(f));
  } catch (err) {
    return {
      ok: false,
      installed: false,
      error: err?.message ?? String(err),
      role: 'pm2 resurrect hook — could not read ~/Library/LaunchAgents',
    };
  }

  // Absent is a legitimate state (pm2 startup never run), not an error.
  if (!match) {
    return {
      ok: true,
      installed: false,
      path: null,
      error: null,
      role: 'pm2 resurrect hook — not installed; `pm2 startup` has not been run',
    };
  }

  const path = join(dir, match);
  const info = await statSafe(path);

  return {
    ok: true,
    installed: true,
    path,
    label: basename(match, '.plist'),
    mtime: info.mtime,
    sizeBytes: info.sizeBytes,
    role: 'pm2 resurrect hook — replays the saved pm2 process list at login',
  };
}

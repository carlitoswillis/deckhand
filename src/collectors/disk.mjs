// Disk collector.
//
// Two traps define this file, both verified live 2026-08-14:
//
//   1. `df -h /` says 21% used. That is the SEALED SYSTEM SNAPSHOT, not your
//      disk. The volume that actually fills up is /System/Volumes/Data — 380 Gi
//      used, 53 Gi free, 88% full. Any collector that reads `df /` hands the
//      Phase-2 LLM a machine with tons of room and every disk answer it gives
//      will be wrong. The Data volume is the headline number, always.
//
//   2. `du` on the home directory takes 213 SECONDS, and 199 s of that is
//      ~/Library alone. The <30 s scan budget dies there. So: never walk
//      ~/Library, walk a whitelist of the dirs that actually grow, and run them
//      concurrently (wall clock ≈ the slowest one, ~6 s, not the sum).
//
// Big-file sweep uses BOTH mdfind and find on purpose. mdfind is ~900x faster
// (0.16 s vs 142 s) but Spotlight's index lags or excludes things — verified, it
// missed a 400 MB archive sitting in the workspace — exactly the kind of file
// the cleanup pass exists to find. So Spotlight covers the whole disk cheaply
// and a real `find` covers ~/workspace exactly (2 s); the two are merged.

import os from 'node:os';
import path from 'node:path';
import { run } from '../run.mjs';

const HOME = os.homedir();

// Whitelist, not a walk. ~/Library is deliberately absent (199 s). These are the
// dirs that actually grow on this machine; sizes as of 2026-08-14 in comments.
const WALKED_DIRS = [
  ['Downloads', path.join(HOME, 'Downloads')], // ~39 GB, 1.8 s
  ['workspace', path.join(HOME, 'workspace')], // ~28 GB, 5 s — slowest, sets the budget
  ['Documents', path.join(HOME, 'Documents')], // ~25 GB, 6 s
  ['Desktop', path.join(HOME, 'Desktop')], // ~1 GB, 0.15 s
  ['Music', path.join(HOME, 'Music')],
  ['Pictures', path.join(HOME, 'Pictures')],
  ['Movies', path.join(HOME, 'Movies')],
  ['.ollama', path.join(HOME, '.ollama')], // model blobs
];

// Directories that are large, regenerable, and worth totalling separately —
// the "you could reclaim this by deleting things you can rebuild" number.
const HEAVY_DIR_NAMES = ['node_modules', '.venv', 'venv', 'DerivedData', '.next', 'dist', 'build'];

const BIG_FILE_MIN_BYTES = 500 * 1024 * 1024; // mdfind sweep threshold, whole disk
const WORKSPACE_FILE_MIN = '100M'; // find sweep threshold, ~/workspace only

export async function collectDisk() {
  const [volumes, container, topDirs, heavy, bigFiles] = await Promise.all([
    dfVolumes(),
    apfsContainer(),
    walkWhitelist(),
    heavyDirs(),
    bigFileSweep(),
  ]);

  const data = volumes.volumes.find((v) => v.mountedOn === '/System/Volumes/Data') ?? null;

  const candidates = cleanupCandidates({ bigFiles, heavy });

  // Derived here rather than in apfsContainer() because it needs both sides:
  // df's "available" is a promise that counts purgeable space, the container's
  // "not allocated" is what has genuinely not been handed out. The gap is the
  // purgeable estimate. Verified 2026-08-14 both were 56,996,409,344 B — i.e.
  // nothing purgeable right now, which is itself worth being able to say.
  if (container.ok && data) {
    const gap = data.availableBytes - (container.notAllocatedBytes ?? data.availableBytes);
    container.purgeableEstimateBytes = Math.max(0, gap);
  }

  // The full sweep is kept only long enough to derive candidates from it;
  // shipping every file over the threshold would bloat the snapshot that
  // Phase 2 pastes wholesale into a prompt.
  delete bigFiles.all;

  return {
    // The number every disk question should be answered from.
    headline: data
      ? {
          volume: data.mountedOn,
          totalBytes: data.totalBytes,
          usedBytes: data.usedBytes,
          availableBytes: data.availableBytes,
          capacityPercent: data.capacityPercent,
          note: 'df / reports the sealed system snapshot (21% used) and is misleading; this is the volume that fills up.',
        }
      : null,
    volumes: volumes.volumes,
    container,
    topDirs,
    heavyDirs: heavy,
    bigFiles,
    cleanupCandidates: candidates,
  };
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

// `df -k` not `df -h`: -h mixes units (460Gi, 207Ki, 0Bi) and can't be summed.
async function dfVolumes() {
  const res = await run('/bin/df', ['-kl'], { timeoutMs: 8_000 });
  if (!res.ok) return { ok: false, error: res.error, volumes: [] };

  const volumes = [];
  for (const line of res.stdout.split('\n').slice(1)) {
    // Mount points contain spaces, so split on whitespace for the 8 numeric-ish
    // columns and take the remainder as the mount point.
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    volumes.push({
      device: m[1],
      totalBytes: Number(m[2]) * 1024,
      usedBytes: Number(m[3]) * 1024,
      availableBytes: Number(m[4]) * 1024,
      capacityPercent: Number(m[5]),
      mountedOn: m[9].trim(),
    });
  }

  return { ok: true, error: null, volumes };
}

// The 6 synthetic APFS volumes all report the same 460 Gi because they share one
// container — summing df rows would trivially claim 2.7 TB of disk. The
// container is the only place the true totals live.
async function apfsContainer() {
  const res = await run('/usr/sbin/diskutil', ['apfs', 'list'], { timeoutMs: 15_000 });
  if (!res.ok) return { ok: false, error: res.error };

  const bytes = (label) => {
    const m = new RegExp(`${label}:\\s+(\\d+) B`).exec(res.stdout);
    return m ? Number(m[1]) : null;
  };

  const ceiling = bytes('Size \\(Capacity Ceiling\\)');
  const inUse = bytes('Capacity In Use By Volumes');
  const notAllocated = bytes('Capacity Not Allocated');

  return {
    ok: true,
    error: null,
    capacityCeilingBytes: ceiling,
    inUseByVolumesBytes: inUse,
    notAllocatedBytes: notAllocated,
    // Best-effort only. macOS exposes no purgeable figure via diskutil -plist
    // (checked — there is no such key), so this is the gap between what df is
    // willing to promise you and what the container has genuinely not handed
    // out. Treat it as a hint, not an accounting fact.
    purgeableEstimateBytes: null, // filled by caller-side derivation below
  };
}

// ---------------------------------------------------------------------------
// Directory sizes
// ---------------------------------------------------------------------------

async function walkWhitelist() {
  const results = await Promise.all(
    WALKED_DIRS.map(async ([label, dir]) => {
      // -x stays on one filesystem, -d1 gives the per-child breakdown that
      // makes "what's eating my disk" answerable one level down.
      const res = await run('/usr/bin/du', ['-xd1', '-k', dir], { timeoutMs: 60_000 });

      // du exits 1 with "Operation not permitted" noise on TCC-protected
      // subdirs even when it successfully sized everything else, so a nonzero
      // exit is NOT a failure here — only empty output is.
      if (!res.stdout.trim()) {
        return { label, path: dir, ok: false, error: res.error ?? 'no output', totalBytes: null, children: [] };
      }

      const rows = res.stdout
        .split('\n')
        .map((line) => {
          const m = /^(\d+)\t(.+)$/.exec(line);
          return m ? { bytes: Number(m[1]) * 1024, path: m[2] } : null;
        })
        .filter(Boolean);

      // du prints the requested dir last; everything before it is a child.
      const self = rows.find((r) => r.path === dir) ?? rows[rows.length - 1];
      const children = rows
        .filter((r) => r !== self)
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 25)
        .map((r) => ({ name: path.basename(r.path), path: r.path, bytes: r.bytes }));

      return {
        label,
        path: dir,
        ok: true,
        error: null,
        ms: res.ms,
        totalBytes: self?.bytes ?? null,
        // Recorded so a partial walk is never silently reported as complete.
        partial: !res.ok,
        children,
      };
    }),
  );

  return results.sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));
}

// -prune means find never descends INTO node_modules, so this is 0.26 s for the
// whole workspace rather than a full tree walk.
async function heavyDirs() {
  const expr = [];
  for (const name of HEAVY_DIR_NAMES) {
    if (expr.length) expr.push('-o');
    expr.push('-name', name);
  }

  const found = await run(
    '/usr/bin/find',
    [path.join(HOME, 'workspace'), '-type', 'd', '(', ...expr, ')', '-prune', '-print'],
    { timeoutMs: 30_000 },
  );
  if (!found.stdout.trim()) return { ok: found.ok, error: found.error, totalBytes: 0, dirs: [] };

  const paths = found.stdout.split('\n').filter(Boolean);

  // Size them concurrently; each is a self-contained subtree so they're fast.
  const sized = await Promise.all(
    paths.map(async (p) => {
      const res = await run('/usr/bin/du', ['-sk', p], { timeoutMs: 30_000 });
      const m = /^(\d+)\t/.exec(res.stdout);
      return { path: p, project: projectOf(p), kind: path.basename(p), bytes: m ? Number(m[1]) * 1024 : null };
    }),
  );

  const dirs = sized.filter((d) => d.bytes != null).sort((a, b) => b.bytes - a.bytes);

  return {
    ok: true,
    error: null,
    // "Regenerable" space — the honest framing for a suggestion, since deleting
    // these costs a reinstall, not data.
    totalBytes: dirs.reduce((sum, d) => sum + d.bytes, 0),
    dirs,
  };
}

function projectOf(p) {
  const rel = path.relative(path.join(HOME, 'workspace'), p);
  return rel.split(path.sep)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Big files
// ---------------------------------------------------------------------------

async function bigFileSweep() {
  const [spotlight, workspace] = await Promise.all([mdfindBig(), findWorkspaceBig()]);

  // Merge and dedupe by path, remembering how each was found — a file only
  // `find` saw is a file Spotlight's index is missing, which is itself useful.
  const byPath = new Map();
  for (const f of spotlight.files) byPath.set(f.path, { ...f, seenBy: ['spotlight'] });
  for (const f of workspace.files) {
    const hit = byPath.get(f.path);
    if (hit) hit.seenBy.push('find');
    else byPath.set(f.path, { ...f, seenBy: ['find'] });
  }

  const all = [...byPath.values()].filter((f) => f.bytes != null).sort((a, b) => b.bytes - a.bytes);

  return {
    ok: spotlight.ok || workspace.ok,
    spotlightOk: spotlight.ok,
    findOk: workspace.ok,
    thresholds: {
      spotlightMinBytes: BIG_FILE_MIN_BYTES,
      workspaceMin: WORKSPACE_FILE_MIN,
    },
    found: all.length,
    // Only the biggest are kept for display, but cleanup detection runs over
    // the FULL set — a 407 MB archive is a candidate worth naming and it sits
    // well below any top-N cut.
    files: all.slice(0, 60),
    all,
    // Files only `find` saw are files Spotlight's index is missing. Verified
    // 2026-08-14: a 407 MB archive was one of them, so a Spotlight-only sweep
    // have silently failed at the exact job this collector exists to do.
    missedBySpotlight: all
      .filter((f) => f.seenBy.length === 1 && f.seenBy[0] === 'find')
      .map((f) => f.path),
  };
}

async function mdfindBig() {
  const res = await run('/usr/bin/mdfind', [`kMDItemFSSize > ${BIG_FILE_MIN_BYTES}`], {
    timeoutMs: 15_000,
  });
  if (!res.ok) return { ok: false, error: res.error, files: [] };
  return { ok: true, error: null, files: await statAll(res.stdout.split('\n').filter(Boolean)) };
}

async function findWorkspaceBig() {
  const res = await run(
    '/usr/bin/find',
    [path.join(HOME, 'workspace'), '-type', 'f', '-size', `+${WORKSPACE_FILE_MIN}`],
    { timeoutMs: 30_000 },
  );
  // Nonzero exit from permission noise is fine as long as we got paths.
  if (!res.stdout.trim()) return { ok: res.ok, error: res.error, files: [] };
  return { ok: true, error: null, files: await statAll(res.stdout.split('\n').filter(Boolean)) };
}

// stat in-process rather than shelling out per file — 60 paths would otherwise
// be 60 execs.
async function statAll(paths) {
  const { stat } = await import('node:fs/promises');
  return Promise.all(
    paths.map(async (p) => {
      try {
        const s = await stat(p);
        return { path: p, bytes: s.size, modifiedAt: s.mtime.toISOString() };
      } catch {
        // Vanished between listing and stat, or unreadable — not an error.
        return { path: p, bytes: null, modifiedAt: null };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Cleanup candidates — printed as commands, never run (PLAN.md ground rule)
// ---------------------------------------------------------------------------

// Phase 1 only *identifies* these; `deckhand suggest` (Phase 4) is what renders
// them. Keeping the detection here means the snapshot alone answers the
// question, with no LLM involved.
const STALE_PATTERNS = [
  { re: /\.zip$/i, why: 'archive' },
  { re: /\.bak(-[\w.-]+)?$/i, why: 'backup' },
  { re: /\.bak-\d{8}/i, why: 'dated backup' },
  { re: /\.old$/i, why: 'old copy' },
  { re: /\.dmg$/i, why: 'installer image' },
  { re: /\.pkg$/i, why: 'installer package' },
];

function cleanupCandidates({ bigFiles, heavy }) {
  const stale = [];
  // bigFiles.all, not bigFiles.files — see the note on the top-N cut above.
  for (const f of bigFiles.all ?? bigFiles.files) {
    const hit = STALE_PATTERNS.find((p) => p.re.test(f.path));
    if (hit) stale.push({ path: f.path, bytes: f.bytes, modifiedAt: f.modifiedAt, why: hit.why });
  }

  return {
    staleFiles: stale.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)),
    staleFilesBytes: stale.reduce((sum, f) => sum + (f.bytes ?? 0), 0),
    regenerableBytes: heavy.totalBytes ?? 0,
    // The guardrail, stated in the data itself so no consumer can mistake this
    // for something deckhand acts on.
    policy: 'read-only: deckhand never deletes. These are printed for review.',
  };
}

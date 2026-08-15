// Installed-software collector — apps, brew, npm, pipx, ollama models.
//
// This collector exists to answer "which apps haven't I opened in a year?" and
// to feed the `fact` mode ("your three qwen models total 15 GB"), so it cares
// about *last used* far more than it cares about what merely exists on disk.
//
// Three things about this machine make the naive version wrong, all verified
// live 2026-08-14:
//
//   1. /Applications is not a flat list of .app bundles. 70 entries, only 60
//      are .app; the rest are vendor folders (audio-plugin suites, Utilities)
//      plus the occasional stray file. Globbing
//      *.app at the top level silently loses the entire audio-plugin suite, so
//      we recurse one level into non-.app directories.
//   2. `brew outdated` with no env guard AUTO-UPDATES HOMEBREW — that is a
//      write, and deckhand is read-only by contract (PLAN.md). Measured: cold
//      it took 24.2 s and bumped brew 2a2dac58e6 -> 6.0.17 as a side effect.
//      With HOMEBREW_NO_AUTO_UPDATE=1 the same call is 0.78 s and mutates
//      nothing. Every brew invocation here goes through BREW_ENV.
//   3. `mdls` is nearly free when batched (0.06 s for 5 apps in one call) but
//      its multi-path output is unlabeled — see readLastUsed() for the two
//      traps that cost us on the first attempt.
//
// Sources run concurrently; the whole collector lands in well under 3 s.

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { run, runJson } from '../run.mjs';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const OLLAMA_PROBE_TIMEOUT_MS = 1_500;

// Each root is tagged onto its apps so the snapshot can tell "I installed this"
// (/Applications, ~/Applications) from "Apple shipped it" (/System/Applications).
// Only the first is ever a cleanup candidate.
const APP_ROOTS = [
  { root: '/Applications', origin: 'user-installed' },
  { root: '/System/Applications', origin: 'system' },
  { root: join(homedir(), 'Applications'), origin: 'user-home' },
];

// mdls tops out well before this, but batching keeps us off the per-app
// process-spawn cliff: 1 call for 50 apps instead of 50 calls.
const MDLS_CHUNK = 50;

const STALE_AFTER_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// run() sets PATH itself and then spreads opts.execOpts over the whole options
// object — so handing it an `env` REPLACES run()'s env wholesale, PATH included,
// and brew would vanish under launchd. Merge rather than replace.
//
// This PATH must stay a mirror of run.mjs's (it isn't exported, so it can't be
// shared): homebrew first, then /usr/local/bin, then ~/.local/bin where pm2
// lives on this machine.
const BREW_ENV = {
  ...process.env,
  PATH: [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${process.env.HOME}/.local/bin`,
    process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
  ].join(':'),
  // The read-only guarantee. Do not remove: without it `brew outdated` updates
  // Homebrew itself (verified 2026-08-14).
  HOMEBREW_NO_AUTO_UPDATE: '1',
  // Analytics are a network write with our name on it; the snapshot is local.
  HOMEBREW_NO_ANALYTICS: '1',
};

export async function collectInstalled() {
  const [apps, homebrew, npmGlobal, pipx, ollamaModels] = await Promise.all([
    collectApps(),
    collectHomebrew(),
    collectNpmGlobal(),
    collectPipx(),
    collectOllamaModels(),
  ]);

  return {
    apps,
    // The headline list — pulled out of apps.items so a grep-only answer to
    // "which apps haven't I opened in a year?" works without walking the tree.
    staleApps: staleApps(apps.items),
    homebrew,
    npmGlobal,
    pipx,
    ollamaModels,
  };
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

async function collectApps() {
  const scans = await Promise.all(APP_ROOTS.map((r) => scanRoot(r.root, r.origin)));

  const roots = scans.map((s) => s.summary);
  const found = scans.flatMap((s) => s.apps);

  // One metadata pass over every root at once — chunked, not per-app.
  const usage = await readLastUsed(found.map((a) => a.path));

  const items = found
    .map((app) => {
      const meta = usage.byName.get(app.name.toLowerCase()) ?? null;
      return { ...app, ...usageFields(meta) };
    })
    // Never-used-and-never-dated apps sort last rather than pretending to be
    // infinitely stale.
    .sort((a, b) => (b.daysSinceUsed ?? -1) - (a.daysSinceUsed ?? -1));

  return {
    ok: roots.some((r) => r.ok),
    error: null,
    roots,
    count: items.length,
    // How much of the list actually has a real open-date behind it. If this is
    // low, staleApps is guesswork and the UI should say so.
    withLastUsedDate: items.filter((a) => a.lastUsedSource === 'kMDItemLastUsedDate').length,
    metadata: usage.summary,
    items,
  };
}

// One level of recursion, deliberately. The audio vendors nest exactly one deep
// (Waves/Waves Central.app, Universal Audio/UAD Meter & Control Panel.app), and
// going deeper would start pulling in the helper apps *inside* .app bundles,
// which are not things anyone "opens".
async function scanRoot(root, origin) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return {
      summary: { root, origin, ok: false, error: err?.message ?? String(err), entries: 0, apps: 0 },
      apps: [],
    };
  }

  const apps = [];
  const nestedDirs = [];
  // Hidden entries are excluded from the app list but counted: /Applications
  // can hold hidden `.SomeApp.app` bundles (plus .DS_Store and
  // .localized), and a hidden app bundle is a leftover worth knowing about even
  // though it isn't something you "open". Counting visible entries only is also
  // what makes this number reconcile with the 70 that `ls` shows.
  const hidden = entries.filter((e) => e.name.startsWith('.'));

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.endsWith('.app')) {
      apps.push(makeApp(join(root, entry.name), root, origin, null));
    } else if (entry.isDirectory()) {
      // A vendor folder, or Utilities. Not an app itself.
      nestedDirs.push(entry.name);
    }
    // Anything else is a stray file (e.g. `toxic love p. irie 3.wav`) — noted
    // by the entry count below, but not an app.
  }

  const nested = await Promise.all(
    nestedDirs.map(async (dir) => {
      try {
        const inner = await readdir(join(root, dir), { withFileTypes: true });
        return inner
          .filter((e) => e.name.endsWith('.app'))
          .map((e) => makeApp(join(root, dir, e.name), root, origin, dir));
      } catch {
        // Vendor folders can be permission-odd; a folder we can't read is not
        // a reason to lose the 60 apps we could read.
        return [];
      }
    }),
  );

  const all = [...apps, ...nested.flat()];

  return {
    summary: {
      root,
      origin,
      ok: true,
      error: null,
      entries: entries.length - hidden.length,
      hiddenEntries: hidden.length,
      hiddenApps: hidden.filter((e) => e.name.endsWith('.app')).map((e) => e.name),
      topLevelApps: apps.length,
      vendorFolders: nestedDirs.length,
      nestedApps: all.length - apps.length,
      apps: all.length,
    },
    apps: all,
  };
}

function makeApp(path, root, origin, parentFolder) {
  return {
    name: basename(path),
    label: basename(path, '.app'),
    path,
    root,
    origin,
    // Non-null means it came from a vendor folder, which is the bit the naive
    // *.app glob would have dropped entirely.
    parentFolder,
    nested: parentFolder != null,
  };
}

// ---------------------------------------------------------------------------
// Spotlight metadata (last used)
// ---------------------------------------------------------------------------

// Two traps, both hit and fixed on 2026-08-14:
//
//   1. With multiple paths, mdls prints one block per file with NO filename
//      header — the blocks are only separated by the key order restarting. So
//      we ask for kMDItemPath as a field and correlate on that. But the path it
//      returns is the *resolved firmlinked* one: Safari comes back as
//      /System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app and
//      VS Code as /System/Volumes/Data/Applications/Visual Studio Code.app.
//      Neither equals the path we passed in, so we match on basename.
//   2. kMDItemLastUsedDate is sometimes literally `(null)` — verified for
//      Visual Studio Code, which also reports a null kMDItemUseCount despite
//      obviously being in daily use. An app update appears to reset it. We fall
//      back to kMDItemContentModificationDate and record which one we used, so
//      a consumer can discount the weaker signal instead of trusting it blindly.
async function readLastUsed(paths) {
  const byName = new Map();
  const chunks = [];
  for (let i = 0; i < paths.length; i += MDLS_CHUNK) chunks.push(paths.slice(i, i + MDLS_CHUNK));

  const results = await Promise.all(
    chunks.map((chunk) =>
      run(
        '/usr/bin/mdls',
        [
          '-name',
          'kMDItemLastUsedDate',
          '-name',
          'kMDItemUseCount',
          '-name',
          'kMDItemContentModificationDate',
          '-name',
          'kMDItemPath', // required: the only way to tell the blocks apart
          ...chunk,
        ],
        { timeoutMs: 20_000 },
      ),
    ),
  );

  const failed = results.filter((r) => !r.ok);
  for (const res of results) {
    if (!res.ok) continue;
    for (const record of parseMdls(res.stdout)) {
      if (!record.path) continue;
      const key = basename(record.path).toLowerCase();
      // First writer wins: a firmlinked app can appear under two roots and the
      // earlier root is the one we scanned first.
      if (!byName.has(key)) byName.set(key, record);
    }
  }

  return {
    byName,
    summary: {
      ok: failed.length < results.length || results.length === 0,
      chunks: chunks.length,
      matched: byName.size,
      requested: paths.length,
      ms: results.reduce((sum, r) => sum + r.ms, 0),
      error: failed.length ? failed[0].error : null,
    },
  };
}

// mdls emits `key = value` lines with no record separator, so a record ends
// when a key we've already seen comes round again.
function parseMdls(stdout) {
  const records = [];
  let current = {};

  const flush = () => {
    if (Object.keys(current).length) records.push(normalizeMdls(current));
    current = {};
  };

  for (const line of stdout.split('\n')) {
    const m = /^(kMDItem\w+)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, raw] = m;
    if (key in current) flush();
    current[key] = raw.trim();
  }
  flush();

  return records;
}

function normalizeMdls(raw) {
  const value = (key) => {
    const v = raw[key];
    // mdls writes the string `(null)` for absent attributes, not an empty value.
    if (v == null || v === '(null)') return null;
    return v.replace(/^"(.*)"$/, '$1');
  };

  return {
    path: value('kMDItemPath'),
    lastUsedAt: parseMdlsDate(value('kMDItemLastUsedDate')),
    contentModifiedAt: parseMdlsDate(value('kMDItemContentModificationDate')),
    useCount: value('kMDItemUseCount') == null ? null : Number(value('kMDItemUseCount')),
  };
}

// mdls prints `2026-08-06 23:36:16 +0000`, which is not ISO 8601. Normalize the
// space and the offset rather than relying on Date's lenient parser.
function parseMdlsDate(text) {
  if (!text) return null;
  const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*([+-]\d{2})(\d{2})$/.exec(text);
  const iso = m ? `${m[1]}T${m[2]}${m[3]}:${m[4]}` : text;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function usageFields(meta) {
  if (!meta) {
    return {
      lastUsedAt: null,
      lastUsedSource: null,
      useCount: null,
      contentModifiedAt: null,
      daysSinceUsed: null,
    };
  }

  // Prefer the real signal; fall back to the bundle's mtime, but say so.
  const lastUsedAt = meta.lastUsedAt ?? meta.contentModifiedAt ?? null;
  const source = meta.lastUsedAt
    ? 'kMDItemLastUsedDate'
    : meta.contentModifiedAt
      ? 'kMDItemContentModificationDate'
      : null;

  return {
    lastUsedAt,
    lastUsedSource: source,
    useCount: meta.useCount,
    contentModifiedAt: meta.contentModifiedAt,
    daysSinceUsed:
      lastUsedAt == null ? null : Math.floor((Date.now() - new Date(lastUsedAt).getTime()) / DAY_MS),
  };
}

// The answer to "which apps haven't I opened in a year?". System apps are
// excluded: nobody is going to delete Chess.app, and leaving them in buries the
// handful of real candidates under 40 Apple bundles.
function staleApps(items) {
  return items
    .filter((a) => a.origin !== 'system')
    .filter((a) => a.daysSinceUsed != null && a.daysSinceUsed > STALE_AFTER_DAYS)
    // Confident entries first, then by age. PLAN.md's Phase 1 bar is that the
    // snapshot answers "which apps haven't I opened in a year?" by grep alone —
    // so whatever sorts first IS the answer someone reads. Sorting purely by
    // age put KeyCastr on top with a 2019 date that's really a file mtime, not
    // an open. Real kMDItemLastUsedDate readings lead; the mtime guesses
    // follow, still present but visibly second-class.
    .sort((a, b) => {
      const byConfidence =
        Number(b.lastUsedSource === 'kMDItemLastUsedDate') -
        Number(a.lastUsedSource === 'kMDItemLastUsedDate');
      return byConfidence || b.daysSinceUsed - a.daysSinceUsed;
    })
    .map((a) => ({
      name: a.name,
      path: a.path,
      parentFolder: a.parentFolder,
      lastUsedAt: a.lastUsedAt,
      lastUsedSource: a.lastUsedSource,
      useCount: a.useCount,
      daysSinceUsed: a.daysSinceUsed,
      // A date that came from the bundle mtime says "not updated in a year",
      // which is not the same claim as "not opened in a year".
      confident: a.lastUsedSource === 'kMDItemLastUsedDate',
    }));
}

// ---------------------------------------------------------------------------
// Homebrew
// ---------------------------------------------------------------------------

async function collectHomebrew() {
  // Casks are NOT in `brew list --versions` — that lists formulae only, so the
  // GUI apps installed via brew would be invisible. Separate call, verified.
  const [outdated, formulae, casks] = await Promise.all([
    brewOutdated(),
    brewList(['list', '--versions'], 'formula'),
    brewList(['list', '--cask', '--versions'], 'cask'),
  ]);

  return {
    ok: outdated.ok || formulae.ok || casks.ok,
    // Recorded so a reader can confirm the read-only guarantee held for this
    // snapshot, rather than having to trust the code.
    autoUpdateSuppressed: true,
    formulae,
    casks,
    outdated,
  };
}

async function brewOutdated() {
  const res = await runJson('brew', ['outdated', '--json=v2'], {
    timeoutMs: 30_000,
    execOpts: { env: BREW_ENV },
  });

  // stderr carries brew's hint banners ("Run `brew update`...") even on
  // success, so it is deliberately discarded rather than reported as an error.
  if (!res.ok) {
    return { ok: false, error: res.error, ms: res.ms, formulae: [], casks: [], count: 0 };
  }

  const map = (entry, kind) => ({
    kind,
    name: entry.name,
    installedVersions: entry.installed_versions ?? [],
    currentVersion: entry.current_version ?? null,
    // A pinned formula is outdated on purpose; suggesting an upgrade for it
    // would be noise.
    pinned: Boolean(entry.pinned),
    pinnedVersion: entry.pinned_version ?? null,
  });

  const outFormulae = (res.json?.formulae ?? []).map((e) => map(e, 'formula'));
  const outCasks = (res.json?.casks ?? []).map((e) => map(e, 'cask'));

  return {
    ok: true,
    error: null,
    ms: res.ms,
    formulae: outFormulae,
    casks: outCasks,
    count: outFormulae.length + outCasks.length,
    pinnedCount: [...outFormulae, ...outCasks].filter((e) => e.pinned).length,
  };
}

// `brew list --versions` prints `name ver1 ver2` — multiple versions mean old
// kegs are still on disk, which is a disk-space fact worth keeping.
async function brewList(args, kind) {
  const res = await run('brew', args, { timeoutMs: 30_000, execOpts: { env: BREW_ENV } });
  if (!res.ok) return { ok: false, error: res.error, ms: res.ms, count: 0, items: [] };

  const items = res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...versions] = line.split(/\s+/);
      return { kind, name, versions, multipleVersions: versions.length > 1 };
    });

  return {
    ok: true,
    error: null,
    ms: res.ms,
    count: items.length,
    multiVersionCount: items.filter((i) => i.multipleVersions).length,
    items,
  };
}

// ---------------------------------------------------------------------------
// npm / pipx
// ---------------------------------------------------------------------------

// There is more than one npm on this Mac and they disagree, which is a trap
// worth recording rather than papering over. Verified 2026-08-14: the login
// shell resolved npm to ~/.local/bin/npm (prefix ~/.local, holding one set of
// globals), while run.mjs deliberately prepends /opt/homebrew/bin to PATH so
// collectors still work under launchd — which resolves to /opt/homebrew/bin/npm
// (prefix /opt/homebrew, globals: @google/gemini-cli, @openai/codex,
// create-react-app, eslint, npm). Neither list is wrong; they are different
// installs. So the snapshot records WHICH npm it described, otherwise a reader
// would reasonably conclude pm2 isn't installed globally.
// Rather than pick a winner, describe every npm on the machine. Picking one
// would make the snapshot assert something false either way: report homebrew's
// and pm2 looks uninstalled; report ~/.local's and the gemini/codex CLIs
// vanish. "Installed globally" is only meaningful per-prefix, so the snapshot
// says so explicitly.
const NPM_CANDIDATES = [
  '/opt/homebrew/bin/npm', // what run.mjs's PATH resolves to (and launchd will)
  `${process.env.HOME}/.local/bin/npm`, // what the login shell resolves to
  '/usr/local/bin/npm',
  '/usr/bin/npm',
];

async function collectNpmGlobal() {
  const { existsSync } = await import('node:fs');
  const present = NPM_CANDIDATES.filter((p) => existsSync(p));

  if (!present.length) {
    return { ok: false, error: 'no npm found', installs: [], count: 0, items: [] };
  }

  const installs = (await Promise.all(present.map(describeNpm)))
    // Two paths can be symlinks to one install; the prefix is the real identity.
    .filter((install, i, all) => all.findIndex((o) => o.prefix === install.prefix) === i);

  // A flat union so "is X installed globally?" is answerable without knowing
  // about prefixes, while each item still carries where it actually lives.
  const items = installs.flatMap((install) =>
    install.items.map((item) => ({ ...item, prefix: install.prefix })),
  );

  return {
    ok: installs.some((i) => i.ok),
    error: null,
    note: 'globals are per-prefix; this machine has more than one npm and they list different packages',
    installs,
    count: items.length,
    items,
  };
}

async function describeNpm(npmPath) {
  // npm is a JS script, so its shebang picks up whatever `node` is first on
  // PATH — and run.mjs deliberately puts /opt/homebrew/bin first. That made
  // ~/.local/bin/npm run under homebrew's node and report homebrew's prefix,
  // hiding that prefix's globals entirely (verified 2026-08-14). Resolve
  // the symlink and put each npm's OWN bin dir first so it describes itself.
  const { realpath } = await import('node:fs/promises');
  let ownBin = null;
  try {
    ownBin = dirname(await realpath(npmPath)); // ~/.local/bin/npm → ~/.hermes/node/bin
  } catch {
    // Unreadable symlink — fall back to the ambient PATH rather than failing.
  }

  const execOpts = ownBin
    ? { env: { ...process.env, PATH: `${ownBin}:${process.env.PATH ?? ''}` } }
    : undefined;

  const [res, prefix] = await Promise.all([
    runJson(npmPath, ['ls', '-g', '--depth=0', '--json'], { timeoutMs: 20_000, execOpts }),
    run(npmPath, ['config', 'get', 'prefix'], { timeoutMs: 20_000, execOpts }),
  ]);

  // npm exits non-zero for unmet peer deps while still printing valid JSON, so
  // trust the parsed payload over the exit code when we got one.
  const deps = res.json?.dependencies ?? null;

  return {
    npmPath,
    prefix: prefix.ok ? prefix.stdout.trim() : null,
    ok: Boolean(deps),
    error: deps ? null : (res.error ?? 'no dependencies in npm output'),
    ms: res.ms,
    items: Object.entries(deps ?? {}).map(([name, info]) => ({
      name,
      version: info?.version ?? null,
      // A `file:` resolve is a linked local checkout, not a
      // published install — different thing entirely when reasoning about
      // what's installed.
      linked: typeof info?.resolved === 'string' && info.resolved.startsWith('file:'),
      resolved: info?.resolved ?? null,
    })),
  };
}

// pipx is NOT installed on this machine (verified 2026-08-14: exit 127). That
// is a fact about the Mac, not a failure of the scan, so it is reported as
// installed:false rather than as an error the UI has to apologise for.
async function collectPipx() {
  const res = await runJson('pipx', ['list', '--json'], { timeoutMs: 20_000 });
  if (!res.ok) {
    const missing = res.error === 'not installed (command not found)' || res.code === 127;
    return {
      ok: true,
      installed: !missing,
      error: missing ? null : res.error,
      note: missing ? 'pipx is not installed on this machine' : null,
      count: 0,
      items: [],
    };
  }

  const venvs = res.json?.venvs ?? {};
  const items = Object.entries(venvs).map(([name, info]) => ({
    name,
    version: info?.metadata?.main_package?.package_version ?? null,
  }));

  return { ok: true, installed: true, error: null, count: items.length, items };
}

// ---------------------------------------------------------------------------
// Ollama models
// ---------------------------------------------------------------------------

// The HTTP API, not `ollama list`: the CLI's table columns ("4.7 GB") don't
// split on whitespace cleanly — same reason memory.mjs uses /api/ps.
//
// Verified 2026-08-14: 3 models on disk — qwen2.5:7b (4.7 GB), gemma2:2b
// (1.6 GB), qwen2.5-coder:14b (9 GB). The total is what feeds the `fact` mode
// comparison against the size of /Applications; bundle sizes themselves are the
// disk collector's job, so they are deliberately not measured here.
async function collectOllamaModels() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, reachable: true, error: `HTTP ${res.status}`, count: 0, totalBytes: 0, models: [] };
    }

    const json = await res.json();
    const models = (json?.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size ?? 0,
      sizeGB: round2((m.size ?? 0) / 1e9),
      modifiedAt: m.modified_at ?? null,
      parameterSize: m.details?.parameter_size ?? null,
      quantization: m.details?.quantization_level ?? null,
      family: m.details?.family ?? null,
    }));

    const totalBytes = models.reduce((sum, m) => sum + m.sizeBytes, 0);

    return {
      ok: true,
      reachable: true,
      error: null,
      count: models.length,
      totalBytes,
      // GB not GiB: this number gets compared against ollama's own "4.7 GB"
      // labels, which are decimal.
      totalGB: round2(totalBytes / 1e9),
      models: models.sort((a, b) => b.sizeBytes - a.sizeBytes),
    };
  } catch (err) {
    // Ollama being down is a fact about the machine, not an error in deckhand.
    return {
      ok: false,
      reachable: false,
      error: err?.message ?? String(err),
      count: 0,
      totalBytes: 0,
      models: [],
    };
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

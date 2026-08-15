// Command runner for collectors. Node v22, ESM, built-in modules only.
//
// Never shells out (execFile only). Every
// collector here is read-only by contract; nothing in this repo may delete,
// kill, or reconfigure anything (PLAN.md ground rules).

import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 10_000;

// Collectors run against a machine whose tools may be missing, slow, or newly
// permission-gated by a macOS update. A collector that throws would take the
// whole snapshot down, so every failure is captured as data instead: the
// snapshot records *that* a source failed and why, and the rest still writes.
/**
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null, ms: number, error: string|null}>}
 */
export function run(file, args = [], opts = {}) {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = process.hrtime.bigint();

  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout,
        killSignal: 'SIGKILL',
        // system_profiler -json and `du` toplists both blow past the 1 MB
        // default and would come back silently truncated.
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
          // launchd and pm2 hand us a PATH without homebrew, so `brew`,
          // `ollama` and `tailscale` all vanish when deckhand is run as a
          // service rather than from a login shell. Same fix as
          // Termdeck/ecosystem.config.js.
          //
          // ~/.local/bin is in here because pm2 is installed there on this
          // machine (verified 2026-08-14), not in either brew prefix — so a
          // homebrew-only patch would still lose pm2 under launchd, which is
          // exactly when deckhand most needs to see the pm2 processes.
          PATH: [
            '/opt/homebrew/bin',
            '/usr/local/bin',
            `${process.env.HOME}/.local/bin`,
            process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
          ].join(':'),
        },
        ...opts.execOpts,
      },
      (error, stdout, stderr) => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        resolve({
          ok: !error,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: error?.code ?? 0,
          ms: Math.round(ms),
          error: error ? describe(error, timeout) : null,
        });
      },
    );
  });
}

/** Same as run(), but parses stdout as JSON. Bad JSON is a failure, not a throw. */
export async function runJson(file, args = [], opts = {}) {
  const res = await run(file, args, opts);
  if (!res.ok) return { ...res, json: null };
  try {
    return { ...res, json: JSON.parse(res.stdout) };
  } catch (err) {
    return { ...res, ok: false, json: null, error: `unparseable JSON: ${err.message}` };
  }
}

function describe(error, timeout) {
  if (error.killed || error.signal === 'SIGKILL') return `timed out after ${timeout}ms`;
  if (error.code === 'ENOENT') return 'not installed (command not found)';
  // Tools like `brew outdated` exit non-zero for ordinary reasons; keep stderr
  // so the snapshot can show what actually happened rather than just a code.
  return error.message?.split('\n')[0] ?? String(error);
}

/** Wall-clock helper so each collector can report its own cost in the snapshot. */
export async function timed(name, fn) {
  const started = process.hrtime.bigint();
  try {
    const value = await fn();
    return { name, ok: true, ms: elapsed(started), value, error: null };
  } catch (err) {
    // A collector that throws is a bug in deckhand, not a fact about the Mac —
    // but it still must not take the snapshot down with it.
    return { name, ok: false, ms: elapsed(started), value: null, error: err?.message ?? String(err) };
  }
}

function elapsed(started) {
  return Math.round(Number(process.hrtime.bigint() - started) / 1e6);
}

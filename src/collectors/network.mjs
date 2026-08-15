// Network collector — who is listening on what, and is this Mac on the tailnet.
//
// The question this exists to answer is PLAN.md's "what's listening on 4400?",
// and answering it honestly needs two tools, not one:
//
//   lsof     names the process behind a port, but only sees processes owned by
//            the user running deckhand — root's listeners are invisible to it.
//   netstat  sees every listening socket on the box including root's, but has
//            no idea which process owns any of them.
//
// So both run and the results are merged, and every port records *how* it was
// seen. That's the point of `seenBy`: a port that only netstat can see is a
// root-owned (or other-user) listener, and the difference between "known
// service, just not mine" and "something is listening on 46011 and nothing here
// can tell you what" should be visible at a glance rather than inferred.
//
// Verified live 2026-08-14 on Darwin 23.3.0, none of it needing sudo:
// `lsof -iTCP -sTCP:LISTEN -P -n +c 0` 0.07 s, `netstat -an -p tcp` 0.003 s,
// `tailscale status --json` 0.03 s / 5.6 KB. netstat found six listeners lsof
// could not (22, 6783, 35669, 46011, 49449, 50750) — all root-owned, which is
// exactly the gap this merge closes. All three commands are pure reads.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runJson, run } from '../run.mjs';

// ---------------------------------------------------------------------------
// Known ports
// ---------------------------------------------------------------------------

// Port registry. Ships with the well-known ports every Mac dev machine has and
// nothing else — your own services go in deckhand.config.json, which is
// gitignored precisely so a personal service map never lands in a public repo.
// See deckhand.config.example.json.
//
// Labelling a port you don't recognise is worse than leaving it blank: a wrong
// name gets repeated as fact by the LLM in Phase 2.
const DEFAULT_PORTS = {
  22: 'ssh',
  3306: 'mysql',
  5432: 'postgres',
  6379: 'redis',
  8080: 'http-alt',
  9222: 'chrome-devtools',
  11434: 'ollama',
  27017: 'mongodb',
  33060: 'mysql (x protocol)',
};

const CONFIG_PATH =
  process.env.DECKHAND_CONFIG ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'deckhand.config.json');

export const KNOWN_PORTS = { ...DEFAULT_PORTS, ...loadUserPorts() };

// Read synchronously at module load: the map has to exist before any collector
// runs, and it is a few hundred bytes.
function loadUserPorts() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).ports ?? {};
  } catch {
    // No config is the normal case, not an error.
    return {};
  }
}

export async function collectNetwork() {
  const [lsof, netstat, tailscale] = await Promise.all([
    lsofListeners(),
    netstatListeners(),
    tailscaleStatus(),
  ]);

  const listeners = mergeListeners(lsof, netstat, tailscale);

  return {
    listeners,
    summary: summarise(listeners, lsof, netstat),
    sources: {
      lsof: { ok: lsof.ok, error: lsof.error, rows: lsof.rows.length },
      netstat: { ok: netstat.ok, error: netstat.error, rows: netstat.rows.length },
    },
    tailscale,
  };
}

// ---------------------------------------------------------------------------
// lsof — process names
// ---------------------------------------------------------------------------

// Flags, all load-bearing:
//   -iTCP -sTCP:LISTEN   listening TCP sockets only
//   -P                   numeric ports (otherwise 3306 prints as "mysql")
//   -n                   no reverse DNS — this is the difference between 70 ms
//                        and multi-second stalls when a resolver is slow
//   +c 0                 do NOT truncate COMMAND. lsof's default is 9
//                        characters, which turns "ControlCenter" into
//                        "ControlCe" and "UA Mixer Engine" into "UA\x20Mix" —
//                        names that match nothing and mislead a reader.
async function lsofListeners() {
  const res = await run('/usr/sbin/lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '+c', '0'], {
    timeoutMs: 8_000,
  });
  // lsof exits 1 when some file it probed was inaccessible even though the
  // output is perfectly good, so usable stdout is trusted over the exit code.
  if (!res.ok && !res.stdout.trim()) return { ok: false, error: res.error, rows: [] };

  const rows = [];
  for (const line of res.stdout.split('\n')) {
    // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME(LISTEN). Nothing here
    // contains a literal space — lsof escapes them — so plain \S+ columns hold.
    const m = /^(\S+)\s+(\d+)\s+(\S+)\s+\S+\s+(IPv[46])\s+\S+\s+\S+\s+\S+\s+(\S+)\s+\(LISTEN\)$/.exec(
      line,
    );
    if (!m) continue;
    const addr = splitHostPort(m[5], ':');
    if (!addr) continue;
    rows.push({
      command: unescapeLsof(m[1]),
      pid: Number(m[2]),
      user: m[3],
      family: m[4],
      address: addr.host,
      port: addr.port,
    });
  }

  return { ok: true, error: null, rows };
}

// With +c 0 lsof stops truncating but still escapes anything non-printable,
// spaces included, as \xNN — so "UA Mixer Engine" arrives as "UA\x20Mixer\x20Engine".
// Undo it, or every name with a space in it fails to match anything.
function unescapeLsof(s) {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// ---------------------------------------------------------------------------
// netstat — completeness
// ---------------------------------------------------------------------------

async function netstatListeners() {
  const res = await run('/usr/sbin/netstat', ['-an', '-p', 'tcp'], { timeoutMs: 8_000 });
  if (!res.ok) return { ok: false, error: res.error, rows: [] };

  const rows = [];
  for (const line of res.stdout.split('\n')) {
    // Proto Recv-Q Send-Q Local-Address Foreign-Address (state)
    const m = /^(tcp\S*)\s+\d+\s+\d+\s+(\S+)\s+\S+\s+LISTEN\b/.exec(line);
    if (!m) continue;
    // BSD netstat separates host and port with a dot, not a colon — including
    // for IPv6, where the host half is itself full of colons. Split on the LAST
    // dot or IPv6 listeners get shredded.
    const addr = splitHostPort(m[2], '.');
    if (!addr) continue;
    rows.push({ protocol: m[1], address: addr.host, port: addr.port });
  }

  return { ok: true, error: null, rows };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function mergeListeners(lsof, netstat, tailscale) {
  /** @type {Map<number, any>} */
  const byPort = new Map();

  const entry = (port) => {
    if (!byPort.has(port)) {
      byPort.set(port, {
        port,
        known: KNOWN_PORTS[port] ?? null,
        seenBy: null,
        addresses: new Set(),
        families: new Set(),
        processes: new Map(),
      });
    }
    return byPort.get(port);
  };

  for (const row of lsof.rows) {
    const e = entry(row.port);
    e.seenBy = e.seenBy === 'netstat' ? 'both' : 'lsof';
    e.addresses.add(row.address);
    e.families.add(row.family); // lsof spells it IPv4 / IPv6
    // One process opens several fds for the same port (IPv4 + IPv6 is the
    // common case), so dedupe on pid rather than emitting a row per fd.
    if (!e.processes.has(row.pid)) {
      e.processes.set(row.pid, { pid: row.pid, command: row.command, user: row.user });
    }
  }

  for (const row of netstat.rows) {
    const e = entry(row.port);
    e.seenBy = e.seenBy === 'lsof' || e.seenBy === 'both' ? 'both' : 'netstat';
    e.addresses.add(row.address);
    // netstat spells the same thing tcp4 / tcp6 / tcp46 (dual-stack). Normalise
    // to lsof's vocabulary so a port seen by both doesn't list its address
    // family twice under two names.
    for (const family of familiesFromNetstatProto(row.protocol)) e.families.add(family);
  }

  const selfTailscaleIps = new Set(tailscale.self?.tailscaleIPs ?? []);

  return [...byPort.values()]
    .map((e) => {
      const addresses = [...e.addresses].sort();
      const processes = [...e.processes.values()];
      return {
        port: e.port,
        known: e.known,
        seenBy: e.seenBy,
        addresses,
        families: [...e.families].sort(),
        processes,
        scope: scopeOf(addresses, selfTailscaleIps),
        // Nobody local owns it and it isn't in the registry: this is the row a
        // human should actually look at. lsof runs unprivileged and only sees
        // its own user's processes, so a netstat-only port is root's (or
        // another user's) and deckhand genuinely cannot name it — say so
        // rather than leaving a silent blank where a process should be.
        unidentified: e.seenBy === 'netstat' && processes.length === 0,
      };
    })
    .sort((a, b) => a.port - b.port);
}

// How reachable the thing actually is, which is more useful than the port
// number alone: it answers "can I pull this up from my phone, or only from
// this desk?"
//
// Deliberately NOT a security judgement. Tailscale here is a convenience for
// reaching local apps remotely without standing up a cloudflare tunnel — not a
// boundary these services are supposed to stay inside. An 'all-interfaces'
// bind is a plain fact about reachability, not a finding, and nothing
// downstream should render it as one.
function scopeOf(addresses, selfTailscaleIps) {
  const wildcard = addresses.some((a) => a === '*' || a === '0.0.0.0' || a === '::');
  if (wildcard) return 'all-interfaces';
  if (addresses.every(isLoopback)) return 'loopback';
  if (addresses.some((a) => selfTailscaleIps.has(a))) return 'tailscale';
  return 'specific';
}

function familiesFromNetstatProto(proto) {
  if (proto === 'tcp46') return ['IPv4', 'IPv6']; // one dual-stack socket, both families
  if (proto === 'tcp6') return ['IPv6'];
  if (proto === 'tcp4') return ['IPv4'];
  return [];
}

function isLoopback(a) {
  return a === '::1' || a === 'localhost' || a.startsWith('127.');
}

function summarise(listeners, lsof, netstat) {
  return {
    total: listeners.length,
    identified: listeners.filter((l) => l.processes.length > 0).length,
    unidentified: listeners.filter((l) => l.unidentified).map((l) => l.port),
    knownServices: Object.fromEntries(
      listeners.filter((l) => l.known).map((l) => [l.port, l.known]),
    ),
    // A registry entry with nothing behind it means that app simply isn't
    // running right now. That's the other half of "what's listening on 4400?" —
    // being able to say "nothing, that port belongs to your wiki" beats a blank.
    // Not a fault: most of these are on-demand apps that are usually down.
    knownButNotListening: Object.entries(KNOWN_PORTS)
      .filter(([port]) => !listeners.some((l) => l.port === Number(port)))
      .map(([port, name]) => ({ port: Number(port), name })),
    byScope: {
      loopback: listeners.filter((l) => l.scope === 'loopback').length,
      tailscale: listeners.filter((l) => l.scope === 'tailscale').length,
      allInterfaces: listeners.filter((l) => l.scope === 'all-interfaces').length,
      specific: listeners.filter((l) => l.scope === 'specific').length,
    },
    // Named so a reader can tell "lsof was blind here" from "lsof failed".
    lsofSawOnlyOwnUser: lsof.ok,
    netstatAvailable: netstat.ok,
  };
}

// ---------------------------------------------------------------------------
// Tailscale
// ---------------------------------------------------------------------------

// Absolute path first: tailscale.app installs the CLI at /usr/local/bin, which
// run.mjs's PATH patch does cover, but naming it directly makes the failure mode
// unambiguous (ENOENT means "not installed", not "PATH was wrong under launchd").
const TAILSCALE_BIN = '/usr/local/bin/tailscale';

async function tailscaleStatus() {
  const res = await runJson(TAILSCALE_BIN, ['status', '--json'], { timeoutMs: 5_000 });

  // Logged out, or the daemon stopped: tailscale still prints a valid status
  // JSON (BackendState "NeedsLogin" / "Stopped") but exits non-zero, so runJson
  // hands back ok:false with json null. The body is the answer, so reparse it.
  let json = res.json;
  if (!json && res.stdout.trim().startsWith('{')) {
    try {
      json = JSON.parse(res.stdout);
    } catch {
      json = null;
    }
  }

  if (!json) {
    return {
      ok: false,
      error: res.error ?? 'no status JSON',
      installed: res.error !== 'not installed (command not found)',
      backendState: null,
      self: null,
      peers: [],
    };
  }

  // Deliberately not the raw blob. The full status is 5.6 KB of node keys,
  // allowed-IP CIDRs, handshake timestamps and peer-relay internals, none of
  // which helps answer a question about this Mac — and the snapshot is prompt
  // context (PLAN.md), so every field has to earn its tokens.
  return {
    ok: true,
    error: null,
    installed: true,
    backendState: json.BackendState ?? null,
    // "Running" is the only state where the tailnet actually carries traffic;
    // NeedsLogin/Stopped mean every Tailscale-only service is unreachable, which
    // is the real-world symptom worth surfacing.
    connected: json.BackendState === 'Running',
    version: json.Version ?? null,
    tailnet: json.CurrentTailnet?.Name ?? null,
    magicDnsSuffix: json.CurrentTailnet?.MagicDNSSuffix ?? null,
    self: json.Self
      ? {
          hostName: json.Self.HostName ?? null,
          dnsName: json.Self.DNSName ?? null,
          os: json.Self.OS ?? null,
          online: json.Self.Online ?? null,
          tailscaleIPs: json.Self.TailscaleIPs ?? [],
        }
      : null,
    // Empty array is the healthy case — tailscale only populates this with
    // active warnings.
    health: json.Health ?? [],
    peers: Object.values(json.Peer ?? {})
      .map((p) => ({
        hostName: p.HostName ?? null,
        os: p.OS ?? null,
        online: p.Online ?? false,
        tailscaleIPs: p.TailscaleIPs ?? [],
      }))
      .sort((a, b) => Number(b.online) - Number(a.online)),
  };
}

// ---------------------------------------------------------------------------

// Both tools glue host and port together with a separator the host itself may
// contain (IPv6 is all colons; netstat's separator is a dot but IPv6 hosts get
// abbreviated with dots too), so the split is always on the LAST occurrence.
function splitHostPort(text, separator) {
  const idx = text.lastIndexOf(separator);
  if (idx < 0) return null;
  const port = Number(text.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  // lsof brackets IPv6 hosts ([::1]:5050); netstat doesn't. Normalise so the
  // same address from both sources merges instead of appearing twice.
  const host = text.slice(0, idx).replace(/^\[(.*)\]$/, '$1');
  return { host, port };
}

// The scan itself, shared by the CLI and the web UI so there is exactly one
// definition of what a snapshot is. The UI's "rescan" button and `deckhand
// scan` must never drift apart.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { hostname, release } from 'node:os';

import { timed } from './run.mjs';
import { collectHardware } from './collectors/hardware.mjs';
import { collectMemory } from './collectors/memory.mjs';
import { collectProcesses } from './collectors/processes.mjs';
import { collectNetwork } from './collectors/network.mjs';
import { collectInstalled } from './collectors/installed.mjs';
import { collectAutostart } from './collectors/autostart.mjs';
import { collectDisk } from './collectors/disk.mjs';

export const SCHEMA_VERSION = 1;

export function collectors({ refreshHardware = false } = {}) {
  return [
    // Hardware is cached and near-free; it leads so the snapshot always opens
    // with what the machine *is* before what it's currently doing.
    ['hardware', () => collectHardware({ refresh: refreshHardware })],
    ['memory', collectMemory],
    ['processes', collectProcesses],
    ['network', collectNetwork],
    ['installed', collectInstalled],
    ['autostart', collectAutostart],
    ['disk', collectDisk],
  ];
}

export async function runScan(snapshotPath, { only = null, refreshHardware = false } = {}) {
  const started = Date.now();

  // Collectors are independent by contract, so they run concurrently and each
  // one's failure is recorded as data rather than thrown. The <30 s budget in
  // PLAN.md is wall-clock for the whole set, not a sum.
  const registry = collectors({ refreshHardware }).filter(([name]) => !only || name === only);
  const results = await Promise.all(registry.map(([name, fn]) => timed(name, fn)));

  const snapshot = {
    schema: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    host: { hostname: hostname(), platform: process.platform, release: release() },
    durationMs: Date.now() - started,
    collectors: Object.fromEntries(
      results.map((r) => [r.name, { ok: r.ok, ms: r.ms, error: r.error }]),
    ),
    ...Object.fromEntries(results.map((r) => [r.name, r.value])),
  };

  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  return {
    snapshot,
    results,
    bytes: Buffer.byteLength(JSON.stringify(snapshot)),
    durationMs: snapshot.durationMs,
  };
}

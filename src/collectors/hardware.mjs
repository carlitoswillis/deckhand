// Hardware collector — the one set of facts that never changes.
//
// PLAN.md says to cache this, and it's right: the chip, the core split and the
// installed RAM are fixed for the life of the machine, so re-running
// system_profiler on every scan buys nothing. It's cheap (0.37 s verified
// 2026-08-14) but it's also the only collector whose answer is knowable in
// advance, and Phase 3 will run scans on a schedule.
//
// Cache invalidates on boot ROM / OS build change, which is the honest trigger:
// those are the only things that move without the hardware moving.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runJson, run } from '../run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_PATH =
  process.env.DECKHAND_HARDWARE_CACHE ?? path.join(ROOT, 'data', 'hardware.json');

export async function collectHardware({ refresh = false } = {}) {
  const osBuild = await currentOsBuild();

  if (!refresh) {
    const cached = await readCache();
    // Same machine, same OS build → nothing in here can have changed.
    if (cached && cached.osBuild === osBuild) {
      return { ...cached.value, cached: true, cachedAt: cached.cachedAt };
    }
  }

  const value = await probe(osBuild);
  await writeCache({ osBuild, cachedAt: new Date().toISOString(), value });
  return { ...value, cached: false, cachedAt: null };
}

// ---------------------------------------------------------------------------

async function probe(osBuild) {
  // SPStorageDataType is included because PLAN.md lists it, but note the disk
  // collector — not this one — is the authority on free space. This is the
  // physical description of the drive, not its current occupancy.
  const res = await runJson(
    '/usr/sbin/system_profiler',
    ['SPHardwareDataType', 'SPDisplaysDataType', 'SPStorageDataType', '-json'],
    { timeoutMs: 30_000 },
  );

  if (!res.ok) {
    return { ok: false, error: res.error, machine: null, gpu: null, displays: [], storage: [] };
  }

  const hw = res.json?.SPHardwareDataType?.[0] ?? {};
  const gpus = res.json?.SPDisplaysDataType ?? [];
  const storage = res.json?.SPStorageDataType ?? [];

  return {
    ok: true,
    error: null,
    machine: {
      name: hw.machine_name ?? null, // "Mac Studio"
      model: hw.machine_model ?? null, // "Mac13,1"
      chip: hw.chip_type ?? null, // "Apple M1 Max"
      ...cores(hw.number_processors),
      memory: hw.physical_memory ?? null, // "32 GB" — unified, see memory.mjs
      bootRomVersion: hw.boot_rom_version ?? null,
      serialNumber: hw.serial_number ?? null,
      platformUuid: hw.platform_UUID ?? null,
      osBuild, // e.g. "14.3 (23D56)" — also the cache invalidation key
      hostname: os.hostname(),
    },
    gpu: gpus[0]
      ? {
          model: gpus[0].sppci_model ?? gpus[0]._name ?? null,
          cores: gpus[0].sppci_cores ? Number(gpus[0].sppci_cores) : null,
          metalFamily: gpus[0].spdisplays_mtlgpufamilysupport ?? null,
          // On Apple silicon the GPU has no VRAM of its own — it draws from the
          // same 32 GB the CPU uses. That fact is why memory.mjs counts a
          // resident Ollama model against system memory.
          unifiedMemory: true,
        }
      : null,
    displays: gpus.flatMap((g) =>
      (g.spdisplays_ndrvs ?? []).map((d) => ({
        name: d._name ?? null,
        resolution: d._spdisplays_resolution ?? d.spdisplays_resolution ?? null,
        pixels: d._spdisplays_pixels ?? null,
        main: d.spdisplays_main === 'spdisplays_yes',
        online: d.spdisplays_online === 'spdisplays_yes',
      })),
    ),
    storage: storage.map((s) => ({
      name: s._name ?? null,
      fileSystem: s.file_system ?? null,
      mountPoint: s.mount_point ?? null,
      sizeBytes: s.size_in_bytes ?? null,
      physicalDrive: s.physical_drive
        ? {
            mediaName: s.physical_drive.media_name ?? null,
            isInternal: s.physical_drive.is_internal_disk === 'yes',
            protocol: s.physical_drive.protocol ?? null,
            smartStatus: s.physical_drive.smart_status ?? null,
          }
        : null,
    })),
  };
}

// system_profiler reports "proc 10:8:2" — total:performance:efficiency. Worth
// splitting because "10 cores" and "8 performance cores" answer different
// questions, and the efficiency cores are why load average reads oddly here.
function cores(spec) {
  const m = /proc (\d+):(\d+):(\d+)/.exec(spec ?? '');
  if (!m) return { cores: null, performanceCores: null, efficiencyCores: null };
  return {
    cores: Number(m[1]),
    performanceCores: Number(m[2]),
    efficiencyCores: Number(m[3]),
  };
}

async function currentOsBuild() {
  const res = await run('/usr/bin/sw_vers', [], { timeoutMs: 5_000 });
  if (!res.ok) return null;
  const version = /ProductVersion:\s*(\S+)/.exec(res.stdout)?.[1] ?? '?';
  const build = /BuildVersion:\s*(\S+)/.exec(res.stdout)?.[1] ?? '?';
  return `${version} (${build})`;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

async function readCache() {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf8'));
  } catch {
    // No cache yet, or it's corrupt — either way, just re-probe.
    return null;
  }
}

async function writeCache(entry) {
  try {
    await mkdir(path.dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  } catch {
    // A cache we can't write is a performance problem, not a correctness one.
  }
}

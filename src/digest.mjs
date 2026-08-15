// Snapshot → prompt-sized digest.
//
// PLAN.md's Phase 2 assumes the snapshot is "small enough (tens of KB) to inject
// wholesale — no RAG machinery needed at first". Measured 2026-08-14 it is
// 177 KB / ~45,000 tokens, against an OLLAMA_CONTEXT_LENGTH of 16384. So it
// doesn't fit, by about 3x, and something has to give.
//
// What gives is fidelity in the prompt, NOT fidelity on disk. The snapshot stays
// complete — it's the record, and Phase 3's deltas need every field. This module
// renders a lossy view of it for the model.
//
// Two ideas do the work:
//
//   1. A compact CORE that is always present: the machine, the headline numbers,
//      what's running. ~1,200 tokens. Most questions are answerable from it
//      alone.
//   2. Question-aware SECTIONS. "what's eating my disk" pulls the directory
//      breakdown and the big-file list; "which apps haven't I opened" pulls the
//      app list. Only what the question implicates gets spent.
//
// That is retrieval, but keyword-shaped rather than embedding-shaped — which is
// the right amount of machinery for seven known sections with stable
// vocabulary. If it ever needs to be smarter, the seam is `sectionsFor()`.
//
// Output is text, not JSON. Same facts cost roughly 40% fewer tokens without
// the braces and quotes, and a local 14B reads prose tables at least as well.

const GIB = 1024 ** 3;

// Keyword → section. Deliberately generous: a false positive costs tokens, a
// false negative costs a wrong answer, and the budget has room for the former.
const SECTION_TRIGGERS = {
  disk: /disk|space|storage|full|big|large|file|folder|director|clean|delete|free up|gb|size|download|cache|zip|backup/i,
  // The app names are here because "can I run X at the same time" is a memory
  // question — heavyweight creative and build tools are the usual X.
  memory: /memory|ram|swap|pressure|leak|ollama|model|qwen|llm|load the|afford|gb|unified|daw|ableton|logic pro|reaper|blender|premiere|xcode|docker/i,
  processes: /process|cpu|fan|hot|slow|busy|load|running|pm2|launchd|daemon|service|hog/i,
  network: /port|listen|network|tailscale|serve|localhost|url|reach|connect|down|up|\b\d{4,5}\b/i,
  // \d+b catches "the 14B" / "7b", which is how anyone actually refers to a
  // model and matches none of the other words here.
  installed: /app|install|brew|homebrew|npm|package|outdated|update|version|open|used|stale|ollama|model|qwen|gemma|\b\d+b\b/i,
  autostart: /startup|start|boot|login|autostart|launchagent|launchd|orphan|plist|resurrect/i,
};

/**
 * @param {object} snapshot   parsed snapshot.json
 * @param {object} [opts]
 * @param {string} [opts.question]     drives which sections are included
 * @param {string[]} [opts.sections]   force specific sections
 * @param {number} [opts.maxTokens]    approximate ceiling for the whole digest
 */
export function buildDigest(snapshot, { question = '', sections, maxTokens = 7000 } = {}) {
  const wanted = sections ?? sectionsFor(question);

  const parts = [core(snapshot)];
  const included = [];

  for (const name of wanted) {
    const render = SECTIONS[name];
    if (!render) continue;
    const text = render(snapshot);
    if (!text) continue;

    // Stop before blowing the window rather than after. A digest that overflows
    // gets silently truncated by the server mid-fact, which is worse than one
    // that's honestly short — the model would answer from half a table.
    const projected = estimateTokens([...parts, text].join('\n\n'));
    if (projected > maxTokens) break;

    parts.push(text);
    included.push(name);
  }

  const text = parts.join('\n\n');

  return {
    text,
    sections: included,
    approxTokens: estimateTokens(text),
    // So a caller can tell the difference between "nothing to say" and
    // "wouldn't fit".
    dropped: wanted.filter((s) => !included.includes(s)),
  };
}

export function sectionsFor(question) {
  const hits = Object.entries(SECTION_TRIGGERS)
    .filter(([, re]) => re.test(question))
    .map(([name]) => name);

  // No keyword match usually means a broad question ("how's my Mac doing?"),
  // where the honest response is a wide but shallow view rather than a guess at
  // one section.
  return hits.length ? hits : ['disk', 'memory', 'processes'];
}

// Roughly 4 chars/token for English prose with numbers. Good enough to budget
// against; the cost of being wrong is a slightly short digest, not a failure.
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Core — always included
// ---------------------------------------------------------------------------

function core(s) {
  const lines = ['# This Mac, right now', `Snapshot taken ${s.capturedAt}.`];

  const mc = s.hardware?.machine;
  if (mc) {
    lines.push(
      `Machine: ${mc.name}, ${mc.chip}, ${mc.cores} cores (${mc.performanceCores} performance / ${mc.efficiencyCores} efficiency)` +
        `${s.hardware.gpu?.cores ? `, ${s.hardware.gpu.cores}-core GPU` : ''}, ${mc.memory} unified memory, macOS ${mc.osBuild}.`,
    );
    // Stated explicitly because it is the single fact most likely to make the
    // model reason wrongly about memory if it assumes a discrete GPU.
    lines.push('Memory is UNIFIED: the GPU allocates from the same pool as the CPU, so a loaded LLM consumes system RAM.');
  }

  const m = s.memory;
  if (m?.headroom) {
    const h = m.headroom;
    lines.push(
      `Memory: ${h.availableGiB} GiB available of ${m.totalGiB} GiB, pressure ${h.pressureState}, ${h.freePercent}% free.` +
        (m.swap?.usedBytes ? ` Swap in use: ${gb(m.swap.usedBytes)} GiB.` : ' No swap in use.'),
    );
    if (h.pinnedByOllamaGiB > 0) {
      lines.push(
        `Ollama is holding ${h.pinnedByOllamaGiB} GiB and it is PINNED ON PURPOSE (OLLAMA_KEEP_ALIVE=-1, to avoid a 21 s model warmup).` +
          ` Releasing it would give back ${h.availableIfUnpinnedGiB} GiB total. This is a deliberate tradeoff, not a leak or a fault.`,
      );
    } else if (m.ollama?.reachable) {
      lines.push(
        `Ollama is running with no model resident (keep_alive=${m.ollama.keepAlive ?? 'default'}, policy "${m.ollama.keepAlivePolicy}").` +
          ` Loading a model will consume its size in unified memory.`,
      );
    }
  }

  const d = s.disk?.headline;
  if (d) {
    lines.push(
      `Disk: ${gb(d.usedBytes)} GiB used of ${gb(d.totalBytes)} GiB, ${d.capacityPercent}% full, ${gb(d.availableBytes)} GiB free (volume ${d.volume}).` +
        ` NOTE: "df /" reports the sealed system snapshot at ~21% and is misleading; the figure here is the volume that actually fills.`,
    );
  }

  const p = s.processes;
  if (p?.load?.ok) {
    lines.push(
      `CPU load: ${p.load.one} (1m) / ${p.load.five} (5m) / ${p.load.fifteen} (15m) across ${p.load.cores} cores = ${p.load.perCore} per core, ${p.load.trend}.`,
    );
  }
  if (p?.pm2?.installed) {
    lines.push(
      `pm2 is running ${p.pm2.count} services: ${p.pm2.processes.map((x) => `${x.name} (${x.status})`).join(', ')}.`,
    );
  }

  const n = s.network;
  if (n?.summary) {
    const named = n.listeners.filter((l) => l.known);
    lines.push(
      `Ports: ${n.summary.total} listening.` +
        (named.length ? ` Known: ${named.map((l) => `${l.port}=${l.known}`).join(', ')}.` : '') +
        (n.summary.knownButNotListening?.length
          ? ` Known but NOT running: ${n.summary.knownButNotListening.map((k) => `${k.port}=${k.name}`).join(', ')}.`
          : ''),
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sections — included only when the question implicates them
// ---------------------------------------------------------------------------

const SECTIONS = {
  disk(s) {
    const d = s.disk;
    if (!d) return null;
    const lines = ['## Disk detail'];

    const dirs = d.topDirs?.filter((t) => t.totalBytes) ?? [];
    if (dirs.length) {
      lines.push('Directory sizes (a whitelist — ~/Library is deliberately not walked, it costs 199 s):');
      for (const dir of dirs) {
        const kids = (dir.children ?? [])
          .slice(0, 5)
          .map((c) => `${c.name} ${gb(c.bytes)} GiB`)
          .join(', ');
        lines.push(`- ${dir.label}: ${gb(dir.totalBytes)} GiB${kids ? ` (biggest inside: ${kids})` : ''}`);
      }
    }

    const heavy = d.heavyDirs;
    if (heavy?.dirs?.length) {
      lines.push(
        `\nRegenerable build/dependency dirs total ${gb(heavy.totalBytes)} GiB across ${heavy.dirs.length} dirs ` +
          `(deleting these costs a rebuild, not data): ` +
          heavy.dirs.slice(0, 10).map((x) => `${x.project}/${x.kind} ${gb(x.bytes)} GiB`).join(', ') + '.',
      );
    }

    const big = d.bigFiles?.files ?? [];
    if (big.length) {
      lines.push('\nBiggest files:');
      for (const f of big.slice(0, 15)) lines.push(`- ${gb(f.bytes)} GiB  ${f.path}`);
    }

    const c = d.cleanupCandidates;
    if (c?.staleFiles?.length) {
      lines.push(
        `\nCleanup candidates (archives/backups/installers), ${gb(c.staleFilesBytes)} GiB across ${c.staleFiles.length} files:`,
      );
      for (const f of c.staleFiles.slice(0, 12)) {
        lines.push(`- ${gb(f.bytes)} GiB  ${f.path}  (${f.why}, last modified ${f.modifiedAt?.slice(0, 10)})`);
      }
      lines.push('deckhand NEVER deletes. Suggest the exact command and let the user run it.');
    }

    return lines.join('\n');
  },

  memory(s) {
    const m = s.memory;
    if (!m) return null;
    const lines = ['## Memory detail'];

    const v = m.vmstat;
    if (v?.ok) {
      lines.push(
        `Breakdown: ${gb(v.activeBytes)} GiB active, ${gb(v.inactiveBytes)} GiB inactive, ${gb(v.wiredBytes)} GiB wired, ` +
          `${gb(v.compressedBytes)} GiB compressed. Swapouts since boot: ${v.swapoutsSinceBoot}.`,
      );
    }

    const hogs = m.topProcesses?.processes ?? [];
    if (hogs.length) {
      lines.push('\nBiggest memory users right now:');
      for (const p of hogs.slice(0, 12)) lines.push(`- ${gb(p.rssBytes)} GiB  ${p.command} (pid ${p.pid})`);
    }

    if (m.ollama?.loadedModels?.length) {
      lines.push('\nModels currently resident in unified memory:');
      for (const x of m.ollama.loadedModels) {
        lines.push(
          `- ${x.name}: ${gb(x.vramBytes)} GiB, context ${x.contextLength}, ${x.quantization}, ${x.pinned ? 'PINNED (never unloads)' : `expires ${x.expiresAt}`}`,
        );
      }
    }
    // Sizes of models that COULD be loaded belong in the memory section, not
    // just the installed one. "Can I afford to load the 14B and run a DAW?"
    // is a memory question, and without these figures a model will guess the
    // size from the name — verified 2026-08-14, qwen answered "around 14 GiB"
    // for a model that is actually 8.99 GiB, and drew the opposite conclusion
    // to the correct one.
    const available = s.installed?.ollamaModels?.models ?? [];
    if (available.length) {
      lines.push(
        '\nModels available to load, with the memory each would claim (a model not currently resident costs its full size when loaded):',
      );
      for (const x of available) {
        lines.push(`- ${x.name}: ${gb(x.sizeBytes)} GiB on disk${x.parameterSize ? ` (${x.parameterSize}, ${x.quantization})` : ''}`);
      }
      lines.push(
        'Each line above is ONE model, and only one needs to be loaded at a time — do NOT add these figures together. ' +
          'The cost of loading a model is that single model\'s size, not the total of the list.',
      );
      // Every figure in this digest is GiB (1024-based). ollama's own `sizeGB`
      // field is decimal GB, so quoting it here would put "8.99" next to
      // "8.37" for the same model and invite the reader to pick either.
      lines.push(
        'Resident cost runs somewhat above the on-disk size once the KV cache for the configured context is added — ' +
          'measured on this Mac, the 14B occupied 10.76 GiB resident against 8.37 GiB on disk at a 16384 context.',
      );
    }

    if (m.ollama?.env) {
      lines.push(`Ollama server settings: ${Object.entries(m.ollama.env).map(([k, val]) => `${k}=${val}`).join(', ')}.`);
    }

    return lines.join('\n');
  },

  processes(s) {
    const p = s.processes;
    if (!p) return null;
    const lines = ['## Processes'];

    const busy = p.processes?.topByCpu ?? [];
    if (busy.length) {
      // The caveat travels WITH the data. Without it a model will happily
      // report a lifetime average as "currently pegging your CPU".
      lines.push(
        `Busiest processes by CPU. IMPORTANT: ps reports a LIFETIME AVERAGE since each process started, ` +
          `not a current sample — a high number here means "has been busy over its life", not "is busy this second":`,
      );
      for (const x of busy.slice(0, 12)) {
        lines.push(`- ${x.cpuPercent}% avg, ${gb(x.rssBytes)} GiB, up ${x.elapsed}  ${x.command} (pid ${x.pid})`);
      }
    }

    if (p.pm2?.processes?.length) {
      lines.push('\npm2 services:');
      for (const x of p.pm2.processes) {
        lines.push(
          `- ${x.name}: ${x.status}, pid ${x.pid}, ${x.restarts} restarts, ${gb(x.memoryBytes)} GiB, ${x.execPath}`,
        );
      }
    }

    const l = p.launchd;
    if (l?.ok) {
      lines.push(
        `\nlaunchd: ${l.running} running of ${l.total}. ${l.failingCount} report a nonzero status — but launchd reports a ` +
          `NEGATED SIGNAL NUMBER for killed jobs, so -15 means SIGTERM (a clean stop) and is not a crash.`,
      );
      if (l.failing?.length) {
        for (const f of l.failing.slice(0, 10)) lines.push(`- ${f.label}: status ${f.status} (${f.reason})`);
      }
    }

    return lines.join('\n');
  },

  network(s) {
    const n = s.network;
    if (!n) return null;
    const lines = ['## Network / ports'];

    lines.push('Listening ports (lsof for names, netstat for completeness — lsof only sees your own processes):');
    for (const l of n.listeners ?? []) {
      const who = l.processes?.length ? l.processes.map((x) => `${x.command} pid ${x.pid}`).join(', ') : 'owner unknown (likely root)';
      lines.push(`- ${l.port}${l.known ? ` (${l.known})` : ''}: ${who}, scope ${l.scope}, seen by ${l.seenBy}`);
    }
    lines.push(
      'Scope is about reachability, NOT security: Tailscale here is a convenience for viewing local apps remotely, ' +
        'not a boundary. Do not describe an all-interfaces bind as exposure or a risk.',
    );

    const t = n.tailscale;
    if (t?.installed) {
      lines.push(
        `\nTailscale: ${t.backendState}, this machine is ${t.self?.hostName} (${t.self?.tailscaleIPs?.join(', ')}), ` +
          `${t.peers?.length ?? 0} peers${t.peers?.length ? `: ${t.peers.map((p) => `${p.hostName} (${p.online ? 'online' : 'offline'})`).join(', ')}` : ''}.`,
      );
    }

    return lines.join('\n');
  },

  installed(s) {
    const i = s.installed;
    if (!i) return null;
    const lines = ['## Installed software'];

    lines.push(
      `${i.apps.count} apps, ${i.homebrew.formulae?.count ?? 0} brew formulae (${i.homebrew.outdated?.count ?? 0} outdated), ` +
        `${i.npmGlobal.count} npm globals, ${i.ollamaModels.count} ollama models.`,
    );

    if (i.ollamaModels?.models?.length) {
      lines.push(
        `Models, individually: ${i.ollamaModels.models.map((m) => `${m.name} ${gb(m.sizeBytes)} GiB`).join(', ')}.`,
      );
      // The combined figure is stated LAST and explicitly disclaimed. Both a
      // local 7B and gemini-flash-lite reached for 14.25 GiB as "the cost of
      // loading the 14B" when it was introduced as a total (verified
      // 2026-08-14) — an inviting number next to a question about one model is
      // a trap, so it gets labelled as disk-only and non-loadable.
      lines.push(
        `Combined size of all ${i.ollamaModels.count} model files on disk: ${gb(i.ollamaModels.totalBytes)} GiB. ` +
          `This total is a DISK figure only. It is never the cost of loading a model — only one model loads at a time, ` +
          `and it costs its own size, not this sum.`,
      );
    }

    const sure = (i.staleApps ?? []).filter((a) => a.confident);
    const unsure = (i.staleApps ?? []).filter((a) => !a.confident);
    if (sure.length) {
      lines.push('\nApps genuinely not opened in over a year (real last-opened date from Spotlight):');
      for (const a of sure) lines.push(`- ${a.name}: last opened ${a.lastUsedAt?.slice(0, 10)}, ${a.daysSinceUsed} days ago`);
    }
    if (unsure.length) {
      // The distinction that keeps this honest — see installed.mjs.
      lines.push(
        `\n${unsure.length} further apps LOOK old but only have a file-modification date, which answers "not updated in a year", ` +
          `NOT "not opened in a year". Do not claim these went unused: ` +
          unsure.slice(0, 12).map((a) => a.name).join(', ') + '.',
      );
    }

    const out = i.homebrew?.outdated?.formulae ?? [];
    if (out.length) {
      lines.push(`\nOutdated brew formulae (${out.length}): ` + out.slice(0, 30).map((f) => f.name).join(', ') + '.');
    }

    if (i.npmGlobal?.installs?.length) {
      lines.push(
        '\nnpm globals are per-prefix and this Mac has more than one npm: ' +
          i.npmGlobal.installs
            .map((inst) => `${inst.prefix} → ${inst.items.map((x) => x.name).join(', ') || 'none'}`)
            .join(' | ') + '.',
      );
    }

    return lines.join('\n');
  },

  autostart(s) {
    const a = s.autostart;
    if (!a) return null;
    const lines = ['## Autostart surface'];

    lines.push(
      `${a.plists.count} plists on disk. ${a.orphaned.length} orphaned (present but launchd has never loaded them), ` +
        `${a.failing.length} with a nonzero exit status, ${a.unobservable.count} system daemons whose state cannot be ` +
        `checked without sudo (deckhand does not sudo, so their state is unknown — not "not loaded").`,
    );

    if (a.failing?.length) {
      lines.push('\nNonzero exit status:');
      for (const f of a.failing) {
        lines.push(`- ${f.label}: status ${f.exitStatus} (${f.reason ?? '?'})${f.likelyBroken ? ' — GENUINELY BROKEN' : ' — clean signal stop, not a crash'}`);
      }
    }

    if (a.orphaned?.length) {
      lines.push(`\nOrphaned: ${a.orphaned.map((o) => o.label).join(', ')}.`);
    }
    if (a.stalePlists?.length) {
      lines.push(
        `\nInert files that can never load (launchd only reads *.plist): ` +
          a.stalePlists.map((p) => `${p.file} (${p.reason})`).join(', ') + '.',
      );
    }
    if (a.loginItems?.ok) {
      lines.push(
        `\nLogin items: ${a.loginItems.items.map((x) => x.name).join(', ') || 'none'}. ` +
          `(From the legacy store — membership only, no enabled/disabled state, and it may be stale.)`,
      );
    }
    if (a.pm2) {
      lines.push(`pm2 resurrect hook: ${a.pm2.installed ? `installed (${a.pm2.label})` : 'not installed'}.`);
    }

    return lines.join('\n');
  },
};

function gb(bytes) {
  if (bytes == null) return '?';
  return (bytes / GIB).toFixed(2);
}

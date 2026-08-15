# Deckhand — Backlog

Everything on this list came out of building and running Phases 1–2 against a
real Mac (2026-08-14), not from a generic feature brainstorm. Each item records
the evidence that motivated it, because the evidence is usually the argument.

Status: **Phases 1 and 2 done** — 7 collectors, ~8 s scan, `ask`/`fact`, three
providers, output checking, CLI + web UI. See `README.md`. The remaining phases
from the original plan — history, then suggestions — appear below as items 6, 7
and 16.

Priority is my recommendation, not a commitment. If only three get done, do
**8, 1, 6** — in that order, because tests make the other two safe to build.

---

## A. Blind spots — things it doesn't collect yet

### 1. `~/Library` is completely unmeasured — HIGH
The biggest hole in the disk story. It's excluded because `du` on it takes
**199 s** on its own, against a 30 s scan budget, so the whitelist walks around
it. But the single largest file on the machine this was built on lived there — an
application database at **14.49 GiB** — and it's where caches grow silently.

Ask "what's eating my disk" today and the truthful answer is "I didn't look in
the place most likely to be the answer."

*Approach:* not in the foreground scan. A slow background pass on its own
cadence, cached to `data/library.json` with its own timestamp, merged into the
snapshot as a separate (possibly stale) section. Phase 3's scheduler makes this
natural.

### 2. Application sizes — HIGH, nearly free
`/Applications` was measured at **67 GiB** (`du -sk`, 6.8 s) on the development
machine. Nothing in the snapshot knows this.

Two payoffs. It makes the original plan's flagship `fact` example — "your models
total more than every app in /Applications combined" — answerable at all. And
that example turned out to be **false where it was tested**: three ollama models
totalled 14.25 GiB against 67 GiB of apps, so apps won by ~4.7x. Deckhand would
correct the assumption rather than repeat it, which is exactly what `fact` is
for.

*Approach:* fold into the disk collector's concurrent walk. 6.8 s alongside an
existing 7.5 s walk is ~free in wall clock.

### 3. Backup status — HIGH, trivial
`tmutil destinationinfo` reports whether any Time Machine destination is
configured, and deckhand currently can't say either way. A tool that claims to
know every inch of the ship should know whether there's a lifeboat.

One command, no sudo, milliseconds.

### 4. Non-Data volumes are ignored — MEDIUM, trivial
The collector already captures every volume, but `show` and the digest lead with
`/System/Volumes/Data` only. Meanwhile:

```
/dev/diskNsN  16Gi  16Gi  460Mi  98%  /Library/Developer/CoreSimulator/Volumes/iOS_...
```

An iOS Simulator volume sitting at **98% full** is exactly the kind of thing you
want told. Surface any volume over ~90%, not just the main one.

### 5. Reclaimable space with real numbers — MEDIUM
`suggest` (item 16) is weak without exact figures. Worth collecting:
- `brew cleanup -n` — dry run, prints what it would free
- Docker's disk usage (`com.docker.docker` container exists here)
- Simulator runtimes and devices
- Trash size
- Xcode DerivedData (absent today, but it comes back)

All read-only. `brew` calls must keep `HOMEBREW_NO_AUTO_UPDATE=1` — see README.

---

## B. The time axis

### 6. History and deltas — HIGHEST VALUE, LARGEST JOB
Scheduled scans, stored, so answers gain a time axis: "what appeared since
Tuesday", "disk shrank 40 GB — what happened", "this process wasn't here last
week". It also makes `fact` substantially better, since the genuinely
non-obvious observations are usually *changes*, not states.

*Design notes already settled:*
- **`node:sqlite` ships with Node 22** (verified: `DatabaseSync`, `StatementSync`
  available), so history stays zero-dependency. It emits an experimental warning.
- **Do not store whole snapshots.** One snapshot is 288 KB → daily is 63 MB/yr
  (fine), hourly is 1.5 GB/yr (not fine). Store slim derived rows — the headline
  numbers per scan — plus deltas of what changed, and keep the last N full
  snapshots only.
- Scheduling belongs with pm2 or a LaunchAgent (item 15), not an in-process timer.

### 7. Trend-aware answers — MEDIUM (depends on 6)
Today "do I have enough disk to last the year?" is correctly *refused* — Gemini
said the consumption rate "is not available in the provided data", which was the
right call. With history it becomes answerable with an actual rate. Refusing
honestly is good; answering correctly is better.

---

## C. Trust — making it verifiably truthful

### 8. There are no tests — HIGH, LOW EFFORT
Zero tests across ~4,900 lines. This is the highest value-per-hour item here.

The motivating bug: `digest.mjs` read `installed.ollamaModels.items` when the
field is `.models`. Optional chaining meant it rendered *nothing* instead of
throwing, so model sizes were silently absent from every prompt — and the local
model, having never been shown a size, guessed one. I spent a real stretch
blaming qwen for arithmetic failures that were my bug. Nothing was "broken";
it just quietly did less.

*Approach (use `node:test`, built in, still zero-dep):*
- **Field-contract test** — every `s.<path>` the digest reads must resolve
  against a real snapshot. A scratch version of this already exists and would
  have caught the bug instantly.
- **Section render test** — each digest section renders non-trivially; flag
  suspiciously short output.
- **Checker unit tests** — the known-good and known-bad answers from
  development, as fixtures.
- **UI render test** — run the page's `render()` against a real snapshot with
  DOM stubs; assert no `undefined`/`NaN` in the output. Also exists as a scratch
  script.
- **Collector shape tests** against a committed fixture snapshot, so collectors
  can be refactored without silently changing the contract.

### 9. The output check only catches wrong numbers — MEDIUM
`checkNumbers` verifies that every quantity is quoted from the facts or derives
from them, and `checkComparisons` catches false comparisons (it caught
"14.25 GiB is larger than 32 GiB"). Neither catches a wrong *word*.

Live failure: asked what was listening on a given port, the model named the
service registered to a *different* port. Every figure in the sentence was
correct. Fixed with a persona rule, but it should be mechanical: verify quoted
identifier→name pairs against the facts.

### 10. Ollama's memory figure doesn't reconcile — MEDIUM
It reported **16.19 GiB resident** while `active` was 10.54 GiB and `wired` only
2.52 GiB, so it isn't wholly inside either bucket — `size_vram` appears to be
what ollama claims rather than what the kernel currently backs. The UI honestly
reports it on its own line instead of drawing it as a slice of a bar it doesn't
belong to, but "we don't know where this lives" is a placeholder, not an answer.

*Approach:* read the actual RSS of the ollama runner subprocesses and compare.

### 11. Spotlight's index is incomplete — LOW
`mdfind` missed a ~400 MB archive in the workspace entirely — the exact kind of
file the cleanup pass exists to find. Handled by also running a real `find` over `~/workspace`
and recording `disk.bigFiles.missedBySpotlight`. The gap is known and bounded;
worth revisiting only if the miss rate grows.

### 12. Half of app "last opened" dates aren't real — LOW
Only 67 of 128 apps have a true `kMDItemLastUsedDate`; the rest fall back to
bundle mtime, which answers "not *updated* in a year", a different question.
Entries carry `confident: true|false` and the confident ones sort first, so this
is handled — but 27 apps remain genuinely unknowable this way. A usage-tracking
source would be needed to do better, and probably isn't worth it.

---

## D. Reach and interface

### 13. UI doesn't refresh itself — LOW, easy
It shows "snapshot 30m ago" and ages the label live, but never rescans. Options:
poll and auto-rescan past a staleness threshold, or just make the staleness
visually louder.

### 14. Shareable HTML report — LOW
A point-in-time "state of the ship" you can keep or send, distinct from the live
UI. Natural fit for an artifact.

### 15. Run as a service — MEDIUM (pairs with 6)
`serve` dies with the terminal. pm2 is the house pattern and the resurrect hook
is already installed (`pm2.<user>.plist`). Needed anyway once scans are
scheduled.

### 16. `suggest` — MEDIUM (better after 5 and 6)
The pieces exist: `cleanupCandidates` finds stale archives, `heavyDirs`
finds regenerable build output, and `autostart` finds orphaned plists and jobs
that exited nonzero. What's missing is
exact reclaim figures (item 5) and "has this been ignored for weeks" (item 6).

Guardrail is non-negotiable: printed commands, never executed. Paths must be
single-quoted — an early version emitted unquoted `rm` lines for paths with
spaces and dashes.

### 17. One line into the assistant's morning brief — LOW
The module seam pays off here: the gateway reads the snapshot file directly, no
coupling. Deckhand explains; the assistant alerts. Don't duplicate alerting.

---

## E. Portability (only if this goes public)

### 18. Extract machine-specific config — PARTLY DONE
**Done:** the port registry now ships with well-known ports only and reads your
own service map from `deckhand.config.json` (gitignored, see
`deckhand.config.example.json`). Labelling a port with someone else's service
name was the worst kind of bug — not a missing feature but a confidently wrong
one that Phase 2 would repeat as prose.

**Still hardcoded:**

1. **`~/workspace`** — the disk whitelist and the entire node_modules sweep
   assume that directory name. Others use `~/code`, `~/dev`, `~/src`.
2. **The ollama unpin command** points at a custom LaunchAgent
   (`com.local.ollama.plist`). Most people use `brew services`.
3. **Unified memory is assumed.** On an Intel Mac the GPU has its own VRAM and
   the "free if unpinned" reasoning is simply wrong.

*Approach:* extend `deckhand.config.json`, which already exists for ports.

---

## F. Considered and rejected

- **Temperature / fan sensors.** `powermetrics` needs sudo. Deckhand asking for
  admin rights to read a number you can already hear breaks the read-only,
  no-privileges posture that the rest of the design depends on. This is the same
  reason `sfltool dumpbtm` was ripped out — it prompted for a password.
- **Duplicate-file detection.** Expensive over 380 GiB, and Spotlight's index is
  demonstrably incomplete here (item 11), so it would be both slow and wrong.
- **Alerting / watching.** A sibling project owns the system-health watcher. Deckhand is the thing you interrogate, not another thing that
  nags. The split: *the watcher alerts, deckhand explains.*
- **An `act` mode.** Read-only is the product, not a limitation to grow out of.

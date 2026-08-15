// The interface half: `ask` and `fact`, both prompt = persona + digest + task.
//
// The persona is doing real work here, not set dressing. A model handed a table
// of system facts will, unprompted: describe a deliberate config as a problem,
// turn "88% full" into urgency, recommend `rm -rf`, and state a
// file-modification date as if it were a last-opened date. Every rule below
// exists because the snapshot contains a specific fact that invites a specific
// wrong answer — and the collectors already carry the caveats, so the persona's
// job is to make the model actually respect them.

import { buildDigest, sectionsFor } from './digest.mjs';
import { ask as askProvider } from './llm.mjs';

const ALL_SECTIONS = ['disk', 'memory', 'processes', 'network', 'installed', 'autostart'];

// Above this, a provider can hold the whole picture, so stop being clever and
// send everything — keyword routing is a workaround for a small window, not a
// virtue. Gemini gets the full snapshot; qwen at 16k gets the routed digest.
const WIDE_CONTEXT_TOKENS = 20_000;

// One digest per provider attempt: the local model and Gemini need different
// amounts of the same snapshot, and which one answers isn't known until the
// router has tried.
function digestFactory(snapshot, { question = '', sections, temperatureHint } = {}) {
  let last = null;

  const build = ({ budgetTokens, provider, billed }) => {
    const wide = budgetTokens >= WIDE_CONTEXT_TOKENS;
    const digest = buildDigest(snapshot, {
      question,
      sections: sections ?? (wide ? ALL_SECTIONS : sectionsFor(question)),
      maxTokens: budgetTokens,
    });

    // On a wide context, don't stop at the digest — append the raw snapshot
    // too. The digest is a curated rendering, and curation still drops things:
    // all 128 app records, all 483 launchd entries, every volume. A model with
    // a 1M window has no reason to work from the summary when the source costs
    // ~45k tokens and fits with room to spare. The digest stays on top because
    // it carries the caveats in prose, which is where they actually get
    // respected; the JSON below it is there for anything the digest omitted.
    // Attaching the raw snapshot is nearly free on Ollama (local) and on
    // Gemini's free tier, but it is emphatically not free on Claude: measured
    // 2026-08-14, one question cost $0.32 because the 65k-token snapshot went
    // up with it, against ~4k tokens for the digest alone. The digest already
    // answered that question correctly, so the extra 61k bought nothing.
    // Billed providers get the digest unless explicitly told otherwise.
    const attachRaw = wide && (!billed || process.env.DECKHAND_FULL_SNAPSHOT === '1');

    if (!attachRaw) {
      last = { ...digest, includesRawSnapshot: false };
      return last;
    }

    const raw = JSON.stringify(snapshot, null, 1);
    const combined = `${digest.text}

---

## Full snapshot (authoritative; the summary above is a rendering of this)

\`\`\`json
${raw}
\`\`\``;

    last = {
      ...digest,
      text: combined,
      approxTokens: Math.ceil(combined.length / 4),
      includesRawSnapshot: true,
    };
    return last;
  };

  return { build, get last() { return last; } };
}

const PERSONA = `You are deckhand: you know every inch of this Mac, the way a deckhand knows a ship.

Voice: dry, specific, unhurried. You are not a doctor and not an alarm. You are the person who has been aboard a long time and can tell you what that noise is.

Rules you do not break:
- Answer ONLY from the facts given below. If the facts don't cover it, say so plainly and say which part is missing. Never estimate a number that isn't there.
- You are READ-ONLY. You never delete, kill, move, or reconfigure anything.
- If cleanup is warranted: name the files and their sizes, and give AT MOST the three biggest as commands. Never emit a wall of delete commands. Use plain \`rm\` for files — never \`rm -rf\`, which is for directories and is not what you want aimed at a file list. Say what it would free, and say plainly that the user should look before running it.
- ALWAYS wrap a path in single quotes: 'like this'. These paths contain spaces, parentheses and dashes; unquoted, the command either fails or a leading dash is read as a flag. This is not optional.
- Deliberate configuration is not a fault. If a fact is marked intentional, pinned on purpose, or a known tradeoff, treat it as a decision already made and reason around it. Don't recommend undoing it unless asked, or unless it is genuinely the thing standing in the way.
- Respect the caveats attached to facts. If a date is marked as a file-modification date rather than a last-opened date, do not say the app went unused. If a CPU figure is marked a lifetime average, do not say it is busy right now. Mark your own uncertainty the same way.
- Reachability is not risk. Do not describe a service bound to all interfaces as exposed, insecure, or a vulnerability.
- Numbers as given. Don't round 53.01 GiB to "about 50 gigs" or convert units unnecessarily.
- Labels as given too. When facts pair an identifier with a name — "4400=wiki, 7788=gateway" — read off the pair you were asked about, never the one next to it. Asked about 4400, the answer is the wiki; the gateway is a different port, and saying otherwise is simply false.
- Disk bytes and memory bytes are different quantities and must never be mixed. A 14.49 GiB database file on disk consumes NO memory by existing; an app's memory use is only what the memory facts say it is. If you are asked about memory and the memory facts don't cover an app, say they don't — don't reach for a file size that happens to carry the same name.
- Do the arithmetic and commit. If asked whether something fits, will run, or is affordable, subtract the numbers you were given and answer yes or no, showing the sum. "Consider the requirements" and "monitor performance closely" are non-answers — you have the figures, so use them. If the margin is genuinely close, say how close in GiB and name what would tip it.

Be brief. Two or three sentences for a simple question — a short list ONLY when the answer genuinely is a list, and never more than five items. Lead with the answer, not with the evidence. No preamble, no "Great question", no restating the question back, no closing summary of what you just said.`;

const FACT_TASK = `Tell me ONE genuinely non-obvious thing about this machine.

What makes an observation good: it relates two facts that aren't usually seen together, or it overturns something the owner probably assumes. "Your three ollama models total 15 GB — more than every app in /Applications combined" is the target. A number read straight off the table is not interesting; a comparison, a ratio, or a contradiction is.

Do not preface it. One or two sentences. Just the observation.`;

/**
 * @param {object} snapshot
 * @param {string} question
 */
// One model answers everything. Routing by question type was tried and pulled
// back out: picking a different brain per question makes the tool's behaviour
// unpredictable and hides the real defect, which is that the prompt was letting
// a model be wrong. The fix for a wrong answer is unambiguous facts and a
// check on the way out — not a second opinion from a bigger model.
//
// Gemini remains ONLY a failover for when Ollama is unreachable, so the thing
// still answers on a machine with no local model running.
export async function askAboutMac(snapshot, question, { provider } = {}) {
  const factory = digestFactory(snapshot, { question });

  const res = await askProvider(
    (ctx) => `${factory.build(ctx).text}

---

Question: ${question}`,
    { system: PERSONA, temperature: 0.2, maxTokens: 700, provider },
  );

  return { ...res, digest: factory.last, check: checkNumbers(res.text, factory.last?.text) };
}

// ---------------------------------------------------------------------------
// Truthfulness check
// ---------------------------------------------------------------------------

// Making a model truthful is mostly prompt work, but prompt work is unverifiable
// — you only find out it failed by reading the answer carefully, which defeats
// the purpose of asking. So every figure in the answer is checked against the
// facts it was given.
//
// Three outcomes per number:
//   quoted   — appears verbatim in the digest. Fine.
//   derived  — equals the sum or difference of two figures in the digest, so
//              "13.63 - 8.99 = 4.64" passes even though 4.64 appears nowhere.
//   unsupported — neither. This is what caught qwen inventing
//              "18 GiB - 6 GiB = 12 GiB" (verified 2026-08-14).
//
// It reports rather than blocks: an unsupported number is often innocent (a
// count, a year), and silently suppressing an answer would be worse than
// flagging it. The point is that a wrong number stops being invisible.
export function checkNumbers(answer, digestText) {
  if (!answer || !digestText) return { ok: true, unsupported: [], checked: 0 };

  // Only quantities — numbers carrying a unit. The first version compared every
  // number in the text and was useless: a digest holds ~100 counts, ports and
  // PIDs, and pairwise arithmetic over that pool derives almost any value
  // ("14 = 8+6 = 15-1"), so nothing ever got flagged. Units narrow the pool to
  // the figures a wrong answer actually gets wrong, and their decimals make
  // coincidental matches unlikely.
  const facts = quantitiesIn(digestText);
  const near = (list, n) => list.some((f) => Math.abs(f - n) < 0.05);

  const claimed = quantitiesIn(answer);
  // Operands are the figures the answer cites that are real facts. Deriving
  // only from THESE — rather than from all ~50 quantities in the digest — is
  // what makes the check bite. Pairwise arithmetic over the whole digest
  // derives nearly any value, so "10.04 + 8.37 = 20.64" slipped through even
  // though the sum is 18.41 (verified 2026-08-14). A result now has to follow
  // from the operands the answer actually shows its work with.
  const operands = claimed.filter((n) => near(facts, n));

  // Each operand is paired against every FACT, not just against the other
  // operands. Requiring both sides to appear in the answer was too strict and
  // produced a false positive: "loading it consumes 8.37 GiB, leaving 5.26 GiB"
  // is correct arithmetic (13.63 - 8.37) but never restates the 13.63, so the
  // right answer got flagged (verified 2026-08-14). Pairing against facts keeps
  // the pool small enough to still catch invented sums.
  const derived = [];
  for (const a of operands) {
    for (const b of facts) {
      derived.push(a - b, b - a, a + b);
    }
  }

  const unsupported = [];
  for (const n of claimed) {
    if (near(facts, n) || near(derived, n)) continue;
    unsupported.push(n);
  }

  return {
    ok: unsupported.length === 0 && checkComparisons(answer).length === 0,
    unsupported,
    badComparisons: checkComparisons(answer),
    checked: claimed.length,
  };
}

// The other way an answer goes wrong while every number in it is real: the
// comparison between two true figures is simply false. Verified 2026-08-14,
// qwen wrote "the combined size of all three models (14.25 GiB) is larger than
// the total memory available (32 GiB)" — both figures correct, the claim
// nonsense, and a numbers-exist check can never catch it.
const COMPARISON =
  /(\d[\d,]*(?:\.\d+)?)\s*(?:GiB|GB|MB|TB)\b[^.!?]{0,80}?\b(larger than|greater than|more than|bigger than|exceeds?|higher than)\b[^.!?]{0,80}?(\d[\d,]*(?:\.\d+)?)\s*(?:GiB|GB|MB|TB)\b/gi;

export function checkComparisons(answer) {
  const bad = [];
  for (const m of (answer ?? '').matchAll(COMPARISON)) {
    const left = Number(m[1].replace(/,/g, ''));
    const right = Number(m[3].replace(/,/g, ''));
    if (Number.isFinite(left) && Number.isFinite(right) && !(left > right)) {
      bad.push(`${left} ${m[2]} ${right}`);
    }
  }
  return bad;
}

// A number is only checkable if it carries a unit. Bare integers are counts,
// ports, PIDs and years — none of which a wrong answer misstates in a way this
// check could catch.
const QUANTITY = /(\d[\d,]*(?:\.\d+)?)\s*(GiB|GB|MiB|MB|TB|KB|%)/gi;

function quantitiesIn(text) {
  return [...stripIdentifiers(text).matchAll(QUANTITY)]
    .map((m) => Number(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
}

// Model names are full of digits that are not quantities. "qwen2.5-coder:14b"
// put 14 and 2.5 into the fact set, which is how "a 14 GiB model" slipped
// through the check unflagged when the model is really 8.99 GiB (verified
// 2026-08-14). Parameter counts, version strings, dates and PIDs are all
// identifiers rather than measurements, so none of them should license a
// number in the answer.
function stripIdentifiers(text) {
  return text
    .replace(/[\w.\-]+:\d+(\.\d+)?b\b/gi, ' ') // qwen2.5-coder:14b
    .replace(/\b\d+(\.\d+)?\s*b\b/gi, ' ') // 14B, 7b, 2 b
    .replace(/\bpid \d+/gi, ' ')
    .replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g, ' ') // ISO dates
    .replace(/\bv?\d+\.\d+\.\d+\b/g, ' '); // version strings
}

export async function factAboutMac(snapshot, { provider } = {}) {
  // Facts always get the wide view, whatever the provider: the interesting
  // observations are precisely the cross-section ones ("your models outweigh
  // your apps"), so routing by keyword would defeat the purpose. On a small
  // context the digest's own budget check drops what doesn't fit.
  const factory = digestFactory(snapshot, { sections: ALL_SECTIONS });

  const res = await askProvider((ctx) => `${factory.build(ctx).text}

---

${FACT_TASK}`, {
    // Warmer than `ask`: the failure mode for `fact` is blandness, and a fact
    // is cheap to reroll if it comes out odd.
    system: PERSONA,
    temperature: 0.8,
    maxTokens: 200,
    provider,
  });

  return { ...res, digest: factory.last, check: checkNumbers(res.text, factory.last?.text) };
}

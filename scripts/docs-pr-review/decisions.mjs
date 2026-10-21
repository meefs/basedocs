/**
 * Decision-model checks for the docs PR reviewer.
 *
 * Uses the LLM Gateway Decisions API (POST /v1/decisions, model gpt-6-luna):
 * one input plus fixed questions in, typed answers with probabilities out.
 * Request and answer shapes follow https://developers.openai.com/api/docs/guides/decisions
 * (Bearer auth; body {model, input, questions}; predicate answers carry
 * `probability`; a refused question comes back as type "refusal"). The
 * gateway also serves it at llm-gateway.cbhq.net; we use the coinbase-corp
 * host because it is the one in the workflow's egress allowlist.
 * It is a fast, cheap classifier (about 300 ms and about $0.0001 per call),
 * not a reviewer, so it only makes two narrow calls:
 *
 *   1. misleads   per non-blocking finding: would the text the finding is
 *                 about mislead a reader? Below MISLEADS_THRESHOLD the finding
 *                 stays in the summary under "Minor suggestions" and is not
 *                 posted inline. Blocking findings are never scored.
 *   2. fundsRisk  per PR: could a wrong value in the added lines cost a reader
 *                 funds? At FUNDS_RISK_THRESHOLD or above the risk level is
 *                 raised to high. It never lowers a level.
 *
 * Fails open: an error, refusal, timeout or missing key leaves that finding
 * or PR as it would be without these checks. PR content is untrusted data; the
 * answers are bounded probabilities, so they can only move a finding between
 * inline and summary, or raise the risk level.
 *
 * Thresholds were set on 18 human-judged findings and the 27 BKB PRs
 * (October 2026); re-check them against the eval set before tightening.
 */

import { GENERATED } from "./risk.mjs";

export const DECISIONS_MODEL = "gpt-6-luna";
export const MISLEADS_THRESHOLD = 0.5;
export const FUNDS_RISK_THRESHOLD = 0.8;
const TIMEOUT_MS = 15000;
const CONCURRENCY = 4;
const MAX_HUNK_CHARS = 2500;
const MAX_FINDING_CHARS = 3000;
const MAX_PATCH_CHARS = 6000;

export const MISLEADS_QUESTION = {
  name: "misleads",
  type: "predicate",
  instructions:
    "True if the docs text the finding is about, as shown in the diff, would give a reader a wrong or unsupported fact, a wrong step, or a claim that could cause a mistake. Changes to wording, tone, punctuation, sentence length or order alone do not count.",
};

export const FUNDS_RISK_QUESTION = {
  name: "funds_risk",
  type: "predicate",
  instructions:
    "True if a wrong value in the added lines (an address, endpoint, chain ID, fee, amount, key-handling step, or transaction instruction) could make a reader lose funds, send a transaction to the wrong place, or expose a key.",
};

/**
 * One Decisions API call. Returns { name: answer } or throws.
 * @param {{input:string, questions:Array, fetchImpl?:Function, apiKey?:string, baseUrl?:string, timeoutMs?:number}} opts
 */
export async function decide({ input, questions, fetchImpl = fetch, apiKey = process.env.LLM_GATEWAY_API_KEY, baseUrl, timeoutMs = TIMEOUT_MS }) {
  if (!apiKey) throw new Error("LLM_GATEWAY_API_KEY is not set");
  const base = (baseUrl || process.env.LLM_GATEWAY_BASE_URL || "https://llm-gateway.coinbase-corp.com").replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/v1/decisions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: DECISIONS_MODEL, input, questions }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Decisions API returned HTTP ${res.status}`);
    const body = await res.json();
    const answers = Object.fromEntries((body.answers || []).map((a) => [a.name, a]));
    for (const q of questions) {
      const a = answers[q.name];
      if (!a || a.type === "refusal") throw new Error(`no answer for ${q.name}`);
      if (q.type === "predicate" && !(a.probability >= 0 && a.probability <= 1)) throw new Error(`bad probability for ${q.name}`);
    }
    return answers;
  } finally {
    clearTimeout(timer);
  }
}

/** The hunk of a unified diff whose new-file range contains `line`, capped. */
export function hunkFor(patch, line) {
  const hunks = (patch || "").split(/^(?=@@ )/m).filter((h) => h.startsWith("@@"));
  for (const h of hunks) {
    const m = h.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    if (line >= start && line < start + Math.max(len, 1)) return h.length > MAX_HUNK_CHARS ? h.slice(0, MAX_HUNK_CHARS) : h;
  }
  return (patch || "").slice(0, MAX_HUNK_CHARS);
}

export function findingInput(f, patch) {
  const text = [`**${f.title}**`, f.detail, f.evidence ? `Evidence: ${f.evidence}` : "", f.replacement ? `Suggested replacement:\n${f.replacement}` : ""]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_FINDING_CHARS);
  return `A reviewer left this finding on a documentation pull request.\n\nFILE: ${f.file}\n\nDIFF HUNK:\n${f.line ? hunkFor(patch, f.line) : (patch || "").slice(0, MAX_HUNK_CHARS)}\n\nFINDING:\n${text}`;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Probability that each non-blocking finding is about misleading text.
 * Returns a Map finding -> probability. A finding whose call fails or is
 * refused is left out of the map, so it is never demoted (as the OpenAI guide
 * does, refusals are handled per answer). Blocking findings are not scored.
 */
export async function scoreFindings(findings, patches, { decideFn = decide } = {}) {
  const scored = findings.filter((f) => f.severity !== "blocking");
  const errors = [];
  const probs = await pool(scored, CONCURRENCY, async (f) => {
    try {
      const a = await decideFn({ input: findingInput(f, patches.get(f.file) || ""), questions: [MISLEADS_QUESTION] });
      return a.misleads.probability;
    } catch (err) {
      errors.push(err.message);
      return null;
    }
  });
  if (errors.length) {
    console.warn(`::warning title=Decision model unavailable::${errors.length} of ${scored.length} finding(s) not scored and kept as they are: ${errors[0]}`);
  }
  return new Map(scored.map((f, i) => [f, probs[i]]).filter(([, p]) => p !== null));
}

/** Findings to keep out of inline comments: non-blocking and below the threshold. */
export function minorFindings(scores) {
  const minor = new Set();
  for (const [f, p] of scores || []) if (p < MISLEADS_THRESHOLD) minor.add(f);
  return minor;
}

export function fundsRiskInput(files) {
  const pages = files.filter((f) => !GENERATED.has(f.filename) && f.patch);
  if (!pages.length) return null;
  return "Changed files in a documentation pull request, with their diffs.\n\n" + pages.map((f) => `FILE: ${f.filename}\n${f.patch.slice(0, MAX_PATCH_CHARS)}`).join("\n\n");
}

/** Probability that a wrong value in the PR's added lines could cost funds, or null. */
export async function fundsRisk(files, { decideFn = decide } = {}) {
  const input = fundsRiskInput(files);
  if (!input) return null;
  try {
    const a = await decideFn({ input, questions: [FUNDS_RISK_QUESTION] });
    return a.funds_risk.probability;
  } catch (err) {
    console.warn(`::warning title=Decision model unavailable::funds-risk check skipped: ${err.message}`);
    return null;
  }
}

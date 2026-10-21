/**
 * Which models review a PR, by risk level, and how their output is combined.
 *
 *   low              one review                 GPT-6 Luna
 *   medium           two independent reviews    Claude Sonnet and GPT-6 Luna, merged
 *   high, critical   one review, then a check   Claude Opus, checked by Claude Sonnet
 *
 * Medium (pair): both models get the same prompt in parallel. Findings on the
 * same file and overlapping lines are merged into one and marked `agreed`;
 * agreed findings are never demoted by the decision-model filter. Blocking
 * from either model stays blocking. The verdict is the stricter of the two.
 *
 * High (verify): the second model reads the same material plus the first
 * review's findings and keeps or drops each one, with a reason. A dropped
 * suggestion moves to a collapsed list in the summary; a dropped blocking
 * finding is kept and marked as disputed, so a model can never silently
 * remove a blocking problem.
 *
 * Fails open: if one model in a pair fails, the other's review is used; if
 * the high-tier reviewer fails, the checker reviews alone; if the check
 * fails, the first review is posted unchecked. Only when every model fails
 * does the run fail, as before.
 *
 * Repository variables override the defaults without a code change:
 * DOCS_PR_REVIEW_MODEL_LOW, DOCS_PR_REVIEW_MODEL (passed as CLAUDE_MODEL),
 * DOCS_PR_REVIEW_MODEL_SECOND, DOCS_PR_REVIEW_MODEL_HIGH and
 * DOCS_PR_REVIEW_MODEL_VERIFIER.
 */

import { MAX_FINDINGS, SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT, buildVerifyPrompt } from "./prompts.mjs";
import { extractJson, sanitizeText, validateReview } from "./render.mjs";

export const DEFAULT_MODELS = {
  low: "gpt-6-luna",
  medium: "claude-sonnet-5-5",
  second: "gpt-6-luna",
  high: "claude-opus-5-5",
  verifier: "claude-sonnet-5-5",
};

export function reviewPlanFor(level, env = process.env) {
  if (level === "low") return { mode: "single", primary: env.DOCS_PR_REVIEW_MODEL_LOW || DEFAULT_MODELS.low };
  if (level === "medium") {
    return { mode: "pair", primary: env.CLAUDE_MODEL || DEFAULT_MODELS.medium, second: env.DOCS_PR_REVIEW_MODEL_SECOND || DEFAULT_MODELS.second };
  }
  return {
    mode: "verify",
    primary: env.DOCS_PR_REVIEW_MODEL_HIGH || DEFAULT_MODELS.high,
    verifier: env.DOCS_PR_REVIEW_MODEL_VERIFIER || env.CLAUDE_MODEL || DEFAULT_MODELS.verifier,
  };
}

/** Short plan text for logs, e.g. "claude-opus-5-5 > claude-sonnet-5-5". */
export function planText(plan) {
  if (plan.mode === "pair") return `${plan.primary} + ${plan.second}`;
  if (plan.mode === "verify") return `${plan.primary} > ${plan.verifier}`;
  return plan.primary;
}

const VERDICT_RANK = { fits: 0, fits_with_changes: 1, needs_rework: 2 };
const code = (m) => `\`${m}\``;

function sameSpot(a, b) {
  if (a.file !== b.file) return false;
  if (!a.line || !b.line) return !a.line && !b.line && a.category === b.category;
  const aEnd = a.endLine ?? a.line;
  const bEnd = b.endLine ?? b.line;
  return a.line <= bEnd + 2 && b.line <= aEnd + 2;
}

/** Merge two independent reviews of the same PR. */
export function mergePair(a, b) {
  const used = new Set();
  const merged = a.findings.map((f) => {
    const j = b.findings.findIndex((g, k) => !used.has(k) && sameSpot(f, g));
    if (j < 0) return { ...f };
    used.add(j);
    const g = b.findings[j];
    return { ...f, severity: f.severity === "blocking" || g.severity === "blocking" ? "blocking" : "suggestion", agreed: true };
  });
  const rest = b.findings.filter((_, k) => !used.has(k)).map((g) => ({ ...g }));
  const rank = (f) => (f.severity === "blocking" ? 0 : f.agreed ? 1 : 2);
  const all = [...merged, ...rest].sort((x, y) => rank(x) - rank(y));
  return {
    verdict: VERDICT_RANK[b.verdict] > VERDICT_RANK[a.verdict] ? b.verdict : a.verdict,
    summary: a.summary || b.summary,
    findings: all.slice(0, MAX_FINDINGS),
    dropped: [...a.dropped, ...b.dropped],
    capped: Math.max(0, all.length - MAX_FINDINGS),
  };
}

/** Apply the checker's keep/drop decisions. Missing or malformed checks keep the finding. */
export function applyChecks(review, raw) {
  if (!raw || !Array.isArray(raw.checks)) throw new Error("check output has no checks list");
  const byIndex = new Map();
  for (const c of raw.checks) {
    if (Number.isInteger(c?.index) && c.index >= 1 && c.index <= review.findings.length && (c.action === "keep" || c.action === "drop")) {
      byIndex.set(c.index, { action: c.action, reason: sanitizeText(c.reason, 300) || "no reason given" });
    }
  }
  const kept = [];
  const rejected = [];
  review.findings.forEach((f, i) => {
    const c = byIndex.get(i + 1);
    if (c?.action !== "drop") kept.push(f);
    else if (f.severity === "blocking") kept.push({ ...f, disputed: c.reason });
    else rejected.push({ finding: f, reason: c.reason });
  });
  const verdict = !kept.length && review.verdict === "fits_with_changes" ? "fits" : review.verdict;
  return { review: { ...review, verdict, findings: kept }, rejected };
}

async function reviewOnce({ completeFn, model, prompt, validFiles, tag, maxTokens }) {
  const { text, stopReason } = await completeFn(prompt, tag, { system: SYSTEM_PROMPT, model, maxTokens });
  if (stopReason === "max_tokens") throw new Error(`${model} output was truncated`);
  return validateReview(extractJson(text), validFiles);
}

const warn = (msg) => console.warn(`::warning title=Review model unavailable::${msg}`);

/**
 * Run the plan. Returns { review, rejected, label, models } where `label` is
 * the markdown shown after "reviewed <sha> with", and `models` lists the
 * models whose output was used.
 */
export async function runPanel({ plan, prompt, validFiles, completeFn, tag = "", maxTokens = 8192 }) {
  const once = (model, suffix = "") => reviewOnce({ completeFn, model, prompt, validFiles, tag: `${tag}${suffix}`, maxTokens });

  if (plan.mode === "pair") {
    const [a, b] = await Promise.allSettled([once(plan.primary), once(plan.second, "-second")]);
    if (a.status === "fulfilled" && b.status === "fulfilled") {
      return { review: mergePair(a.value, b.value), rejected: [], label: `${code(plan.primary)} and ${code(plan.second)}, reviewing independently`, models: [plan.primary, plan.second] };
    }
    if (a.status === "rejected" && b.status === "rejected") throw a.reason;
    const [ok, review, bad, err] = a.status === "fulfilled" ? [plan.primary, a.value, plan.second, b.reason] : [plan.second, b.value, plan.primary, a.reason];
    warn(`${bad} failed (${err.message}); using ${ok} alone`);
    return { review, rejected: [], label: `${code(ok)} (${code(bad)} was unavailable)`, models: [ok] };
  }

  if (plan.mode === "verify") {
    let review;
    try {
      review = await once(plan.primary);
    } catch (err) {
      warn(`${plan.primary} failed (${err.message}); ${plan.verifier} reviews alone`);
      return { review: await once(plan.verifier, "-fallback"), rejected: [], label: `${code(plan.verifier)} (${code(plan.primary)} was unavailable)`, models: [plan.verifier] };
    }
    if (!review.findings.length) return { review, rejected: [], label: `${code(plan.primary)}, no findings to check`, models: [plan.primary] };
    try {
      const { text, stopReason } = await completeFn(buildVerifyPrompt(prompt, review.findings), `${tag}-check`, {
        system: VERIFY_SYSTEM_PROMPT,
        model: plan.verifier,
        maxTokens: 4096,
      });
      if (stopReason === "max_tokens") throw new Error("check output was truncated");
      const checked = applyChecks(review, extractJson(text));
      return { ...checked, label: `${code(plan.primary)}, checked by ${code(plan.verifier)}`, models: [plan.primary, plan.verifier] };
    } catch (err) {
      warn(`check by ${plan.verifier} failed (${err.message}); posting the ${plan.primary} review unchecked`);
      return { review, rejected: [], label: `${code(plan.primary)} (the check by ${code(plan.verifier)} was unavailable)`, models: [plan.primary] };
    }
  }

  return { review: await once(plan.primary), rejected: [], label: code(plan.primary), models: [plan.primary] };
}

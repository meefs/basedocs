// Decision-model checks. No network: every call uses a fake fetch or decideFn.
//   node --test scripts/docs-pr-review/__tests__/decisions.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  FUNDS_RISK_QUESTION,
  MISLEADS_QUESTION,
  decide,
  findingInput,
  fundsRisk,
  fundsRiskInput,
  hunkFor,
  minorFindings,
  scoreFindings,
} from "../decisions.mjs";
import { raiseRisk, renderRisk } from "../risk.mjs";
import { renderSummary } from "../render.mjs";

const quiet = (fn) => async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
};

const fakeFetch = (answers, { status = 200, capture } = {}) => async (url, init) => {
  if (capture) capture.push({ url, init });
  return { ok: status < 400, status, json: async () => ({ model: "gpt-6-luna", answers }) };
};

const finding = (over = {}) => ({
  file: "docs/a.mdx",
  line: 12,
  severity: "suggestion",
  category: "writing",
  title: "Tighten the intro",
  detail: "Shorter is better.",
  replacement: "New intro.",
  ...over,
});

test("decide: posts model, input and questions; returns answers by name", async () => {
  const capture = [];
  const a = await decide({
    input: "x",
    questions: [MISLEADS_QUESTION],
    apiKey: "k",
    baseUrl: "https://gw.example/",
    fetchImpl: fakeFetch([{ type: "predicate", name: "misleads", probability: 0.2 }], { capture }),
  });
  assert.equal(a.misleads.probability, 0.2);
  assert.equal(capture[0].url, "https://gw.example/v1/decisions");
  assert.equal(capture[0].init.headers.Authorization, "Bearer k");
  const body = JSON.parse(capture[0].init.body);
  assert.equal(body.model, "gpt-6-luna");
  assert.deepEqual(body.questions, [MISLEADS_QUESTION]);
});

test("decide: rejects HTTP errors, refusals, missing answers, bad probabilities, and a missing key", async () => {
  const q = [MISLEADS_QUESTION];
  await assert.rejects(decide({ input: "x", questions: q, apiKey: "k", fetchImpl: fakeFetch([], { status: 403 }) }), /HTTP 403/);
  await assert.rejects(decide({ input: "x", questions: q, apiKey: "k", fetchImpl: fakeFetch([{ type: "refusal", name: "misleads" }]) }), /no answer/);
  await assert.rejects(decide({ input: "x", questions: q, apiKey: "k", fetchImpl: fakeFetch([]) }), /no answer/);
  await assert.rejects(decide({ input: "x", questions: q, apiKey: "k", fetchImpl: fakeFetch([{ type: "predicate", name: "misleads", probability: 7 }]) }), /bad probability/);
  await assert.rejects(decide({ input: "x", questions: q, apiKey: "", fetchImpl: fakeFetch([]) }), /not set/);
});

test("decide: aborts after the timeout", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(decide({ input: "x", questions: [MISLEADS_QUESTION], apiKey: "k", fetchImpl: hang, timeoutMs: 10 }), /aborted/);
});

test("hunkFor: the hunk that holds the line, else the start of the patch", () => {
  const patch = "@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -40,2 +41,4 @@\n x\n+y\n+z\n w";
  assert.match(hunkFor(patch, 43), /^@@ -40,2 \+41,4 @@/);
  assert.match(hunkFor(patch, 2), /^@@ -1,2 \+1,3 @@/);
  assert.match(hunkFor(patch, 999), /^@@ -1,2/);
});

test("findingInput: file, hunk, and the finding with its replacement", () => {
  const input = findingInput(finding({ line: 2, evidence: "Line 2 says so." }), "@@ -1,2 +1,3 @@\n a\n+b\n c");
  assert.match(input, /FILE: docs\/a\.mdx/);
  assert.match(input, /\+b/);
  assert.match(input, /\*\*Tighten the intro\*\*/);
  assert.match(input, /Evidence: Line 2 says so\./);
  assert.match(input, /Suggested replacement:\nNew intro\./);
});

test("scoreFindings: scores non-blocking findings only; minorFindings keeps those under 0.5", async () => {
  const wording = finding({ title: "Wording" });
  const wrong = finding({ title: "Wrong fact" });
  const blocker = finding({ title: "Broken step", severity: "blocking" });
  const seen = [];
  const decideFn = async ({ input, questions }) => {
    seen.push(input);
    assert.deepEqual(questions, [MISLEADS_QUESTION]);
    return { misleads: { probability: input.includes("Wording") ? 0.1 : 0.9 } };
  };
  const scores = await scoreFindings([wording, wrong, blocker], new Map(), { decideFn });
  assert.equal(seen.length, 2);
  assert.equal(scores.get(wording), 0.1);
  assert.equal(scores.has(blocker), false);
  assert.deepEqual([...minorFindings(scores)], [wording]);
  assert.equal(minorFindings(null).size, 0);
});

test("scoreFindings: fails open per finding, so a failed or refused call never demotes", quiet(async () => {
  const down = await scoreFindings([finding(), finding()], new Map(), { decideFn: async () => { throw new Error("gateway down"); } });
  assert.equal(down.size, 0);
  assert.equal(minorFindings(down).size, 0);
  const refused = finding({ title: "Refused" });
  const wording = finding({ title: "Wording" });
  const decideFn = async ({ input }) => {
    if (input.includes("Refused")) throw new Error("no answer for misleads");
    return { misleads: { probability: 0.1 } };
  };
  const scores = await scoreFindings([refused, wording], new Map(), { decideFn });
  assert.deepEqual([...scores.keys()], [wording]);
  assert.deepEqual([...minorFindings(scores)], [wording]);
}));

test("fundsRisk: one question over non-generated diffs; null on failure or no diffs", quiet(async () => {
  const files = [
    { filename: "docs/llms-full.txt", patch: "+0xabc generated" },
    { filename: "docs/bridge.mdx", patch: "+| USDC | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 |" },
  ];
  assert.ok(!fundsRiskInput(files).includes("llms-full"));
  assert.equal(fundsRiskInput([files[0]]), null);
  const decideFn = async ({ questions }) => {
    assert.deepEqual(questions, [FUNDS_RISK_QUESTION]);
    return { funds_risk: { probability: 0.98 } };
  };
  assert.equal(await fundsRisk(files, { decideFn }), 0.98);
  assert.equal(await fundsRisk([files[0]], { decideFn }), null);
  assert.equal(await fundsRisk(files, { decideFn: async () => { throw new Error("x"); } }), null);
}));

test("raiseRisk: raises the level and drops the 'small' reason, never lowers", () => {
  const low = { level: "low", reasons: [{ level: "low", rule: "small", text: "small change with no risk signals" }] };
  const reason = { level: "high", rule: "funds-risk", text: "a decision model rates … (0.98)" };
  const up = raiseRisk(low, reason);
  assert.equal(up.level, "high");
  assert.deepEqual(up.reasons.map((r) => r.rule), ["funds-risk"]);
  assert.match(renderRisk(up), /What to check:\n- Check every address/);
  const critical = { level: "critical", reasons: [{ level: "critical", rule: "gate", text: "gate fires" }] };
  assert.equal(raiseRisk(critical, reason).level, "critical");
});

test("renderSummary: minor suggestions sit in a collapsed list and are not marked inline", () => {
  const keep = finding({ title: "Wrong fact" });
  const minor = finding({ title: "Wording" });
  const md = renderSummary({
    review: { verdict: "fits_with_changes", summary: "", findings: [keep, minor], dropped: [] },
    facts: [],
    headSha: "abcdef1234",
    inlineFindings: [keep],
    minor: new Set([minor]),
  });
  const [main, collapsed] = md.split("<details><summary>Minor suggestions (1)</summary>");
  assert.match(main, /### Suggestions\n\n1\. \*\*Wrong fact\*\*.*suggestion posted inline/);
  assert.ok(!main.includes("Wording"));
  assert.match(collapsed, /would not mislead a reader/);
  assert.match(collapsed, /1\. \*\*Wording\*\* \(writing, `docs\/a\.mdx` L12\)\n/);
  assert.ok(!collapsed.split("</details>")[0].includes("### "));
});

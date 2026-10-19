import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { beforeYouPr } from "../src/check.ts";
import { ruleExcerpts } from "../src/checks/excerpts.ts";
import { ReplayClient } from "../src/github/fixtures.ts";
import type { RuleDocument, SourceKind } from "../src/types.ts";

const doc = (text: string, kind: SourceKind = "contributing", path = "CONTRIBUTING.md"): RuleDocument => ({
  path,
  kind,
  url: `https://github.com/acme/widget/blob/main/${path}`,
  text,
});
const texts = (docs: RuleDocument[]) => ruleExcerpts(docs).flatMap((e) => e.lines.map((l) => l.text));

describe("ruleExcerpts", () => {
  it("keeps whole AI sections and matching sentences, and drops the rest", () => {
    const got = texts([
      doc(
        [
          "# Contributing",
          "",
          "Run the tests before you push.",
          "",
          "Please comment on the issue before you start so we can assign it to you.",
          "",
          "## AI policy",
          "",
          "We welcome thoughtful use. Write PR descriptions yourself.",
        ].join("\n"),
      ),
    ]);
    assert.deepEqual(got, [
      "Please comment on the issue before you start so we can assign it to you.",
      "We welcome thoughtful use.",
      "Write PR descriptions yourself.",
    ]);
  });

  it("keeps a whole AI-policy file and records headings and line numbers", () => {
    const [first] = ruleExcerpts([doc("AI Policy\n=========\n\nBe responsible.\n", "ai-policy", "doc/ai-policy.rst")]);
    assert.deepEqual(first, {
      file: "doc/ai-policy.rst",
      url: "https://github.com/acme/widget/blob/main/doc/ai-policy.rst",
      kind: "ai-policy",
      heading: "AI Policy",
      lines: [{ line: 4, text: "Be responsible." }],
    });
  });

  it("ignores bare AI mentions in agent files but keeps their PR rules", () => {
    const got = texts([doc("# Notes for Claude\n\nUse Claude Code skills.\n\nDo not open a PR if a duplicate already exists.\n", "agent-instructions", "CLAUDE.md")]);
    assert.deepEqual(got, ["Do not open a PR if a duplicate already exists."]);
  });

  it("keeps sign-off lines from code blocks only", () => {
    const got = texts([doc("## Sign your work\n\n```\nnpm test\ngit commit -s -m 'fix'\n```\n")]);
    assert.deepEqual(got, ["git commit -s -m 'fix'"]);
  });

  it("caps the size per document", () => {
    const big = Array.from({ length: 400 }, (_, i) => `## AI part ${i}\n\nAI rule number ${i} is long enough to count toward the size limit here.`).join("\n\n");
    const chars = ruleExcerpts([doc(big)]).reduce((n, e) => n + e.lines.reduce((m, l) => m + l.text.length, 0), 0);
    assert.ok(chars <= 5_000, String(chars));
  });
});

describe("agent facts on recorded scenarios", () => {
  const load = (name: string) => ReplayClient.load(join(import.meta.dirname, "fixtures", `${name}.json`));

  it("pydantic: the assign-first rule is left to the agent, with the sentence in the excerpts", async () => {
    const client = await load("pydantic-11692");
    const r = await beforeYouPr({ repo: "pydantic/pydantic", issue: 11692, client, now: client.recordedAt, agent: true });
    assert.ok(r.agent);
    assert.ok(!r.agent.factsReasons.some((x) => x.code === "assignment-required"), "no prose-based reason in the facts verdict");
    assert.ok(r.agent.excerpts.some((e) => e.lines.some((l) => /without being assigned first/.test(l.text))));
    assert.match(r.agent.instructions, /stricter of factsVerdict/);
  });

  it("sphinx: the AI policy text reaches the agent", async () => {
    const client = await load("sphinx-4248");
    const r = await beforeYouPr({ repo: "sphinx-doc/sphinx", issue: 4248, client, now: client.recordedAt, agent: true });
    const lines = r.agent!.excerpts.filter((e) => e.file === "doc/internals/ai-policy.rst").flatMap((e) => e.lines.map((l) => l.line));
    assert.ok(lines.includes(23) && lines.includes(62), lines.join(","));
  });

  it("black: facts alone already say don't", async () => {
    const client = await load("black-5260");
    const r = await beforeYouPr({ repo: "psf/black", issue: 5260, client, now: client.recordedAt, agent: true });
    assert.equal(r.agent!.factsVerdict, "dont");
  });

  it("is left out unless asked for", async () => {
    const client = await load("vite");
    const r = await beforeYouPr({ repo: "vitejs/vite", client, now: client.recordedAt });
    assert.equal(r.agent, undefined);
  });
});

describe("agentView", () => {
  it("is compact: hints instead of keyword evidence, plus excerpts and instructions", async () => {
    const { agentView } = await import("../src/format.ts");
    const client = await ReplayClient.load(join(import.meta.dirname, "fixtures", "pydantic-11692.json"));
    const r = await beforeYouPr({ repo: "pydantic/pydantic", issue: 11692, client, now: client.recordedAt, agent: true });
    const view = agentView(r);
    assert.equal(view.factsVerdict, "comment-first");
    assert.equal(view.keywordHints?.assignmentRequired, true);
    assert.ok(view.excerpts.length > 0);
    assert.ok(!("rules" in view));
    assert.ok(JSON.stringify(view).length < JSON.stringify(r).length);
  });
});

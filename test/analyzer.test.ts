import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeywordRulesAnalyzer } from "../src/checks/keyword-analyzer.ts";
import type { RuleDocument, SourceKind } from "../src/types.ts";

const repo = { owner: "acme", name: "widget" };
const doc = (text: string, kind: SourceKind = "contributing", path = "CONTRIBUTING.md"): RuleDocument => ({
  path,
  kind,
  url: `https://github.com/acme/widget/blob/main/${path}`,
  text,
});
const analyze = (...docs: RuleDocument[]) => new KeywordRulesAnalyzer().analyze(docs, repo);

describe("AI policy", () => {
  it("reads a Sphinx-style policy: human text, disclosure, no autonomous agents", () => {
    const rules = analyze(
      doc(
        [
          "AI Policy",
          "=========",
          "",
          "In explaining your contribution, do not use AI to automatically generate comments, pull request descriptions, or issue descriptions.",
          "",
          "You must disclose whether AI has been used to assist in the development of your pull request.",
          "",
          "The use of an AI agent that writes code and then submits a pull request autonomously is not permitted.",
          "",
          'We will reject pull requests that we deem to be "AI slop".',
        ].join("\n"),
        "ai-policy",
        "doc/ai-policy.rst",
      ),
    );
    assert.equal(rules.ai.policy, "human-written-text-required");
    assert.equal(rules.ai.humanWrittenText.length, 1);
    assert.equal(rules.ai.disclosure.length, 1);
    assert.equal(rules.ai.noAutonomousAgents.length, 1);
    assert.equal(rules.ai.forbidden.length, 0, "a conditional rejection is not a ban");
    assert.equal(rules.ai.restrictions.length, 1);
    assert.equal(rules.ai.disclosure[0]!.line, 6);
    assert.match(rules.ai.disclosure[0]!.url, /doc\/ai-policy\.rst#L6$/);
  });

  it("detects an outright ban", () => {
    for (const text of [
      "We do not accept AI-generated code.",
      "Contributions created with generative AI tools are prohibited.",
      "No LLMs for pull requests.",
      "The project declines to accept contributions which include AI generated content.",
    ]) {
      assert.equal(analyze(doc(text)).ai.policy, "forbidden", text);
    }
  });

  it("treats conditional limits as restrictions, not bans", () => {
    for (const text of [
      "AI-generated pull requests that you cannot explain will be closed.",
      "Low-quality AI contributions are not welcome.",
      "Large, bulk-generated changes from AI tools without clear rationale may be declined.",
    ]) {
      const rules = analyze(doc(text));
      assert.equal(rules.ai.forbidden.length, 0, text);
      assert.equal(rules.ai.restrictions.length, 1, text);
    }
  });

  it("reads welcoming policies as allowed", () => {
    const rules = analyze(doc("## AI policy\n\nWe welcome the use of AI when contributing to Widget."));
    assert.equal(rules.ai.policy, "allowed");
  });

  it("finds disclosure requirements", () => {
    const rules = analyze(doc("If AI tools were used in a material way, disclose this in the pull request."));
    assert.equal(rules.ai.policy, "disclosure-required");
  });

  it("does not mistake unrelated text for policy", () => {
    const rules = analyze(
      doc(
        [
          "## AI policy",
          "",
          "We welcome AI. Such behavior can also result in a permanent ban from the organization.",
          "",
          "## Security",
          "",
          "Please disclose vulnerabilities privately.",
        ].join("\n"),
      ),
    );
    assert.equal(rules.ai.forbidden.length, 0);
    assert.equal(rules.ai.disclosure.length, 0);
  });

  it("returns not-stated when nothing is said about AI", () => {
    assert.equal(analyze(doc("Run the tests before you open a PR.")).ai.policy, "not-stated");
  });

  it("ignores operational AI mentions in agent instruction files", () => {
    const rules = analyze(doc("# Guide for AI agents\n\nTools that auto-load it (e.g. Claude Code) need not re-read it.", "agent-instructions", "CLAUDE.md"));
    assert.equal(rules.ai.policy, "not-stated");
  });
});

describe("assignment and process rules", () => {
  it("finds assign-first rules", () => {
    const rules = analyze(doc("Any pull request fixing an existing issue without being assigned first will be automatically closed."));
    assert.equal(rules.assignment.required, true);
  });

  it("finds explicit no-need-to-ask rules", () => {
    const rules = analyze(doc("You do not need to ask for permission to work on an open issue."));
    assert.equal(rules.assignment.required, false);
    assert.equal(rules.assignment.notRequired.length, 1);
  });

  it("finds issue-first rules but not unrelated before/issue sentences", () => {
    assert.equal(analyze(doc("Please create an issue to discuss the change before creating a pull request.")).issueFirst.required, true);
    assert.equal(analyze(doc("Do this twice: before you start working on an issue, and again before you open your PR.")).issueFirst.required, false);
  });

  it("reads a claim window", () => {
    const rules = analyze(doc("The claim is active if the person who made it did something in the last 15 days.", "agent-instructions", "AGENTS.md"));
    assert.equal(rules.claimWindow?.days, 15);
  });

  it("collects imperative agent rules", () => {
    const rules = analyze(doc("**Rule: if the issue already has an OPEN pull request, do not open another one.**", "agent-instructions", "AGENTS.md"));
    assert.equal(rules.agentRules.length, 1);
    assert.deepEqual(rules.agentFiles, ["AGENTS.md"]);
  });
});

describe("CLA and DCO", () => {
  it("finds a CLA", () => {
    assert.equal(analyze(doc("You need to sign the Contributor License Agreement before we can merge.")).cla.required, true);
    assert.equal(analyze(doc("We do not require a CLA.")).cla.required, false);
    assert.equal(analyze(doc("See CLAUDE.md for agent notes.")).cla.required, false);
  });

  it("finds a DCO in prose and in code blocks", () => {
    assert.equal(analyze(doc("All commits must include a Developer Certificate of Origin sign-off.")).dco.required, true);
    assert.equal(analyze(doc("Sign your work:\n\n```\ngit commit -s -m 'fix'\n```\n")).dco.required, true);
    assert.equal(analyze(doc("Maintainers sign off on the release notes.")).dco.required, false);
  });
});

describe("external guides", () => {
  it("keeps links to the project's own docs only", () => {
    const rules = analyze(
      doc(
        [
          "Read the [contributing guide](https://widget.readthedocs.io/en/latest/contributing.html).",
          "Adapted from the [other project's contributing guide](https://github.com/other/thing/blob/main/CONTRIBUTING.md).",
        ].join("\n\n"),
      ),
    );
    assert.deepEqual(rules.externalGuides, ["https://widget.readthedocs.io/en/latest/contributing.html"]);
  });
});

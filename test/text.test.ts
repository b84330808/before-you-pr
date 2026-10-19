import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanInline, links, segment } from "../src/checks/text.ts";

describe("segment", () => {
  it("joins wrapped lines into sentences and keeps the starting line", () => {
    const doc = "# Title\n\nFirst sentence wraps\nover two lines. Second one.\n";
    const s = segment(doc);
    assert.deepEqual(
      s.map((x) => [x.text, x.line]),
      [
        ["First sentence wraps over two lines.", 3],
        ["Second one.", 4],
      ],
    );
    assert.deepEqual(s[0]!.headings, ["Title"]);
  });

  it("tracks nested Markdown headings", () => {
    const s = segment("# A\n## B\ntext\n## C\nmore\n");
    assert.deepEqual(s.map((x) => x.headings), [["A", "B"], ["A", "C"]]);
  });

  it("understands reStructuredText headings", () => {
    const s = segment("=========\nAI Policy\n=========\n\nIntro.\n\nAgents\n------\n\nNo bots.\n");
    assert.deepEqual(s.map((x) => [x.text, x.headings]), [
      ["Intro.", ["AI Policy"]],
      ["No bots.", ["AI Policy", "Agents"]],
    ]);
  });

  it("splits list items and marks fenced code", () => {
    const s = segment("- one\n- two\n\n```sh\ngit commit -s\n```\n");
    assert.deepEqual(s.map((x) => [x.text, x.code]), [
      ["one", false],
      ["two", false],
      ["git commit -s", true],
    ]);
  });

  it("does not split after abbreviations", () => {
    assert.equal(segment("Use tools, e.g. Copilot or similar.").length, 1);
  });

  it("does not treat a long bold sentence as a heading", () => {
    const s = segment("**Rule: if the issue already has an OPEN pull request, do not open another one.**\n");
    assert.equal(s[0]!.text, "Rule: if the issue already has an OPEN pull request, do not open another one.");
  });
});

describe("cleanInline", () => {
  it("strips Markdown and rst markup", () => {
    assert.equal(cleanInline("See the [guide](https://x.y) and `code` **now**"), "See the guide and code now");
    assert.equal(cleanInline("Read `the policy <https://x.y>`_ and :doc:`ai-policy`"), "Read the policy and ai-policy");
  });
});

describe("links", () => {
  it("finds Markdown and rst links", () => {
    const found = links("[Guide](https://a.b/c)\n\n.. _target: https://d.e/f\n");
    assert.deepEqual(found, [
      { text: "Guide", url: "https://a.b/c" },
      { text: "target", url: "https://d.e/f" },
    ]);
  });
});

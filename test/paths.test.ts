import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPath, pickRuleFiles } from "../src/checks/rules.ts";
import { parseTarget } from "../src/util.ts";

describe("classifyPath", () => {
  const cases: [string, ReturnType<typeof classifyPath>][] = [
    ["CONTRIBUTING.md", "contributing"],
    [".github/CONTRIBUTING.md", "contributing"],
    ["doc/internals/contributing.rst", "contributing"],
    ["docs/contributing/the_basics.md", "contributing"],
    ["doc/internals/ai-policy.rst", "ai-policy"],
    ["AI_POLICY.md", "ai-policy"],
    ["AGENTS.md", "agent-instructions"],
    ["CLAUDE.md", "agent-instructions"],
    [".github/copilot-instructions.md", "agent-instructions"],
    [".github/PULL_REQUEST_TEMPLATE.md", "pr-template"],
    [".github/PULL_REQUEST_TEMPLATE/bugfix.md", "pr-template"],
    [".clabot", "compliance"],
    [".github/dco.yml", "compliance"],
    [".github/workflows/cla.yml", "workflow"],
    [".github/workflows/ci.yml", null],
    ["CONTRIBUTORS.md", null],
    ["docs/ja/contributing.md", null],
    ["docs/references/ai/ai-usage-records.md", null],
    ["docs/contributing/release_process.md", null],
    ["packages/foo/AGENTS.md", null],
    ["tests/fixtures/CONTRIBUTING.md", null],
  ];
  for (const [path, kind] of cases) {
    it(`${path} → ${kind}`, () => assert.equal(classifyPath(path), kind));
  }
});

describe("pickRuleFiles", () => {
  it("puts AI policies and root files first and caps nested docs", () => {
    const paths = [
      ...Array.from({ length: 12 }, (_, i) => ({ path: `docs/contributing/page${i}.md`, type: "blob" })),
      { path: "CONTRIBUTING.md", type: "blob" },
      { path: "AI_POLICY.md", type: "blob" },
      { path: "docs/contributing", type: "tree" },
    ];
    const picked = pickRuleFiles(paths);
    assert.deepEqual(picked.slice(0, 2).map((p) => p.path), ["AI_POLICY.md", "CONTRIBUTING.md"]);
    assert.equal(picked.filter((p) => p.path.startsWith("docs/")).length, 8);
  });
});

describe("parseTarget", () => {
  it("accepts owner/repo with an issue in several forms", () => {
    assert.deepEqual(parseTarget("psf/black", "5260"), { repo: { owner: "psf", name: "black" }, issue: 5260 });
    assert.deepEqual(parseTarget("psf/black", "#5260"), { repo: { owner: "psf", name: "black" }, issue: 5260 });
    assert.deepEqual(parseTarget("psf/black#5260"), { repo: { owner: "psf", name: "black" }, issue: 5260 });
    assert.deepEqual(parseTarget("https://github.com/psf/black/issues/5260"), { repo: { owner: "psf", name: "black" }, issue: 5260 });
    assert.deepEqual(parseTarget("https://github.com/vitejs/vite"), { repo: { owner: "vitejs", name: "vite" }, issue: null });
  });

  it("rejects junk", () => {
    assert.throws(() => parseTarget("black"));
    assert.throws(() => parseTarget("psf/black", "abc"));
  });
});

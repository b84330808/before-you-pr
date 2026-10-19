// Replays recorded GitHub responses (test/fixtures, refreshed with `npm run record`) through the whole pipeline.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { beforeYouPr } from "../src/check.ts";
import { formatReport } from "../src/format.ts";
import { ReplayClient } from "../src/github/fixtures.ts";
import type { Report } from "../src/types.ts";
import { SCENARIOS } from "./scenarios.ts";

async function run(name: (typeof SCENARIOS)[number]["name"], usesAI = true): Promise<Report> {
  const s = SCENARIOS.find((x) => x.name === name)!;
  const client = await ReplayClient.load(join(import.meta.dirname, "fixtures", `${name}.json`));
  return beforeYouPr({ repo: s.repo, issue: s.issue, client, now: client.recordedAt, usesAI });
}
const codes = (r: Report) => r.reasons.map((x) => x.code);

describe("recorded scenarios", () => {
  it("psf/black#5260: two open PRs and ten closed attempts → don't", async () => {
    const r = await run("black-5260");
    assert.equal(r.verdict, "dont");
    const open = r.issue!.prs.filter((p) => p.sameRepo && p.state === "OPEN");
    assert.equal(open.length, 2);
    const closed = r.issue!.prs.filter((p) => p.sameRepo && p.state === "CLOSED");
    assert.ok(closed.length >= 10);
    assert.ok(closed.every((p) => p.closedBy?.kind === "maintainer"));
    // One attempt was labelled "spam / ai"; most were closed because maintainers want another approach.
    assert.ok(closed.some((p) => p.closeReason === `AI or automation concerns (label "spam / ai")`));
    assert.ok(closed.filter((p) => p.closeReason === "maintainers want a different approach").length >= 5);
    assert.equal(r.rules!.issueFirst.required, true);
  });

  it("pylint-dev/pylint#9187: assignee has an open PR; claim window comes from AGENTS.md", async () => {
    const r = await run("pylint-9187");
    assert.equal(r.verdict, "dont");
    assert.equal(r.rules!.claimWindow?.days, 15);
    assert.ok(r.rules!.agentFiles.includes("AGENTS.md"));
    assert.ok(r.rules!.agentRules.some((e) => /do not open another one/.test(e.text)));
    assert.equal(r.issue!.claimWindowDays, 15);
    assert.ok(codes(r).includes("open-pr"));
  });

  it("sqlfluff/sqlfluff#8705: open draft plus four PRs closed by the no-human-behind-it bot → don't", async () => {
    const r = await run("sqlfluff-8705");
    assert.equal(r.verdict, "dont");
    assert.equal(r.rules!.ai.policy, "disclosure-required");
    const botClosed = r.issue!.prs.filter((p) => p.closedBy?.kind === "bot");
    assert.equal(botClosed.length, 4);
    assert.ok(botClosed.every((p) => p.closeReason === "AI or automation concerns"));
    assert.ok(r.issue!.prs.some((p) => p.state === "OPEN" && p.isDraft));
  });

  it("sqlfluff/sqlfluff#8721: only a bot-closed attempt → comment first", async () => {
    const r = await run("sqlfluff-8721");
    assert.equal(r.verdict, "comment-first");
    const attempts = r.reasons.find((x) => x.code === "closed-attempts")!;
    assert.equal(attempts.level, "ask");
  });

  it("sphinx-doc/sphinx#4248: strict AI policy, expired claims, maintainer-closed attempts", async () => {
    const r = await run("sphinx-4248");
    assert.equal(r.verdict, "comment-first");
    const ai = r.rules!.ai;
    assert.equal(ai.policy, "human-written-text-required");
    assert.ok(ai.disclosure.length > 0);
    assert.ok(ai.noAutonomousAgents.length > 0);
    assert.ok(r.rules!.sources.some((s) => s.path === "doc/internals/ai-policy.rst"));
    assert.ok(r.issue!.claims.length >= 1 && r.issue!.claims.every((c) => !c.active));
    assert.ok(r.nextSteps.some((s) => /open the PR from your own account by hand/.test(s)));
  });

  it("pydantic/pydantic#11692: assign-first rule → comment first", async () => {
    const r = await run("pydantic-11692");
    assert.equal(r.verdict, "comment-first");
    assert.equal(r.rules!.assignment.required, true);
    assert.ok(codes(r).includes("assignment-required"));
    assert.ok(r.nextSteps.some((s) => /Ask to be assigned/.test(s)));
  });

  it("vitejs/vite: human-written PR text, no need to ask for an issue", async () => {
    const r = await run("vite");
    assert.equal(r.rules!.ai.policy, "human-written-text-required");
    assert.equal(r.rules!.assignment.required, false);
    assert.equal(r.issue, null);
    assert.ok(codes(r).includes("no-issue"));
  });

  it("CherryHQ/cherry-studio: DCO sign-off required", async () => {
    const r = await run("cherry-studio");
    assert.equal(r.rules!.dco.required, true);
    assert.ok(r.nextSteps.some((s) => /git commit -s/.test(s)));
  });

  it("--no-ai turns AI requirements into background information", async () => {
    const r = await run("sphinx-4248", false);
    assert.ok(!codes(r).includes("human-written-text"));
    assert.ok(!codes(r).includes("ai-disclosure"));
  });

  it("every scenario renders as text and as JSON", async () => {
    for (const s of SCENARIOS) {
      const r = await run(s.name);
      const text = formatReport(r);
      assert.match(text, /^before-you-pr /);
      assert.match(text, /Next steps/);
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)));
      assert.deepEqual(r.errors, [], s.name);
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { labelSignals } from "../src/checks/issue.ts";
import { KeywordRulesAnalyzer } from "../src/checks/keyword-analyzer.ts";
import type { Claim, IssueStatus, LinkedPR, MergeFriendliness, RepoRules } from "../src/types.ts";
import { decide, type VerdictInput } from "../src/verdict.ts";

const noRules = (): RepoRules => new KeywordRulesAnalyzer().analyze([], { owner: "a", name: "b" });

function issue(over: Partial<IssueStatus> = {}): IssueStatus {
  return {
    number: 1,
    title: "Bug",
    url: "https://github.com/a/b/issues/1",
    isPullRequest: false,
    state: "OPEN",
    stateReason: null,
    author: "reporter",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    labels: [],
    assignees: [],
    commentCount: 2,
    maintainerEngaged: true,
    labelSignals: { positive: ["good first issue"], blocking: [], needsDiscussion: [], feature: [] },
    prs: [],
    claims: [],
    commitRefs: [],
    claimWindowDays: 15,
    truncated: false,
    ...over,
  };
}

function pr(over: Partial<LinkedPR> = {}): LinkedPR {
  return {
    repo: "a/b",
    sameRepo: true,
    number: 10,
    title: "Fix",
    url: "https://github.com/a/b/pull/10",
    state: "OPEN",
    isDraft: false,
    author: "someone",
    authorAssociation: "CONTRIBUTOR",
    authorIsBot: false,
    createdAt: "2026-01-03T00:00:00Z",
    updatedAt: "2026-01-04T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    link: "closing-reference",
    disconnected: false,
    labels: [],
    daysSinceUpdate: 3,
    ...over,
  };
}

function claim(over: Partial<Claim> = {}): Claim {
  return {
    login: "claimer",
    association: "NONE",
    via: "comment",
    claimedAt: "2026-01-05T00:00:00Z",
    url: "",
    excerpt: "I'd like to work on this",
    lastActivityAt: "2026-01-05T00:00:00Z",
    daysSinceActivity: 3,
    active: true,
    released: false,
    isViewer: false,
    ...over,
  };
}

const merge = (over: Partial<MergeFriendliness> = {}): MergeFriendliness => ({
  windowDays: 90,
  stars: 1000,
  archived: false,
  prCreationPolicy: "all",
  viewerPermission: "READ",
  pushedAt: null,
  merged: { total: 40, external: 20 },
  externalShare: 0.5,
  medianHoursToMerge: { external: 48, all: 24 },
  closedUnmerged: { total: 10, external: 8, days: 90 },
  externalAcceptance: 0.7,
  openPRs: 12,
  checkNames: [],
  ...over,
});

const input = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  usesAI: true,
  rules: noRules(),
  issue: issue(),
  merge: merge(),
  viewer: { login: "me", openPRsInRepo: 0, prsLast24h: 0 },
  viewerLogin: "me",
  errors: [],
  issueRequested: true,
  ...over,
});
const codes = (i: VerdictInput) => decide(i).reasons.map((r) => r.code);

describe("decide", () => {
  it("says go for a welcoming, free issue", () => {
    const d = decide(input());
    assert.equal(d.verdict, "go");
    assert.match(d.nextSteps[0]!, /Run this check again right before you open the PR/);
  });

  it("stops on an open PR from someone else", () => {
    const d = decide(input({ issue: issue({ prs: [pr()] }) }));
    assert.equal(d.verdict, "dont");
    assert.equal(d.reasons[0]!.code, "open-pr");
  });

  it("asks first when the open PR looks abandoned", () => {
    assert.equal(decide(input({ issue: issue({ prs: [pr({ daysSinceUpdate: 120 })] }) })).verdict, "comment-first");
  });

  it("tells you about your own open PR", () => {
    assert.ok(codes(input({ issue: issue({ prs: [pr({ author: "me" })] }) })).includes("your-open-pr"));
  });

  it("asks first about open PRs that only mention the issue", () => {
    const d = decide(input({ issue: issue({ prs: [pr({ link: "mention" })] }) }));
    assert.equal(d.verdict, "comment-first");
    assert.equal(d.reasons[0]!.code, "related-open-pr");
  });

  it("asks first when someone recently pushed a commit for the issue", () => {
    const refs = [{ login: "worker", repo: "worker/b", at: "2026-01-05T00:00:00Z", url: "", daysAgo: 2 }];
    assert.equal(decide(input({ issue: issue({ commitRefs: refs }) })).verdict, "comment-first");
    assert.equal(decide(input({ issue: issue({ commitRefs: [{ ...refs[0]!, daysAgo: 40 }] }) })).verdict, "go");
  });

  it("ignores PRs in other repos that only mention the issue", () => {
    assert.equal(decide(input({ issue: issue({ prs: [pr({ sameRepo: false, repo: "x/y" })] }) })).verdict, "go");
  });

  it("follows the claim window: active claims stop, expired ones only note", () => {
    assert.equal(decide(input({ issue: issue({ claims: [claim()] }) })).verdict, "dont");
    const expired = decide(input({ issue: issue({ claims: [claim({ active: false, daysSinceActivity: 40 })] }) }));
    assert.equal(expired.verdict, "go");
    assert.ok(expired.reasons.some((r) => r.code === "expired-claim"));
  });

  it("asks a maintainer to reassign a stale assignment", () => {
    const d = decide(input({ issue: issue({ assignees: ["claimer"], claims: [claim({ via: "assignment", active: false, daysSinceActivity: 30 })] }) }));
    assert.equal(d.verdict, "comment-first");
  });

  it("does not block on your own claim", () => {
    assert.equal(decide(input({ issue: issue({ claims: [claim({ login: "me", isViewer: true })] }) })).verdict, "go");
  });

  it("stops on a closed issue or a blocking label", () => {
    assert.equal(decide(input({ issue: issue({ state: "CLOSED", stateReason: "COMPLETED" }) })).verdict, "dont");
    assert.equal(decide(input({ issue: issue({ labelSignals: { positive: [], blocking: ["wontfix"], needsDiscussion: [], feature: [] } }) })).verdict, "dont");
  });

  it("asks first on needs-triage labels, closed attempts with AI concerns, and untriaged feature requests", () => {
    assert.equal(decide(input({ issue: issue({ labelSignals: { positive: [], blocking: [], needsDiscussion: ["needs triage"], feature: [] } }) })).verdict, "comment-first");
    const closed = pr({ state: "CLOSED", closedBy: { login: "bot", kind: "bot" }, closeReason: "AI or automation concerns" });
    assert.equal(decide(input({ issue: issue({ prs: [closed] }) })).verdict, "comment-first");
    const feature = issue({ maintainerEngaged: false, labelSignals: { positive: [], blocking: [], needsDiscussion: [], feature: ["enhancement"] } });
    assert.equal(decide(input({ issue: feature })).verdict, "comment-first");
  });

  it("treats AI bans as blocking only when AI is used", () => {
    const rules = new KeywordRulesAnalyzer().analyze(
      [{ path: "CONTRIBUTING.md", kind: "contributing", url: "u", text: "We do not accept AI-generated code." }],
      { owner: "a", name: "b" },
    );
    assert.equal(decide(input({ rules })).verdict, "dont");
    assert.equal(decide(input({ rules, usesAI: false })).verdict, "go");
  });

  it("asks first when assignment is required and you are not assigned", () => {
    const rules = { ...noRules(), assignment: { required: true, evidence: [], notRequired: [] } };
    assert.equal(decide(input({ rules })).verdict, "comment-first");
    assert.equal(decide(input({ rules, issue: issue({ assignees: ["me"] }) })).verdict, "go");
  });

  it("flags repos that rarely merge outside PRs, archived repos and PR bursts", () => {
    assert.equal(decide(input({ merge: merge({ merged: { total: 30, external: 0 } }) })).verdict, "comment-first");
    assert.equal(decide(input({ merge: merge({ archived: true }) })).verdict, "dont");
    assert.ok(codes(input({ viewer: { login: "me", openPRsInRepo: 0, prsLast24h: 9 } })).includes("pr-burst"));
    assert.ok(codes(input({ viewer: { login: "me", openPRsInRepo: 4, prsLast24h: 0 } })).includes("many-open-prs"));
  });

  it("stops when only collaborators can open PRs, unless you are one", () => {
    const d = decide(input({ merge: merge({ prCreationPolicy: "collaborators-only" }) }));
    assert.equal(d.verdict, "dont");
    assert.ok(d.reasons.some((r) => r.code === "prs-collaborators-only"));
    assert.ok(d.nextSteps.some((s) => /Open an issue/.test(s)));
    assert.equal(decide(input({ merge: merge({ prCreationPolicy: "collaborators-only", viewerPermission: "WRITE" }) })).verdict, "go");
    assert.equal(decide(input({ merge: merge({ prCreationPolicy: "collaborators-only", viewerPermission: null }) })).verdict, "dont");
  });

  it("never says go when a check failed", () => {
    assert.equal(decide(input({ errors: ["issue status: timeout"] })).verdict, "comment-first");
  });

  it("reminds about CLA and DCO without blocking", () => {
    const rules = { ...noRules(), cla: { required: true, evidence: [], signals: ["status check on merged PRs: license/cla"] } };
    const d = decide(input({ rules }));
    assert.equal(d.verdict, "go");
    assert.ok(d.nextSteps.some((s) => /sign the CLA yourself/.test(s)));
  });
});

describe("labelSignals", () => {
  it("sorts labels into blocking, needs-discussion and welcoming", () => {
    const s = labelSignals(["wontfix", "Needs triage :inbox_tray:", "awaiting:review", "awaiting response", "good first issue", "Needs PR", "enhancement"]);
    assert.deepEqual(s.blocking, ["wontfix"]);
    assert.deepEqual(s.needsDiscussion, ["Needs triage :inbox_tray:", "awaiting response"]);
    assert.deepEqual(s.positive, ["good first issue", "Needs PR"]);
    assert.deepEqual(s.feature, ["enhancement"]);
  });
});

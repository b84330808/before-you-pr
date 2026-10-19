import type { IssueStatus, Level, MergeFriendliness, Reason, RepoRules, Verdict, ViewerContext } from "./types.ts";
import { formatDuration, pct } from "./util.ts";

/** An open PR untouched for this long is treated as possibly abandoned rather than active. */
export const STALE_PR_DAYS = 60;
const MANY_OPEN_PRS_IN_REPO = 3;
const MANY_PRS_PER_DAY = 5;

export interface VerdictInput {
  usesAI: boolean;
  rules: RepoRules | null;
  issue: IssueStatus | null;
  merge: MergeFriendliness | null;
  viewer: ViewerContext | null;
  /** The current user's login, used to tell their own PRs and claims apart. */
  viewerLogin: string | null;
  /** Checks that failed; each one keeps the verdict away from "go". */
  errors: string[];
  issueRequested: boolean;
}

const ORDER: Record<Level, number> = { ok: 0, note: 1, ask: 2, stop: 3 };

const prRef = (p: { number: number; author: string | null }) => `#${p.number}${p.author ? ` by @${p.author}` : ""}`;
const ago = (days: number) => (days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`);

function repoReasons(input: VerdictInput, out: Reason[]) {
  const { rules, merge, viewer, usesAI } = input;
  if (merge?.archived) out.push({ level: "stop", code: "repo-archived", message: "The repository is archived; it does not accept changes." });

  if (rules) {
    const ai = rules.ai;
    if (ai.policy === "forbidden") {
      out.push({
        level: usesAI ? "stop" : "note",
        code: "ai-forbidden",
        message: usesAI
          ? `The project does not accept AI-generated contributions: "${ai.forbidden[0]?.text}" (${ai.forbidden[0]?.file}:${ai.forbidden[0]?.line}).`
          : "The project forbids AI-generated contributions; make sure none of your change is AI-written.",
      });
    }
    if (usesAI && ai.noAutonomousAgents.length) {
      out.push({ level: "note", code: "no-autonomous-agents", message: "A human must review the change and open the PR personally; agents may not submit on their own." });
    }
    if (usesAI && ai.humanWrittenText.length) {
      out.push({ level: "note", code: "human-written-text", message: "Write the PR description, issue comments and replies yourself, in your own words." });
    }
    if (usesAI && ai.disclosure.length) {
      out.push({ level: "note", code: "ai-disclosure", message: "Disclose AI assistance in the PR, as the project requires." });
    }
    if (usesAI && (ai.policy === "not-stated" || ai.policy === "unclear")) {
      out.push({ level: "note", code: "ai-policy-unknown", message: "No clear AI policy found; disclose AI assistance anyway and make sure you understand every line." });
    }
    if (rules.cla.required) {
      out.push({ level: "note", code: "cla", message: "A Contributor License Agreement is required. You must read and sign it yourself; an agent must not sign it for you." });
    }
    if (rules.dco.required) {
      out.push({ level: "note", code: "dco", message: "DCO sign-off is required: add Signed-off-by to every commit yourself (git commit -s). It is a legal statement, so only you can make it." });
    }
  }

  if (merge) {
    const m = merge.merged;
    if (m.total >= 10 && m.external === 0) {
      out.push({ level: "ask", code: "no-outside-merges", message: `None of the last ${m.total} merged PRs (${merge.windowDays} days) came from outside contributors.` });
    } else if (merge.externalAcceptance !== null && m.external + merge.closedUnmerged.external >= 8 && merge.externalAcceptance < 0.25) {
      out.push({
        level: "ask",
        code: "low-acceptance",
        message: `Most outside-contributor PRs are closed unmerged: ${m.external} merged in ${merge.windowDays} days vs ${merge.closedUnmerged.external} closed in ${merge.closedUnmerged.days} days (about ${pct(merge.externalAcceptance)} accepted).`,
      });
    }
    if (m.total < 3) out.push({ level: "note", code: "low-activity", message: `Only ${m.total} PRs were merged in the last ${merge.windowDays} days; reviews may be slow.` });
    const ext = merge.medianHoursToMerge.external;
    if (ext !== null && ext > 30 * 24) out.push({ level: "note", code: "slow-merges", message: `Outside PRs take a median of ${formatDuration(ext)} to merge.` });
  }

  if (viewer) {
    if (viewer.openPRsInRepo >= MANY_OPEN_PRS_IN_REPO) {
      out.push({
        level: "ask",
        code: "many-open-prs",
        message: `You already have ${viewer.openPRsInRepo} open PRs in this repo. Let maintainers review those before adding another.`,
      });
    }
    if (viewer.prsLast24h >= MANY_PRS_PER_DAY) {
      out.push({
        level: "ask",
        code: "pr-burst",
        message: `You opened ${viewer.prsLast24h} PRs in the last 24 hours. Bursts of PRs strain reviewers and look automated; slow down and follow up on the ones you have.`,
      });
    }
  }
}

function issueReasons(input: VerdictInput, out: Reason[]) {
  const { issue, rules } = input;
  if (!issue) return;
  const me = input.viewerLogin;
  if (issue.isPullRequest) {
    out.push({ level: "stop", code: "not-an-issue", message: `#${issue.number} is a pull request, not an issue. Review it or comment there instead of opening another PR.` });
    return;
  }
  if (issue.state !== "OPEN") {
    const fixedBy = issue.prs.filter((p) => p.sameRepo && p.state === "MERGED").map(prRef);
    out.push({
      level: "stop",
      code: "issue-closed",
      message: `The issue is closed${issue.stateReason ? ` (${issue.stateReason.toLowerCase().replace(/_/g, " ")})` : ""}${fixedBy.length ? `; merged PRs: ${fixedBy.join(", ")}` : ""}.`,
    });
    return;
  }
  if (issue.labelSignals.blocking.length) {
    out.push({ level: "stop", code: "blocking-label", message: `The issue is labelled ${issue.labelSignals.blocking.map((l) => `"${l}"`).join(", ")}.` });
  }
  if (issue.labelSignals.needsDiscussion.length) {
    out.push({
      level: "ask",
      code: "needs-discussion",
      message: `The issue is labelled ${issue.labelSignals.needsDiscussion.map((l) => `"${l}"`).join(", ")}: it is not ready for a PR yet.`,
    });
  }

  const ours = issue.prs.filter((p) => p.sameRepo && !p.disconnected);
  for (const p of ours.filter((p) => p.state === "OPEN")) {
    const linked = p.link === "closing-reference" || p.link === "connected";
    if (me && p.author === me) {
      out.push({ level: "stop", code: "your-open-pr", message: `You already have PR ${prRef(p)} open for this issue. Update it instead of opening a new one.` });
    } else if (!linked) {
      out.push({
        level: "ask",
        code: "related-open-pr",
        message: `Open PR ${prRef(p)} ${p.link === "search" ? "contains this issue's number" : "mentions this issue"} without saying it fixes it. Check whether it already covers the same problem.`,
      });
    } else if (p.daysSinceUpdate < STALE_PR_DAYS) {
      out.push({
        level: "stop",
        code: "open-pr",
        message: `PR ${prRef(p)} is already open${p.isDraft ? " (draft)" : ""}, updated ${ago(p.daysSinceUpdate)}. Review or test it instead of opening a duplicate.`,
      });
    } else {
      out.push({
        level: "ask",
        code: "stale-open-pr",
        message: `PR ${prRef(p)} is open but has had no activity for ${p.daysSinceUpdate} days. Ask on the issue whether it is abandoned before starting.`,
      });
    }
  }
  for (const p of ours.filter((p) => p.state === "MERGED")) {
    out.push({ level: "ask", code: "merged-pr", message: `PR ${prRef(p)} was merged and references this issue. Check whether the problem still exists on the default branch.` });
  }
  const closed = ours.filter((p) => p.state === "CLOSED");
  if (closed.length) {
    const serious = closed.filter((p) => p.closedBy?.kind !== "author" && /AI|process|not wanted/.test(p.closeReason ?? ""));
    const list = closed
      .slice(0, 4)
      .map((p) => {
        const by = p.closedBy?.kind === "bot" ? `closed by bot @${p.closedBy.login}` : p.closedBy?.kind === "maintainer" ? `closed by @${p.closedBy.login}` : null;
        return `${prRef(p)} (${by ? `${by}: ${p.closeReason}` : p.closeReason})`;
      })
      .join("; ");
    out.push({
      level: serious.length || closed.length >= 3 ? "ask" : "note",
      code: "closed-attempts",
      message: `${closed.length} earlier PR${closed.length > 1 ? "s were" : " was"} closed without merging: ${list}${closed.length > 4 ? "; …" : ""}. Read why before trying again.`,
    });
  }

  const prAuthors = new Set(ours.map((p) => p.author));
  const recentCommits = issue.commitRefs.filter((r) => r.daysAgo < issue.claimWindowDays && r.login !== me && !prAuthors.has(r.login));
  for (const login of new Set(recentCommits.map((r) => r.login))) {
    const r = recentCommits.find((x) => x.login === login)!;
    out.push({
      level: "ask",
      code: "recent-commit",
      message: `${login ? `@${login}` : "Someone"} pushed a commit referencing this issue ${ago(r.daysAgo)} (in ${r.repo}) and has no PR yet; they may be working on it.`,
    });
  }

  for (const c of issue.claims) {
    if (c.isViewer) {
      out.push({ level: "ok", code: "claimed-by-you", message: c.via === "assignment" ? "The issue is assigned to you." : `You claimed this issue on ${c.claimedAt.slice(0, 10)}.` });
      continue;
    }
    if (c.released) continue;
    if (c.active) {
      out.push({
        level: "stop",
        code: c.via === "assignment" ? "assigned" : "claimed",
        message: `${c.via === "assignment" ? `The issue is assigned to @${c.login}` : `@${c.login} said they are working on it`} (last activity ${ago(c.daysSinceActivity)}, within the ${issue.claimWindowDays}-day window).`,
      });
    } else if (c.via === "assignment") {
      out.push({
        level: "ask",
        code: "stale-assignment",
        message: `The issue is assigned to @${c.login}, who has not been active on it for ${c.daysSinceActivity} days. Ask a maintainer to reassign it before starting.`,
      });
    } else {
      out.push({
        level: "note",
        code: "expired-claim",
        message: `@${c.login} claimed this on ${c.claimedAt.slice(0, 10)} with no activity for ${c.daysSinceActivity} days (claim expired). Mention that in your PR.`,
      });
    }
  }

  const assignedToMe = me !== null && issue.assignees.includes(me);
  if (rules?.assignment.required && !assignedToMe) {
    const e = rules.assignment.evidence[0];
    out.push({
      level: "ask",
      code: "assignment-required",
      message: `The project asks contributors to be assigned or to claim an issue first${e ? `: "${e.text}" (${e.file}:${e.line})` : ""}.`,
    });
  }
  if (!issue.maintainerEngaged && !issue.labelSignals.positive.length) {
    if (issue.labelSignals.feature.length || rules?.issueFirst.required) {
      out.push({
        level: "ask",
        code: "untriaged-feature",
        message: issue.labelSignals.feature.length
          ? "No maintainer has commented on or accepted this feature request yet. Ask whether a PR is wanted before you build it."
          : "No maintainer has commented on or triaged this issue yet, and the project asks for changes to be discussed first.",
      });
    } else {
      out.push({ level: "note", code: "untriaged", message: "No maintainer has commented on or triaged this issue yet." });
    }
  }
  if (issue.labelSignals.positive.length) {
    out.push({ level: "ok", code: "welcome-label", message: `Labelled ${issue.labelSignals.positive.map((l) => `"${l}"`).join(", ")}.` });
  }
  if (issue.truncated) out.push({ level: "note", code: "truncated", message: "The issue has a long history; only the first 100 comments and events were checked." });
}

export function decide(input: VerdictInput): { verdict: Verdict; reasons: Reason[]; nextSteps: string[] } {
  const reasons: Reason[] = [];
  for (const e of input.errors) reasons.push({ level: "ask", code: "check-failed", message: `Could not finish a check: ${e}` });
  repoReasons(input, reasons);
  issueReasons(input, reasons);
  if (!input.issueRequested) {
    reasons.push({ level: "note", code: "no-issue", message: "No issue given: this covers only the repo's rules. Re-run with the issue number before you start." });
  }
  reasons.sort((a, b) => ORDER[b.level] - ORDER[a.level]);
  const worst = reasons.reduce<Level>((w, r) => (ORDER[r.level] > ORDER[w] ? r.level : w), "ok");
  const verdict: Verdict = worst === "stop" ? "dont" : worst === "ask" ? "comment-first" : "go";
  return { verdict, reasons, nextSteps: nextSteps(verdict, input, reasons) };
}

function nextSteps(verdict: Verdict, input: VerdictInput, reasons: Reason[]): string[] {
  const steps: string[] = [];
  const codes = new Set(reasons.map((r) => r.code));
  if (verdict === "dont") {
    if (codes.has("open-pr") || codes.has("your-open-pr")) steps.push("Review, test or comment on the existing PR instead of opening another one.");
    else if (codes.has("claimed") || codes.has("assigned")) steps.push("Leave this issue to the person working on it, or offer help in a comment. Pick another issue.");
    else steps.push("Do not open a PR for this. Pick another issue or another project.");
  } else if (verdict === "comment-first") {
    steps.push("Comment on the issue first: say what you plan to change and how, and ask whether a PR is welcome. Wait for a maintainer to answer.");
    if (codes.has("assignment-required") || codes.has("stale-assignment")) steps.push("Ask to be assigned, and start only once you are.");
  } else if (input.issueRequested) {
    steps.push("Go ahead. Run this check again right before you open the PR: someone may have opened one in the meantime.");
  } else {
    steps.push("Pick an issue and run this again with its number.");
  }
  if (input.usesAI && verdict !== "dont") {
    if (codes.has("human-written-text")) steps.push("Write the PR description yourself; do not paste AI-generated text.");
    if (codes.has("ai-disclosure") || codes.has("ai-policy-unknown")) steps.push("Add a short, honest note on how AI was used.");
    if (codes.has("no-autonomous-agents")) steps.push("Review the diff yourself and open the PR from your own account by hand.");
  }
  if (codes.has("dco") && verdict !== "dont") steps.push("Sign off your own commits (git commit -s).");
  if (codes.has("cla") && verdict !== "dont") steps.push("Read and sign the CLA yourself when the bot asks.");
  return steps;
}

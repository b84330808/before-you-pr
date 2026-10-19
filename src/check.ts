import { applyClaimWindow, checkIssue, IssueNotFoundError } from "./checks/issue.ts";
import { KeywordRulesAnalyzer } from "./checks/keyword-analyzer.ts";
import { checkMergeFriendliness, checkViewer } from "./checks/merge.ts";
import { applyComplianceSignals, fetchRuleSources, RepoNotFoundError } from "./checks/rules.ts";
import { createDefaultClient, GitHubError, type GitHubClient } from "./github/client.ts";
import type { IssueStatus, RepoRef, Report, RepoRules, RulesAnalyzer } from "./types.ts";
import { parseTarget, repoSlug } from "./util.ts";
import { decide } from "./verdict.ts";
import { NAME, VERSION } from "./version.ts";

export interface CheckOptions {
  /** `owner/name`, a GitHub URL, or a parsed reference. */
  repo: string | RepoRef;
  issue?: number | null;
  /** Whether AI tools help write the change. Defaults to true, so AI policies count fully. */
  usesAI?: boolean;
  client?: GitHubClient;
  analyzer?: RulesAnalyzer;
  now?: Date;
  /** Overrides the claim window; otherwise the repo's stated window or 15 days. */
  claimWindowDays?: number;
  /** Days of merged PRs to look at for merge friendliness. */
  windowDays?: number;
  /** Look up the current user's open PRs and recent pace. Defaults to true. */
  viewer?: boolean;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fatal = (e: unknown) => e instanceof RepoNotFoundError || e instanceof IssueNotFoundError || (e instanceof GitHubError && e.kind !== "api");

/** Runs every check and returns the report with its verdict. */
export async function beforeYouPr(options: CheckOptions): Promise<Report> {
  const target = typeof options.repo === "string" ? parseTarget(options.repo) : { repo: options.repo, issue: null };
  const repo = target.repo;
  const issueNumber = options.issue ?? target.issue ?? null;
  const usesAI = options.usesAI ?? true;
  const now = options.now ?? new Date();
  const client = options.client ?? (await createDefaultClient());
  const analyzer = options.analyzer ?? new KeywordRulesAnalyzer();

  const [sources, merge, viewer, issue] = await Promise.allSettled([
    fetchRuleSources(client, repo),
    checkMergeFriendliness(client, repo, { now, windowDays: options.windowDays }),
    options.viewer === false ? Promise.resolve(null) : checkViewer(client, repo, { now }),
    issueNumber === null ? Promise.resolve(null) : checkIssue(client, repo, issueNumber, { now, claimWindowDays: options.claimWindowDays }),
  ]);

  for (const r of [sources, issue]) if (r.status === "rejected" && fatal(r.reason)) throw r.reason;
  const errors: string[] = [];
  const settled = <T>(r: PromiseSettledResult<T>, what: string): T | null => {
    if (r.status === "fulfilled") return r.value;
    if (fatal(r.reason)) throw r.reason;
    errors.push(`${what}: ${message(r.reason)}`);
    return null;
  };

  const mergeResult = settled(merge, "merge friendliness");
  let rules: RepoRules | null = null;
  const src = settled(sources, "repo rules");
  if (src) {
    try {
      rules = applyComplianceSignals(await analyzer.analyze(src.docs, repo), src, mergeResult?.checkNames ?? []);
    } catch (e) {
      errors.push(`rules analyzer "${analyzer.name}": ${message(e)}`);
    }
  }
  const issueChecked = settled(issue, "issue status");
  let issueResult: IssueStatus | null = issueChecked?.status ?? null;
  if (issueResult && options.claimWindowDays === undefined && rules?.claimWindow) issueResult = applyClaimWindow(issueResult, rules.claimWindow.days);
  const viewerResult = settled(viewer, "your recent PRs");

  const { verdict, reasons, nextSteps } = decide({
    usesAI,
    rules,
    issue: issueResult,
    merge: mergeResult,
    viewer: viewerResult,
    viewerLogin: viewerResult?.login ?? issueChecked?.viewer ?? null,
    errors,
    issueRequested: issueNumber !== null,
  });

  return {
    tool: { name: NAME, version: VERSION },
    repo: repoSlug(repo),
    issueNumber,
    generatedAt: now.toISOString(),
    usesAI,
    verdict,
    reasons,
    nextSteps,
    rules,
    issue: issueResult,
    merge: mergeResult,
    viewer: viewerResult,
    errors,
  };
}

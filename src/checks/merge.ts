import type { GitHubClient } from "../github/client.ts";
import type { MergeFriendliness, RepoRef, ViewerContext } from "../types.ts";
import { isBot, median, OUTSIDE_ASSOCIATIONS } from "../util.ts";

const MERGE_TTL = 6 * 3600;
const VIEWER_TTL = 300;
const SAMPLE = 100;
export const DEFAULT_WINDOW_DAYS = 90;

const MERGE_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    isArchived stargazerCount pushedAt pullRequestCreationPolicy viewerPermission
    merged: pullRequests(states: MERGED, first: ${SAMPLE}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        createdAt updatedAt mergedAt authorAssociation author { __typename login } mergedBy { login }
      }
    }
    checks: pullRequests(states: MERGED, first: 15, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
        nodes { __typename ... on CheckRun { name } ... on StatusContext { context } }
      } } } } } }
    }
    closed: pullRequests(states: CLOSED, first: ${SAMPLE}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { createdAt updatedAt closedAt authorAssociation author { __typename login } }
    }
    open: pullRequests(states: OPEN) { totalCount }
  }
}`;

interface Author {
  __typename: string;
  login: string;
}
interface MergeData {
  repository: {
    isArchived: boolean;
    stargazerCount: number;
    pushedAt: string | null;
    pullRequestCreationPolicy: string | null;
    viewerPermission: string | null;
    merged: {
      nodes: {
        createdAt: string;
        updatedAt: string;
        mergedAt: string;
        authorAssociation: string;
        author: Author | null;
        mergedBy: { login: string } | null;
      }[];
    };
    checks: {
      nodes: { commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: { __typename: string; name?: string; context?: string }[] } } | null } }[] } }[];
    };
    closed: { nodes: { createdAt: string; updatedAt: string; closedAt: string; authorAssociation: string; author: Author | null }[] };
    open: { totalCount: number };
  } | null;
}

const DAY = 86_400_000;
const time = (iso: string) => new Date(iso).getTime();

export async function checkMergeFriendliness(
  client: GitHubClient,
  repo: RepoRef,
  options: { now?: Date; windowDays?: number } = {},
): Promise<MergeFriendliness> {
  const now = options.now ?? new Date();
  const data = await client.graphql<MergeData>(MERGE_QUERY, { owner: repo.owner, name: repo.name }, { ttlSeconds: MERGE_TTL });
  const r = data.repository;
  if (!r) throw new Error(`Repository ${repo.owner}/${repo.name} was not found.`);

  // Each sample holds the most recently updated PRs, so a full sample only covers the time since its oldest
  // update. Merged and closed PRs can cover very different spans, so they are compared as rates per day.
  const coverage = (nodes: { updatedAt: string }[]) => (nodes.length >= SAMPLE ? Math.min(...nodes.map((n) => time(n.updatedAt))) : 0);
  const cutoff = now.getTime() - (options.windowDays ?? DEFAULT_WINDOW_DAYS) * DAY;
  const human = <T extends { author: Author | null }>(xs: T[]) => xs.filter((p) => p.author && !isBot(p.author.login, p.author.__typename));
  let mergedStart = Math.max(cutoff, coverage(r.merged.nodes));
  let merged = human(r.merged.nodes).filter((p) => time(p.mergedAt) >= mergedStart);
  // Slow repos: fall back to the whole sample rather than judging from a handful of PRs.
  if (merged.length < 5 && r.merged.nodes.length > merged.length) {
    merged = human(r.merged.nodes);
    mergedStart = Math.min(mergedStart, ...merged.map((p) => time(p.mergedAt)));
  }
  const closedStart = Math.max(mergedStart, coverage(r.closed.nodes));
  const closed = human(r.closed.nodes).filter((p) => time(p.closedAt) >= closedStart);
  const days = (start: number) => Math.max(1, (now.getTime() - start) / DAY);

  // authorAssociation hides private org members, so anyone who merges PRs counts as an insider too.
  const insiders = new Set(r.merged.nodes.map((p) => p.mergedBy?.login).filter((l): l is string => !!l));
  const isOutside = (p: { authorAssociation: string; author: Author | null }) => OUTSIDE_ASSOCIATIONS.has(p.authorAssociation) && !insiders.has(p.author!.login);
  const external = merged.filter(isOutside);
  const hours = (p: { createdAt: string; mergedAt: string }) => (time(p.mergedAt) - time(p.createdAt)) / 3_600_000;
  const closedExternal = closed.filter(isOutside).length;
  const mergedRate = external.length / days(mergedStart);
  const closedRate = closedExternal / days(closedStart);

  const checkNames = new Set<string>();
  for (const p of r.checks.nodes) {
    for (const c of p.commits.nodes) {
      for (const ctx of c.commit.statusCheckRollup?.contexts.nodes ?? []) {
        const n = ctx.name ?? ctx.context;
        if (n) checkNames.add(n);
      }
    }
  }

  return {
    windowDays: Math.round(days(mergedStart)),
    stars: r.stargazerCount,
    archived: r.isArchived,
    prCreationPolicy: r.pullRequestCreationPolicy === "COLLABORATORS_ONLY" ? "collaborators-only" : "all",
    viewerPermission: r.viewerPermission,
    pushedAt: r.pushedAt,
    merged: { total: merged.length, external: external.length },
    externalShare: merged.length ? external.length / merged.length : null,
    medianHoursToMerge: { external: median(external.map(hours)), all: median(merged.map(hours)) },
    closedUnmerged: { total: closed.length, external: closedExternal, days: Math.round(days(closedStart)) },
    externalAcceptance: mergedRate + closedRate ? mergedRate / (mergedRate + closedRate) : null,
    openPRs: r.open.totalCount,
    checkNames: [...checkNames].sort(),
  };
}

const VIEWER_QUERY = `
query($inRepo: String!, $recent: String!) {
  viewer { login }
  inRepo: search(type: ISSUE, query: $inRepo, first: 1) { issueCount }
  recent: search(type: ISSUE, query: $recent, first: 1) { issueCount }
}`;

/** How many PRs the current user already has open here, and how many they opened in the last day. */
export async function checkViewer(client: GitHubClient, repo: RepoRef, options: { now?: Date } = {}): Promise<ViewerContext> {
  const now = options.now ?? new Date();
  // Round to the hour so the query (and its cache key) is stable for a while.
  const since = new Date(Math.floor((now.getTime() - 86_400_000) / 3_600_000) * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const data = await client.graphql<{ viewer: { login: string } | null; inRepo: { issueCount: number }; recent: { issueCount: number } }>(
    VIEWER_QUERY,
    { inRepo: `repo:${repo.owner}/${repo.name} is:pr is:open author:@me`, recent: `is:pr author:@me created:>=${since}` },
    { ttlSeconds: VIEWER_TTL },
  );
  return { login: data.viewer?.login ?? null, openPRsInRepo: data.inRepo.issueCount, prsLast24h: data.recent.issueCount };
}

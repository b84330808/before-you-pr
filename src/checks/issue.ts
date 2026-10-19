import type { GitHubClient } from "../github/client.ts";
import type { Claim, CloserKind, IssueStatus, LinkedPR, PrState, RepoRef } from "../types.ts";
import { daysSince, excerpt, isBot, MAINTAINER_ASSOCIATIONS } from "../util.ts";

const ISSUE_TTL = 300;
export const DEFAULT_CLAIM_WINDOW_DAYS = 15;

const MAX_CLOSED_WITH_COMMENTS = 20;

// Comments are left out here: bot reports on a single PR can run to hundreds of kilobytes.
// They are fetched afterwards, and only for closed PRs whose close reason we need.
const PR_FIELDS = `
  id number title url state isDraft createdAt updatedAt closedAt mergedAt
  author { __typename login } authorAssociation
  repository { nameWithOwner }
  labels(first: 10) { nodes { name } }
  closedEvents: timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { createdAt actor { __typename login } } } }`;

const CLOSE_COMMENTS_QUERY = `
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest { id comments(last: 4) { nodes { author { __typename login } authorAssociation createdAt url body } } }
  }
}`;

const ISSUE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $prSearch: String!) {
  viewer { login }
  related: search(type: ISSUE, query: $prSearch, first: 10) { nodes { __typename ... on PullRequest { ${PR_FIELDS} } } }
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest { number title url state }
      ... on Issue {
        number title url state stateReason createdAt updatedAt
        author { login } authorAssociation
        labels(first: 30) { nodes { name } }
        assignees(first: 10) { nodes { login } }
        comments(first: 100) { totalCount nodes { author { __typename login } authorAssociation createdAt url body } }
        closedByPullRequestsReferences(first: 50, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }
        timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT, DISCONNECTED_EVENT, ASSIGNED_EVENT, REFERENCED_EVENT]) {
          totalCount
          nodes {
            __typename
            ... on CrossReferencedEvent { createdAt willCloseTarget source { __typename ... on PullRequest { ${PR_FIELDS} } } }
            ... on ConnectedEvent { createdAt subject { __typename ... on PullRequest { ${PR_FIELDS} } } }
            ... on DisconnectedEvent { createdAt subject { __typename ... on PullRequest { number repository { nameWithOwner } } } }
            ... on AssignedEvent { createdAt assignee { __typename ... on User { login } ... on Bot { login } } }
            ... on ReferencedEvent { createdAt actor { login } commitRepository { nameWithOwner } commit { url } }
          }
        }
      }
    }
  }
}`;

interface Actor {
  __typename?: string;
  login: string;
}
interface CommentNode {
  author: Actor | null;
  authorAssociation: string;
  createdAt: string;
  url: string;
  body: string;
}
interface PrNode {
  id: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  author: Actor | null;
  authorAssociation: string;
  repository: { nameWithOwner: string };
  labels: { nodes: { name: string }[] };
  closedEvents: { nodes: { createdAt: string; actor: Actor | null }[] };
}
type TimelineNode =
  | { __typename: "CrossReferencedEvent"; createdAt: string; willCloseTarget: boolean; source: (PrNode & { __typename: string }) | { __typename: string } }
  | { __typename: "ConnectedEvent"; createdAt: string; subject: (PrNode & { __typename: string }) | { __typename: string } }
  | { __typename: "DisconnectedEvent"; createdAt: string; subject: { __typename: string; number?: number; repository?: { nameWithOwner: string } } }
  | { __typename: "AssignedEvent"; createdAt: string; assignee: { login?: string } | null }
  | { __typename: "ReferencedEvent"; createdAt: string; actor: { login: string } | null; commitRepository: { nameWithOwner: string }; commit: { url: string } | null };

interface IssueData {
  viewer: { login: string } | null;
  related: { nodes: ((PrNode & { __typename: string }) | { __typename: string })[] };
  repository: {
    issueOrPullRequest:
      | { __typename: "PullRequest"; number: number; title: string; url: string; state: string }
      | {
          __typename: "Issue";
          number: number;
          title: string;
          url: string;
          state: string;
          stateReason: string | null;
          createdAt: string;
          updatedAt: string;
          author: { login: string } | null;
          authorAssociation: string;
          labels: { nodes: { name: string }[] };
          assignees: { nodes: { login: string }[] };
          comments: { totalCount: number; nodes: CommentNode[] };
          closedByPullRequestsReferences: { nodes: PrNode[] };
          timelineItems: { totalCount: number; nodes: TimelineNode[] };
        }
      | null;
  } | null;
}

export class IssueNotFoundError extends Error {
  constructor(slug: string, number: number) {
    super(`${slug}#${number} was not found.`);
    this.name = "IssueNotFoundError";
  }
}

const CLAIM =
  /\b(?:i(?:'d| would)? (?:like|love|want) to (?:work on|take|tackle|pick|give (?:it|this) a (?:try|shot|go)|try|fix|help with|contribute|submit|implement)|i(?:'ll| will| can| could| am going to|'m going to) (?:work on|take|tackle|pick (?:it|this) up|fix|submit|open|send|try|look into|give (?:it|this) a)|(?:can|could|may) i (?:work on|take|be assigned|get assigned|pick|try|tackle|handle|fix|claim)|assign (?:it |this |this issue )?(?:to )?me\b|please assign\b|i(?:'m| am) (?:working on|on it|taking|currently working)|working on (?:it|this|a fix|a pr)\b|i(?:'ve| have) (?:started|begun) (?:working|on)|is (?:this|it) (?:still )?(?:available|open for|up for grabs))|^\s*[/.](?:take(?:-issue)?|assign|claim)\b|@\w+bot claim\b/im;
const RELEASE =
  /\b(?:no longer (?:working|able|have time)|(?:feel free|free) (?:for anyone )?to (?:take|pick)|unassign me|i (?:won't|will not|can't|cannot) (?:be able to )?(?:work|continue|finish)|giving (?:it|this) up|not (?:working on|pursuing) (?:it|this))\b/i;

/** True when a comment says its author is taking the issue on (quoted text is ignored). */
export function isClaimComment(body: string): boolean {
  return CLAIM.test(stripQuotes(body));
}

/** True when a comment gives a claim back. */
export function isReleaseComment(body: string): boolean {
  return RELEASE.test(stripQuotes(body));
}

function stripQuotes(body: string): string {
  return body
    .replace(/[\u2018\u2019]/g, "'")
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/```[\s\S]*?```/g, " ")
    .slice(0, 600);
}

const REASONS: [RegExp, string][] = [
  [/\bduplicate\b|\bdupe\b|already (?:fixed|addressed|been fixed|resolved|implemented)|supersede|in favou?r of|replaced by|another (?:PR|pull request)|#\d+ (?:already|fixes|covers)/i, "duplicate or superseded"],
  [
    /\bAI\b|\bLLMs?\b|automated (?:account|PRs?|pull requests?|submissions?|tools?|contributions?)|signs of automation|bot behind|no human|\bspam\b|\bslop\b|machine[- ]generated|(?:AI|auto)[- ]generated|generated by (?:an? )?(?:AI|LLM|tool|agent)/i,
    "AI or automation concerns",
  ],
  [/\bCLA\b|\bDCO\b|sign(?:ed)?[- ]off|contributing guidelines?|not assigned|assigned first|assignment|discuss(?:ion)? first|open an issue first/i, "did not follow the contribution process"],
  [/\bstale\b|inactiv\w*|no (?:activity|response|progress)|abandon\w*|closing due to/i, "stale or abandoned"],
  [/won'?t fix|not planned|out of scope|not (?:something|a change|the direction) we|\bdecline\w*|not going to (?:accept|merge)|\breject\w*|not (?:the )?right (?:approach|fix)/i, "change not wanted"],
  [/we'?d (?:rather|prefer)|we (?:would )?prefer|different (?:approach|solution|direction)|better (?:approach|heuristic|solution|way)|as discussed in|bigger discussion|needs? (?:more )?discussion/i, "maintainers want a different approach"],
];

function classifyClose(text: string, labels: string[]): string | null {
  // A label is a deliberate maintainer signal, so it wins over comment wording.
  for (const label of labels) for (const [re, reason] of REASONS) if (re.test(label)) return `${reason} (label "${label}")`;
  for (const [re, reason] of REASONS) if (re.test(text)) return reason;
  return null;
}

function toLinkedPR(
  node: PrNode,
  link: LinkedPR["link"],
  repoSlug: string,
  now: Date,
): LinkedPR {
  const author = node.author?.login ?? null;
  const pr: LinkedPR = {
    repo: node.repository.nameWithOwner,
    sameRepo: node.repository.nameWithOwner.toLowerCase() === repoSlug.toLowerCase(),
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state,
    isDraft: node.isDraft,
    author,
    authorAssociation: node.authorAssociation,
    authorIsBot: isBot(author, node.author?.__typename),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
    mergedAt: node.mergedAt,
    link,
    disconnected: false,
    labels: node.labels.nodes.map((l) => l.name),
    daysSinceUpdate: daysSince(node.updatedAt, now),
  };
  if (node.state === "CLOSED") {
    const closer = node.closedEvents.nodes[0]?.actor ?? null;
    const closedAt = node.closedEvents.nodes[0]?.createdAt ?? node.closedAt;
    let kind: CloserKind = "unknown";
    if (closer) {
      if (closer.login === author) kind = "author";
      else if (isBot(closer.login, closer.__typename)) kind = "bot";
      // Only people with triage rights or more can close someone else's PR.
      else kind = "maintainer";
    }
    pr.closedBy = { login: closer?.login ?? null, kind };
    applyCloseComments(pr, [], closedAt);
  }
  return pr;
}

/** Picks the comment that explains a close and classifies it. */
function applyCloseComments(pr: LinkedPR, all: CommentNode[], closedAt: string | null) {
  const kind = pr.closedBy?.kind ?? "unknown";
  const closer = pr.closedBy?.login ?? null;
  // Skip coverage and CI bot reports unless a bot did the closing.
  const comments = all.filter(
    (c) => (c.author?.login !== pr.author || kind === "author") && (kind === "bot" || !isBot(c.author?.login, c.author?.__typename)),
  );
  const near =
    comments.find((c) => closer && c.author?.login === closer) ??
    [...comments].reverse().find((c) => closedAt && Math.abs(new Date(c.createdAt).getTime() - new Date(closedAt).getTime()) < 2 * 86_400_000);
  if (near) {
    pr.closeComment = { author: near.author?.login ?? null, association: near.authorAssociation, excerpt: excerpt(stripQuotes(near.body), 200), url: near.url };
  }
  const reason = classifyClose(near ? stripQuotes(near.body) : "", pr.labels);
  pr.closeReason = reason ?? (kind === "author" ? "withdrawn by its author" : near ? "no clear reason given" : "closed without a comment");
}

const BLOCKING_LABEL = /wontfix|won't fix|invalid|duplicate|not planned|declined|rejected|out of scope|on hold|blocked|upstream|spam|locked|stale|works as intended|working as intended|not a bug/i;
const NEEDS_DISCUSSION_LABEL =
  /needs?[-: ]?(?:triage|decision|discussion|design|info|more info|reproduction|repro|investigation|consensus|confirmation|feedback|approval|maintainer)|(?:awaiting|waiting)[-: ]?(?:for )?(?:response|feedback|decision|info|author|reply|triage|confirmation|repro\w*|consensus)|question|discussion|proposal|\brfc\b|to be discussed|unconfirmed|untriaged|pending|under consideration/i;
const POSITIVE_LABEL =
  /good first issue|help wanted|accepted|confirmed|ready|approved|prs? welcome|prs? wanted|needs?[-: ]?(?:a )?(?:pr|patch|fix|implementation)\b|contributions? welcome|up for grabs|easy|beginner|first[- ]timers?|hacktoberfest|triaged|bug: confirmed|status: (?:accepted|confirmed)/i;
const FEATURE_LABEL = /feature|enhancement|\bidea\b|request/i;

export function labelSignals(labels: string[]): IssueStatus["labelSignals"] {
  const out: IssueStatus["labelSignals"] = { positive: [], blocking: [], needsDiscussion: [], feature: [] };
  for (const l of labels) {
    if (BLOCKING_LABEL.test(l)) out.blocking.push(l);
    else if (NEEDS_DISCUSSION_LABEL.test(l)) out.needsDiscussion.push(l);
    else if (POSITIVE_LABEL.test(l)) out.positive.push(l);
    if (FEATURE_LABEL.test(l) && !BLOCKING_LABEL.test(l)) out.feature.push(l);
  }
  return out;
}

export async function checkIssue(
  client: GitHubClient,
  repo: RepoRef,
  number: number,
  options: { now?: Date; claimWindowDays?: number } = {},
): Promise<{ status: IssueStatus; viewer: string | null }> {
  const now = options.now ?? new Date();
  const windowDays = options.claimWindowDays ?? DEFAULT_CLAIM_WINDOW_DAYS;
  const slug = `${repo.owner}/${repo.name}`;
  const prSearch = `repo:${slug} is:pr is:open ${number}`;
  const data = await client.graphql<IssueData>(ISSUE_QUERY, { owner: repo.owner, name: repo.name, number, prSearch }, { ttlSeconds: ISSUE_TTL });
  const viewer = data.viewer?.login ?? null;
  const node = data.repository?.issueOrPullRequest;
  if (!node) throw new IssueNotFoundError(slug, number);

  if (node.__typename === "PullRequest") {
    const status: IssueStatus = {
      number: node.number,
      title: node.title,
      url: node.url,
      isPullRequest: true,
      state: node.state,
      stateReason: null,
      author: null,
      createdAt: "",
      updatedAt: "",
      labels: [],
      assignees: [],
      commentCount: 0,
      maintainerEngaged: false,
      labelSignals: { positive: [], blocking: [], needsDiscussion: [], feature: [] },
      prs: [],
      claims: [],
      commitRefs: [],
      claimWindowDays: windowDays,
      truncated: false,
    };
    return { status, viewer };
  }

  // Collect PRs from every source; the strongest link type wins.
  const prs = new Map<string, LinkedPR>();
  const nodeIds = new Map<LinkedPR, { id: string; closedAt: string | null }>();
  const add = (n: PrNode, link: LinkedPR["link"]) => {
    const key = `${n.repository.nameWithOwner}#${n.number}`.toLowerCase();
    if (prs.has(key)) return;
    const pr = toLinkedPR(n, link, slug, now);
    prs.set(key, pr);
    nodeIds.set(pr, { id: n.id, closedAt: n.closedEvents.nodes[0]?.createdAt ?? n.closedAt });
  };
  for (const n of node.closedByPullRequestsReferences.nodes) add(n, "closing-reference");
  const assignedAt = new Map<string, string>();
  const commitRefs: IssueStatus["commitRefs"] = [];
  const disconnected = new Set<string>();
  for (const t of node.timelineItems.nodes) {
    if (t.__typename === "ConnectedEvent" && t.subject.__typename === "PullRequest") add(t.subject as PrNode, "connected");
    if (t.__typename === "CrossReferencedEvent" && t.source.__typename === "PullRequest") add(t.source as PrNode, t.willCloseTarget ? "closing-reference" : "mention");
    if (t.__typename === "DisconnectedEvent" && t.subject.number && t.subject.repository) {
      disconnected.add(`${t.subject.repository.nameWithOwner}#${t.subject.number}`.toLowerCase());
    }
    if (t.__typename === "AssignedEvent" && t.assignee?.login) assignedAt.set(t.assignee.login, t.createdAt);
    if (t.__typename === "ReferencedEvent") {
      commitRefs.push({ login: t.actor?.login ?? null, repo: t.commitRepository.nameWithOwner, at: t.createdAt, url: t.commit?.url ?? "", daysAgo: daysSince(t.createdAt, now) });
    }
  }
  // Open PRs that contain the issue number but never linked it (step 2 of pylint's AGENTS.md).
  for (const n of data.related.nodes) {
    if (n.__typename === "PullRequest" && (n as PrNode).number !== number) add(n as PrNode, "search");
  }
  for (const [key, pr] of prs) if (disconnected.has(key) && pr.link === "connected") pr.disconnected = true;

  const prList = [...prs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const closed = prList.filter((p) => p.state === "CLOSED" && p.sameRepo).slice(0, MAX_CLOSED_WITH_COMMENTS);
  if (closed.length) {
    const ids = closed.map((p) => nodeIds.get(p)!.id);
    const extra = await client.graphql<{ nodes: ({ id: string; comments: { nodes: CommentNode[] } } | null)[] }>(CLOSE_COMMENTS_QUERY, { ids }, { ttlSeconds: ISSUE_TTL });
    const byId = new Map(extra.nodes.filter((n) => n !== null).map((n) => [n.id, n.comments.nodes]));
    for (const p of closed) {
      const meta = nodeIds.get(p)!;
      applyCloseComments(p, byId.get(meta.id) ?? [], meta.closedAt);
    }
  }
  const comments = node.comments.nodes.filter((c) => c.author && !isBot(c.author.login, c.author.__typename));
  const lastActivity = (login: string, since: string): string => {
    let latest = since;
    for (const c of comments) if (c.author?.login === login && c.createdAt > latest) latest = c.createdAt;
    for (const pr of prList) if (pr.author === login && pr.updatedAt > latest) latest = pr.updatedAt;
    for (const ref of commitRefs) if (ref.login === login && ref.at > latest) latest = ref.at;
    const assigned = assignedAt.get(login);
    if (assigned && assigned > latest) latest = assigned;
    return latest;
  };

  const claims: Claim[] = [];
  const seen = new Set<string>();
  for (const login of node.assignees.nodes.map((a) => a.login)) {
    const at = assignedAt.get(login) ?? node.createdAt;
    const last = lastActivity(login, at);
    const days = daysSince(last, now);
    seen.add(login);
    claims.push({
      login,
      association: comments.find((c) => c.author?.login === login)?.authorAssociation ?? "",
      via: "assignment",
      claimedAt: at,
      url: node.url,
      excerpt: "assigned",
      lastActivityAt: last,
      daysSinceActivity: days,
      active: days < windowDays,
      released: false,
      isViewer: login === viewer,
    });
  }
  for (const c of comments) {
    const login = c.author!.login;
    if (seen.has(login)) continue;
    const body = stripQuotes(c.body);
    if (!isClaimComment(c.body)) continue;
    seen.add(login);
    const last = lastActivity(login, c.createdAt);
    const released = comments.some((o) => o.author?.login === login && o.createdAt >= c.createdAt && isReleaseComment(o.body));
    const days = daysSince(last, now);
    claims.push({
      login,
      association: c.authorAssociation,
      via: "comment",
      claimedAt: c.createdAt,
      url: c.url,
      excerpt: excerpt(body, 140),
      lastActivityAt: last,
      daysSinceActivity: days,
      active: !released && days < windowDays,
      released,
      isViewer: login === viewer,
    });
  }

  const labels = node.labels.nodes.map((l) => l.name);
  const status: IssueStatus = {
    number: node.number,
    title: node.title,
    url: node.url,
    isPullRequest: false,
    state: node.state,
    stateReason: node.stateReason,
    author: node.author?.login ?? null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    labels,
    assignees: node.assignees.nodes.map((a) => a.login),
    commentCount: node.comments.totalCount,
    maintainerEngaged: comments.some((c) => MAINTAINER_ASSOCIATIONS.has(c.authorAssociation)) || assignedAt.size > 0,
    labelSignals: labelSignals(labels),
    prs: prList,
    claims,
    commitRefs,
    claimWindowDays: windowDays,
    truncated: node.timelineItems.totalCount > node.timelineItems.nodes.length || node.comments.totalCount > node.comments.nodes.length,
  };
  return { status, viewer };
}

/** Re-evaluates claims against a different window, such as one stated in the repo's own rules. */
export function applyClaimWindow(issue: IssueStatus, days: number): IssueStatus {
  return {
    ...issue,
    claimWindowDays: days,
    claims: issue.claims.map((c) => ({ ...c, active: !c.released && c.daysSinceActivity < days })),
  };
}

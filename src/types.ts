export type Verdict = "go" | "comment-first" | "dont";

/** How much a single finding weighs on the verdict. */
export type Level = "ok" | "note" | "ask" | "stop";

export interface RepoRef {
  owner: string;
  name: string;
}

/** A quoted sentence from one of the repo's documents. */
export interface Evidence {
  /** Path inside the repo, or `owner/other-repo:path` for files from another repo of the same owner. */
  file: string;
  line: number;
  text: string;
  url: string;
}

export type SourceKind =
  | "contributing"
  | "ai-policy"
  | "agent-instructions"
  | "pr-template"
  | "compliance"
  | "workflow";

/** A document the rules analyzer reads. */
export interface RuleDocument {
  path: string;
  kind: SourceKind;
  url: string;
  text: string;
  /** Set when the file lives in another repo of the same owner (the org's `.github`, or a linked guide). */
  fromRepo?: string;
}

export type AiPolicy =
  | "forbidden"
  | "human-written-text-required"
  | "disclosure-required"
  | "allowed"
  | "unclear"
  | "not-stated";

export interface AiRules {
  policy: AiPolicy;
  forbidden: Evidence[];
  humanWrittenText: Evidence[];
  disclosure: Evidence[];
  noAutonomousAgents: Evidence[];
  allowed: Evidence[];
  /** Conditional limits, such as "PRs you cannot explain will be closed". */
  restrictions: Evidence[];
  /** AI-related sentences that matched none of the above. */
  mentions: Evidence[];
}

export interface ComplianceRule {
  required: boolean;
  evidence: Evidence[];
  /** Non-text signals, such as a `license/cla` status check on recent PRs. */
  signals: string[];
}

export interface RepoRules {
  analyzer: string;
  sources: { path: string; kind: SourceKind; url: string; fromRepo?: string }[];
  ai: AiRules;
  cla: ComplianceRule;
  dco: ComplianceRule;
  assignment: {
    /** true: must be assigned or claim first. false: explicitly not needed. null: not stated. */
    required: boolean | null;
    evidence: Evidence[];
    notRequired: Evidence[];
  };
  issueFirst: { required: boolean; evidence: Evidence[] };
  /** Days of inactivity after which a claim expires, if the repo states one. */
  claimWindow: { days: number; evidence: Evidence } | null;
  agentFiles: string[];
  /** Imperative rules about issues and PRs found in AGENTS.md, CLAUDE.md and friends. */
  agentRules: Evidence[];
  /** Contributing guides linked from the docs but hosted elsewhere. */
  externalGuides: string[];
}

/** Turns repo documents into rules. The default is keyword based; an LLM-backed one can replace it. */
export interface RulesAnalyzer {
  readonly name: string;
  analyze(docs: RuleDocument[], repo: RepoRef): RepoRules | Promise<RepoRules>;
}

export type PrState = "OPEN" | "CLOSED" | "MERGED";

export type CloserKind = "author" | "bot" | "maintainer" | "unknown";

export interface LinkedPR {
  repo: string;
  sameRepo: boolean;
  number: number;
  title: string;
  url: string;
  state: PrState;
  isDraft: boolean;
  author: string | null;
  authorAssociation: string;
  authorIsBot: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  /** How the PR is tied to the issue. */
  link: "closing-reference" | "connected" | "mention" | "search";
  disconnected: boolean;
  labels: string[];
  daysSinceUpdate: number;
  closedBy?: { login: string | null; kind: CloserKind };
  /** Short classification of why an unmerged PR was closed. */
  closeReason?: string;
  closeComment?: { author: string | null; association: string; excerpt: string; url: string };
}

export interface Claim {
  login: string;
  association: string;
  via: "comment" | "assignment";
  claimedAt: string;
  url: string;
  excerpt: string;
  lastActivityAt: string;
  daysSinceActivity: number;
  active: boolean;
  released: boolean;
  isViewer: boolean;
}

export interface IssueStatus {
  number: number;
  title: string;
  url: string;
  isPullRequest: boolean;
  state: string;
  stateReason: string | null;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  assignees: string[];
  commentCount: number;
  maintainerEngaged: boolean;
  labelSignals: { positive: string[]; blocking: string[]; needsDiscussion: string[]; feature: string[] };
  prs: LinkedPR[];
  claims: Claim[];
  /** Commits (often in forks) whose message references the issue. */
  commitRefs: { login: string | null; repo: string; at: string; url: string; daysAgo: number }[];
  claimWindowDays: number;
  /** True when the timeline had more items than were read. */
  truncated: boolean;
}

export interface MergeFriendliness {
  windowDays: number;
  stars: number;
  archived: boolean;
  /** "collaborators-only" when the repo lets only collaborators open pull requests. */
  prCreationPolicy: "all" | "collaborators-only";
  /** The current user's permission here, such as READ or WRITE; null when GitHub does not say. */
  viewerPermission: string | null;
  pushedAt: string | null;
  merged: { total: number; external: number };
  externalShare: number | null;
  medianHoursToMerge: { external: number | null; all: number | null };
  /** Unmerged closed PRs over their own span, which can be shorter than windowDays. */
  closedUnmerged: { total: number; external: number; days: number };
  /** Outside PRs merged per day, as a share of outside PRs merged or closed per day. */
  externalAcceptance: number | null;
  openPRs: number;
  /** Status check and commit status names seen on recently merged PRs. */
  checkNames: string[];
}

export interface ViewerContext {
  login: string | null;
  openPRsInRepo: number;
  prsLast24h: number;
}

export interface Reason {
  level: Level;
  code: string;
  message: string;
}

export interface Report {
  tool: { name: string; version: string };
  repo: string;
  issueNumber: number | null;
  generatedAt: string;
  usesAI: boolean;
  verdict: Verdict;
  reasons: Reason[];
  nextSteps: string[];
  rules: RepoRules | null;
  issue: IssueStatus | null;
  merge: MergeFriendliness | null;
  viewer: ViewerContext | null;
  errors: string[];
  /** Present when the report was made for an AI agent to finish (`--agent`, MCP, the skill). */
  agent?: AgentFacts;
}

/** A passage of a rule document, kept for someone to read rather than as a conclusion. */
export interface RuleExcerpt {
  file: string;
  url: string;
  kind: SourceKind;
  /** Headings the passage sits under, joined with " > ". */
  heading: string | null;
  lines: { line: number; text: string }[];
}

/**
 * The split the skill relies on: GitHub data is judged here, written rules are left to the agent.
 * `factsVerdict` uses only structured data (PRs, claims, labels, merges, the user's pace, CLA/DCO
 * bots and files). `excerpts` are the passages of the repo's own rules for the agent to read.
 */
export interface AgentFacts {
  factsVerdict: Verdict;
  factsReasons: Reason[];
  excerpts: RuleExcerpt[];
  instructions: string;
}

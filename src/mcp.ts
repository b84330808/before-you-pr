import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { beforeYouPr } from "./check.ts";
import { applyClaimWindow, checkIssue } from "./checks/issue.ts";
import { KeywordRulesAnalyzer } from "./checks/keyword-analyzer.ts";
import { checkMergeFriendliness } from "./checks/merge.ts";
import { applyComplianceSignals, fetchRuleSources } from "./checks/rules.ts";
import { formatReport } from "./format.ts";
import { createDefaultClient, type GitHubClient } from "./github/client.ts";
import { parseTarget } from "./util.ts";
import { NAME, VERSION } from "./version.ts";

const INSTRUCTIONS = `before-you-pr checks a GitHub repo's contribution rules and an issue's status before any code is written.
Call before_you_pr before you start work on an issue, and again right before a PR is opened.
Follow the verdict: "dont" means do not open a PR (review the existing one or pick another issue); "comment-first" means the human should comment on the issue and wait for a maintainer.
Never sign a CLA, add a DCO sign-off, or open a PR on the user's behalf when the repo requires a human to do it.`;

const repoArg = z.string().describe('Repository as "owner/name" or a GitHub URL.');
const issueArg = z.number().int().positive().describe("Issue number.");
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 1) }] };
}

export interface McpServerOptions {
  /** Clock override, for tests that replay recorded responses. */
  now?: () => Date;
}

export function createMcpServer(getClient: () => Promise<GitHubClient>, options: McpServerOptions = {}): McpServer {
  const now = () => options.now?.() ?? new Date();
  const server = new McpServer({ name: NAME, version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "before_you_pr",
    {
      title: "Should I work on this?",
      description:
        "Full check of a repo (and optionally an issue): AI policy, CLA/DCO, assignment rules, linked PRs in any state, claims, merge friendliness. Returns a go / comment-first / dont verdict with quoted reasons.",
      inputSchema: {
        repo: repoArg,
        issue: issueArg.optional(),
        uses_ai: z.boolean().default(true).describe("Whether AI tools help write the change (true for agents)."),
      },
      annotations: READ_ONLY,
    },
    async ({ repo, issue, uses_ai }) => {
      const target = parseTarget(repo);
      const report = await beforeYouPr({ repo: target.repo, issue: issue ?? target.issue, usesAI: uses_ai, client: await getClient(), now: now() });
      return {
        content: [{ type: "text" as const, text: formatReport(report) }],
        structuredContent: report as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "check_repo_rules",
    {
      title: "Repo contribution rules",
      description: "AI-contribution policy, CLA/DCO, assignment and issue-first rules, with the quoted sentences they come from (CONTRIBUTING, AGENTS.md, CLAUDE.md, PR templates).",
      inputSchema: { repo: repoArg },
      annotations: READ_ONLY,
    },
    async ({ repo }) => {
      const client = await getClient();
      const { repo: ref } = parseTarget(repo);
      const [sources, merge] = await Promise.all([fetchRuleSources(client, ref), checkMergeFriendliness(client, ref, { now: now() }).catch(() => null)]);
      const rules = await new KeywordRulesAnalyzer().analyze(sources.docs, ref);
      return json(applyComplianceSignals(rules, sources, merge?.checkNames ?? []));
    },
  );

  server.registerTool(
    "check_issue",
    {
      title: "Issue status",
      description: "PRs that link or mention the issue in any state (with why closed ones were closed), and who claimed it and whether the claim is still active.",
      inputSchema: {
        repo: repoArg,
        issue: issueArg,
        claim_days: z.number().int().positive().default(15).describe("Days without activity after which a claim expires."),
      },
      annotations: READ_ONLY,
    },
    async ({ repo, issue, claim_days }) => {
      const { status } = await checkIssue(await getClient(), parseTarget(repo).repo, issue, { now: now() });
      return json(applyClaimWindow(status, claim_days));
    },
  );

  server.registerTool(
    "check_merge_friendliness",
    {
      title: "Merge friendliness",
      description: "Share of recently merged PRs from outside contributors, median time to merge, and how many outside PRs were closed unmerged.",
      inputSchema: { repo: repoArg, window_days: z.number().int().positive().default(90) },
      annotations: READ_ONLY,
    },
    async ({ repo, window_days }) => json(await checkMergeFriendliness(await getClient(), parseTarget(repo).repo, { windowDays: window_days, now: now() })),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  let client: Promise<GitHubClient> | null = null;
  const server = createMcpServer(() => (client ??= createDefaultClient()));
  await server.connect(new StdioServerTransport());
}

#!/usr/bin/env node
import { parseArgs } from "node:util";
import { beforeYouPr } from "./check.ts";
import { formatReport } from "./format.ts";
import { createDefaultClient } from "./github/client.ts";
import type { Verdict } from "./types.ts";
import { parseTarget } from "./util.ts";
import { VERSION } from "./version.ts";

const HELP = `before-you-pr ${VERSION}
Check a repo's contribution rules and an issue's status before you write code.

Usage:
  before-you-pr <owner/repo> [issue]     e.g. before-you-pr psf/black 4567
  before-you-pr <issue URL>              e.g. before-you-pr https://github.com/psf/black/issues/4567
  before-you-pr mcp                      start the MCP server on stdio

Options:
  --json             print the full report as JSON
  --no-ai            you write the change and the PR text without AI tools
  --claim-days <n>   days of inactivity after which a claim expires (default: repo rule, else 15)
  --window <n>       days of merged PRs to sample (default: 90)
  --refresh          ignore cached GitHub responses
  --no-color         plain output
  -h, --help         show this help
  -v, --version      show the version

Exit codes: 0 go, 2 comment first, 3 don't, 1 error.
Auth: GITHUB_TOKEN or GH_TOKEN, else \`gh auth token\`.`;

const EXIT: Record<Verdict, number> = { go: 0, "comment-first": 2, dont: 3 };

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "mcp") {
    const { startMcpServer } = await import("./mcp.ts");
    await startMcpServer();
    return -1;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      "no-ai": { type: "boolean" },
      "claim-days": { type: "string" },
      window: { type: "string" },
      refresh: { type: "boolean" },
      "no-color": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || !positionals.length) {
    console.log(HELP);
    return positionals.length || values.help ? 0 : 1;
  }
  const number = (name: string, raw: string | undefined) => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} needs a positive whole number.`);
    return n;
  };

  const target = parseTarget(positionals[0]!, positionals[1]);
  const client = await createDefaultClient({
    refresh: values.refresh,
    onRateLimit: (remaining, resetAt) => {
      if (remaining < 100) console.error(`warning: only ${remaining} GitHub API points left until ${resetAt.toLocaleTimeString()}.`);
    },
  });
  const report = await beforeYouPr({
    repo: target.repo,
    issue: target.issue,
    usesAI: !values["no-ai"],
    client,
    claimWindowDays: number("claim-days", values["claim-days"]),
    windowDays: number("window", values.window),
  });
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report, { color: !values["no-color"] && !process.env.NO_COLOR && process.stdout.isTTY }));
  return EXIT[report.verdict];
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`before-you-pr: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);

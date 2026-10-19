import type { AiPolicy, Evidence, IssueStatus, Level, MergeFriendliness, Report, RepoRules, Verdict } from "./types.ts";
import { formatDuration, pct } from "./util.ts";

export interface FormatOptions {
  color?: boolean;
}

const CODES = { reset: 0, bold: 1, dim: 2, red: 31, green: 32, yellow: 33, cyan: 36 } as const;
type Style = keyof typeof CODES;

function painter(color: boolean) {
  return (style: Style, text: string) => (color ? `\x1b[${CODES[style]}m${text}\x1b[0m` : text);
}

const VERDICT_LABEL: Record<Verdict, { icon: string; text: string; style: Style }> = {
  go: { icon: "✅", text: "GO", style: "green" },
  "comment-first": { icon: "💬", text: "COMMENT & CLAIM FIRST", style: "yellow" },
  dont: { icon: "⛔", text: "DON'T", style: "red" },
};
const LEVEL_MARK: Record<Level, { mark: string; style: Style }> = {
  stop: { mark: "✖", style: "red" },
  ask: { mark: "!", style: "yellow" },
  note: { mark: "·", style: "dim" },
  ok: { mark: "✓", style: "green" },
};
const POLICY_LABEL: Record<AiPolicy, string> = {
  forbidden: "forbidden",
  "human-written-text-required": "allowed, but PR text and comments must be human-written",
  "disclosure-required": "allowed with disclosure",
  allowed: "allowed",
  unclear: "mentioned, but unclear (read the quotes)",
  "not-stated": "not stated",
};

const quote = (e: Evidence) => `"${e.text}" (${e.file}:${e.line})`;

function rulesSection(rules: RepoRules, out: string[], c: ReturnType<typeof painter>) {
  out.push(c("bold", "Repo rules"), c("dim", `  read: ${rules.sources.map((s) => (s.fromRepo ? `${s.fromRepo}:${s.path}` : s.path)).join(", ") || "no contributing docs found"}`));
  out.push(`  AI policy:   ${POLICY_LABEL[rules.ai.policy]}`);
  const aiLines: [string, Evidence[]][] = [
    ["forbidden", rules.ai.forbidden],
    ["human text", rules.ai.humanWrittenText],
    ["disclose", rules.ai.disclosure],
    ["no agents", rules.ai.noAutonomousAgents],
    ["allowed", rules.ai.allowed],
    ["limits", rules.ai.restrictions],
  ];
  for (const [label, evidence] of aiLines) for (const e of evidence.slice(0, 2)) out.push(c("dim", `    ${label.padEnd(10)} ${quote(e)}`));
  if (rules.ai.policy === "unclear") for (const e of rules.ai.mentions.slice(0, 2)) out.push(c("dim", `    mention    ${quote(e)}`));
  const compliance = (name: string, r: RepoRules["cla"]) => {
    out.push(`  ${name.padEnd(12)} ${r.required ? "required" : "not found"}`);
    for (const e of r.evidence.slice(0, 1)) out.push(c("dim", `    ${quote(e)}`));
    for (const s of r.signals.slice(0, 2)) out.push(c("dim", `    ${s}`));
  };
  compliance("CLA:", rules.cla);
  compliance("DCO:", rules.dco);
  const a = rules.assignment;
  out.push(`  Assignment:  ${a.required === true ? "required (be assigned or claim first)" : a.required === false ? "not needed" : "not stated"}`);
  for (const e of (a.required ? a.evidence : a.notRequired).slice(0, 1)) out.push(c("dim", `    ${quote(e)}`));
  if (rules.issueFirst.required) {
    out.push("  Issue first: open or discuss an issue before a PR (at least for larger changes)");
    for (const e of rules.issueFirst.evidence.slice(0, 1)) out.push(c("dim", `    ${quote(e)}`));
  }
  if (rules.claimWindow) out.push(`  Claim window: ${rules.claimWindow.days} days`, c("dim", `    ${quote(rules.claimWindow.evidence)}`));
  if (rules.agentFiles.length) {
    out.push(`  Agent files: ${rules.agentFiles.join(", ")}`);
    for (const e of rules.agentRules.slice(0, 3)) out.push(c("dim", `    ${quote(e)}`));
  }
  for (const g of rules.externalGuides.slice(0, 2)) out.push(c("dim", `  Also read:   ${g}`));
}

function issueSection(issue: IssueStatus, out: string[], c: ReturnType<typeof painter>) {
  out.push(c("bold", `Issue #${issue.number}: ${issue.title}`));
  if (issue.isPullRequest) {
    out.push(`  This number is a pull request (${issue.state.toLowerCase()}).`);
    return;
  }
  const labels = issue.labels.length ? issue.labels.join(", ") : "none";
  out.push(`  ${issue.state.toLowerCase()} · ${issue.commentCount} comments · labels: ${labels}${issue.assignees.length ? ` · assigned: ${issue.assignees.map((a) => `@${a}`).join(", ")}` : ""}`);
  const ours = issue.prs.filter((p) => p.sameRepo);
  if (!ours.length) out.push("  PRs:    none linked or mentioned");
  // Open and merged PRs matter most; long tails of closed attempts are summarised.
  const shown = [...ours.filter((p) => p.state !== "CLOSED"), ...ours.filter((p) => p.state === "CLOSED").slice(0, 5)];
  for (const p of shown) {
    const state = p.state === "OPEN" && p.isDraft ? "DRAFT" : p.state;
    const style: Style = p.state === "OPEN" ? "red" : p.state === "MERGED" ? "cyan" : "dim";
    let line = `  ${c(style, state.padEnd(6))} #${p.number} by @${p.author ?? "ghost"} (${p.authorAssociation.toLowerCase()}), ${p.link.replace("-", " ")}, updated ${p.daysSinceUpdate}d ago`;
    if (p.disconnected) line += ", unlinked";
    out.push(line);
    if (p.state === "CLOSED") {
      const who = p.closedBy?.kind === "author" ? "its author" : p.closedBy?.login ? `@${p.closedBy.login} (${p.closedBy.kind})` : "unknown";
      out.push(c("dim", `         closed by ${who}: ${p.closeReason}${p.closeComment ? ` — "${p.closeComment.excerpt}"` : ""}`));
    }
  }
  if (ours.length > shown.length) out.push(c("dim", `  (+${ours.length - shown.length} more closed PRs)`));
  for (const r of issue.commitRefs.slice(-3)) out.push(c("dim", `  Commit: ${r.login ? `@${r.login}` : "someone"} in ${r.repo}, ${r.daysAgo}d ago`));
  const others = issue.prs.length - ours.length;
  if (others) out.push(c("dim", `  (+${others} PR${others > 1 ? "s" : ""} in other repos mention it)`));
  for (const cl of issue.claims) {
    const state = cl.released ? "released" : cl.active ? c("red", "active") : "expired";
    out.push(`  Claim:  @${cl.login} via ${cl.via} on ${cl.claimedAt.slice(0, 10)}, last active ${cl.daysSinceActivity}d ago → ${state}${cl.isViewer ? " (you)" : ""}`);
    if (cl.via === "comment") out.push(c("dim", `          "${cl.excerpt}"`));
  }
}

function mergeSection(m: MergeFriendliness, out: string[], c: ReturnType<typeof painter>) {
  out.push(c("bold", `Merge friendliness (last ${m.windowDays} days)`));
  out.push(
    `  ${m.merged.total} merged PRs, ${m.merged.external} from outside contributors (${pct(m.externalShare)})`,
    `  median time to merge: ${formatDuration(m.medianHoursToMerge.external)} for outside PRs, ${formatDuration(m.medianHoursToMerge.all)} overall`,
    `  outside PRs closed without merging: ${m.closedUnmerged.external} in the last ${m.closedUnmerged.days} days → acceptance ${pct(m.externalAcceptance)} · ${m.openPRs} PRs open now`,
  );
}

export function formatReport(report: Report, options: FormatOptions = {}): string {
  const c = painter(options.color ?? false);
  const out: string[] = [];
  const v = VERDICT_LABEL[report.verdict];
  const target = report.issueNumber === null ? report.repo : `${report.repo}#${report.issueNumber}`;
  out.push(`${c("bold", "before-you-pr")} ${target}`, "");
  const top = report.reasons.find((r) => r.level !== "ok" && r.level !== "note") ?? null;
  out.push(`${v.icon} ${c("bold", c(v.style, v.text))}${top ? ` — ${top.message}` : ""}`, "");

  const shown = report.reasons.filter((r) => r !== top);
  if (shown.length) {
    out.push(c("bold", "Why"));
    for (const r of shown) out.push(`  ${c(LEVEL_MARK[r.level].style, LEVEL_MARK[r.level].mark)} ${r.message}`);
    out.push("");
  }
  if (report.issue) {
    issueSection(report.issue, out, c);
    out.push("");
  }
  if (report.rules) {
    rulesSection(report.rules, out, c);
    out.push("");
  }
  if (report.merge) {
    mergeSection(report.merge, out, c);
    out.push("");
  }
  out.push(c("bold", "Next steps"));
  report.nextSteps.forEach((s, i) => out.push(`  ${i + 1}. ${s}`));
  if (!report.usesAI) out.push(c("dim", "  (checked as a contribution written without AI tools: --no-ai)"));
  return out.join("\n");
}

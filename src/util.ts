import type { RepoRef } from "./types.ts";

const DAY = 86_400_000;

/** Accepts `owner/name`, `github.com/owner/name`, or an issue/PR URL. */
export function parseTarget(repoArg: string, issueArg?: string): { repo: RepoRef; issue: number | null } {
  const url = repoArg.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:issues|pull)\/(\d+))?(?:[/?#].*)?$/i);
  const plain = repoArg.match(/^([\w.-]+)\/([\w.-]+?)(?:#(\d+))?$/);
  const m = url ?? plain;
  if (!m || !m[1] || !m[2]) throw new Error(`Expected owner/repo or a GitHub URL, got "${repoArg}".`);
  let issue = m[3] ? Number(m[3]) : null;
  if (issueArg !== undefined) {
    const n = issueArg.match(/^#?(\d+)$/) ?? issueArg.match(/\/(?:issues|pull)\/(\d+)/);
    if (!n?.[1]) throw new Error(`Expected an issue number like 123 or #123, got "${issueArg}".`);
    issue = Number(n[1]);
  }
  return { repo: { owner: m[1], name: m[2] }, issue };
}

export const repoSlug = (r: RepoRef) => `${r.owner}/${r.name}`;

export function daysSince(iso: string | null | undefined, now: Date): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY));
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const BOT_LOGIN = /\[bot\]$|^(dependabot|renovate|pre-commit-ci|github-actions|codecov|allcontributors|stale|mergify|netlify|vercel|coderabbitai|copilot)(-|$)|-bot$|^bot-/i;

export function isBot(login: string | null | undefined, typename?: string | null): boolean {
  if (typename === "Bot") return true;
  return !!login && BOT_LOGIN.test(login);
}

export const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
export const OUTSIDE_ASSOCIATIONS = new Set(["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"]);

/** Collapses Markdown into one readable line. */
export function excerpt(text: string, max = 180): string {
  const flat = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " [code] ")
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join(" ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function formatDuration(hours: number | null): string {
  if (hours === null) return "n/a";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);

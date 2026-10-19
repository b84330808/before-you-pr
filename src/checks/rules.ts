import { GitHubError, type GitHubClient } from "../github/client.ts";
import type { RepoRef, RepoRules, RuleDocument, RulesAnalyzer, SourceKind } from "../types.ts";
import { KeywordRulesAnalyzer } from "./keyword-analyzer.ts";
import { links } from "./text.ts";

const RULES_TTL = 6 * 3600;
const MAX_DOCS = 16;
const MAX_BYTES = 400_000;
const MAX_LINKED = 3;

const MAX_SUBDIRS = 6;

const T1 = "entries { name path type }";
const T2 = `entries { name path type object { ... on Tree { ${T1} } } }`;

// First pass: top-level listings only. Docs folders can hold thousands of files, so their
// subfolders are listed in a second pass, and only those whose names suggest contributor docs.
const TREE_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    url
    defaultBranchRef { name }
    root: object(expression: "HEAD:") { ... on Tree { ${T1} } }
    github: object(expression: "HEAD:.github") { ... on Tree { ${T2} } }
    docs: object(expression: "HEAD:docs") { ... on Tree { ${T1} } }
    doc: object(expression: "HEAD:doc") { ... on Tree { ${T1} } }
    documentation: object(expression: "HEAD:documentation") { ... on Tree { ${T1} } }
  }
  org: repository(owner: $owner, name: ".github") {
    root: object(expression: "HEAD:") { ... on Tree { ${T1} } }
    github: object(expression: "HEAD:.github") { ... on Tree { ${T1} } }
    docs: object(expression: "HEAD:docs") { ... on Tree { ${T1} } }
  }
}`;

const DOCS_ROOT = /^(docs?|documentation)$/i;
const CONTRIB_DIR = /contribut|develop|guide|internals|community|process|polic|governance|maintain|hacking|how-?to/i;

interface Entry {
  name: string;
  path: string;
  type: string;
  object?: { entries?: Entry[] } | null;
}
type TreeNode = { entries?: Entry[] } | null;

interface TreeData {
  repository: {
    nameWithOwner: string;
    url: string;
    defaultBranchRef: { name: string } | null;
    root: TreeNode;
    github: TreeNode;
    docs: TreeNode;
    doc: TreeNode;
    documentation: TreeNode;
  } | null;
  org: { root: TreeNode; github: TreeNode; docs: TreeNode } | null;
}

export class RepoNotFoundError extends Error {
  constructor(slug: string) {
    super(`Repository ${slug} was not found, or this token cannot see it.`);
    this.name = "RepoNotFoundError";
  }
}

function flatten(node: TreeNode, out: { path: string; type: string }[] = []): { path: string; type: string }[] {
  for (const e of node?.entries ?? []) {
    out.push({ path: e.path, type: e.type });
    if (e.object) flatten(e.object, out);
  }
  return out;
}

const TEXT_EXT = /\.(md|markdown|mdx|rst|txt|adoc|asciidoc)$|^[^.]+$/i;
const SKIP_DIR =
  /(^|\/)(node_modules|vendor|third[_-]?party|fixtures?|tests?|examples?|locales?|i18n|translations?|changelog|changes|news|release[-_]?notes|blog|_build|build|dist)(\/|$)/i;
const LANG_DIR = /(^|\/)(ja|jp|zh|zh[-_](cn|tw|hans|hant)|ko|fr|de|es|pt|pt[-_]br|ru|it|tr|vi|id|pl|uk|fa|ar|he|th|cs|nl)(\/|$)/i;
const AI_POLICY_STEM =
  /^(?:(?:ai|llm|llms|genai|generative[-_ ]?ai)[-_ ]?(?:polic(?:y|ies)|usage(?:[-_ ]polic(?:y|ies))?|use|contribut\w*|guidelines?|tools?|assist\w*|disclosure)|(?:polic(?:y|ies)|guidelines?)[-_ ]?(?:on[-_ ]|for[-_ ])?(?:ai|llm|genai)|using[-_ ]?ai(?:[-_ ]tools)?)$/;
const AGENT_FILES = new Set(["agents.md", "agent.md", "claude.md", "gemini.md", ".cursorrules", "copilot-instructions.md"]);

/** Decides whether a repo path holds contribution rules, and of what kind. */
export function classifyPath(path: string): SourceKind | null {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  const base = parts[parts.length - 1]!;
  const dirs = parts.slice(0, -1).join("/");
  const stem = base.replace(/\.[^.]+$/, "");
  if (dirs && (SKIP_DIR.test(dirs) || LANG_DIR.test(dirs))) return null;
  if (dirs === ".github/workflows") return /cla|dco|licen[cs]e|sign/.test(stem) && /\.ya?ml$/.test(base) ? "workflow" : null;
  if (AGENT_FILES.has(base)) return parts.length <= 2 ? "agent-instructions" : null;
  if (/^pull_request_template/.test(base) || parts[parts.length - 2] === "pull_request_template") return TEXT_EXT.test(base) ? "pr-template" : null;
  if (/^(cla|individual[-_]?cla|corporate[-_]?cla|dco)$/.test(stem) || base === ".clabot" || base === "dco.yml") return "compliance";
  if (!TEXT_EXT.test(base)) return null;
  if (AI_POLICY_STEM.test(stem)) return "ai-policy";
  if (/release|profiling|fuzz|benchmark/.test(stem)) return null;
  if (/contribut/.test(stem) && !/^contributors?$/.test(stem)) return "contributing";
  if (parts.slice(0, -1).some((d) => /contribut/.test(d))) return "contributing";
  return null;
}

const KIND_RANK: Record<SourceKind, number> = { "ai-policy": 0, contributing: 1, "agent-instructions": 2, "pr-template": 3, compliance: 4, workflow: 5 };

function rank(path: string, kind: SourceKind): number {
  const depth = path.split("/").length;
  const docsPenalty = kind === "contributing" && depth > 2 ? 2 : 0;
  return (KIND_RANK[kind] + docsPenalty) * 10 + depth;
}

export function pickRuleFiles(paths: { path: string; type: string }[]): { path: string; kind: SourceKind }[] {
  const picked = paths
    .filter((p) => p.type === "blob")
    .map((p) => ({ path: p.path, kind: classifyPath(p.path) }))
    .filter((p): p is { path: string; kind: SourceKind } => p.kind !== null)
    .sort((a, b) => rank(a.path, a.kind) - rank(b.path, b.kind) || a.path.localeCompare(b.path));
  // Keep the docs/contributing/* tail from crowding out everything else.
  const nested = picked.filter((p) => p.kind === "contributing" && p.path.split("/").length > 2);
  const keepNested = new Set(nested.slice(0, 8).map((p) => p.path));
  return picked.filter((p) => !(p.kind === "contributing" && p.path.split("/").length > 2) || keepNested.has(p.path)).slice(0, MAX_DOCS);
}

/** Lists two levels below contributor-looking folders at the root and in the docs folders. */
async function listSubdirs(client: GitHubClient, repo: RepoRef, paths: { path: string; type: string }[]): Promise<{ path: string; type: string }[]> {
  const dirs = paths
    .filter((p) => p.type === "tree")
    .filter((p) => {
      const parts = p.path.split("/");
      if (parts.length === 1) return CONTRIB_DIR.test(parts[0]!);
      return parts.length === 2 && DOCS_ROOT.test(parts[0]!) && CONTRIB_DIR.test(parts[1]!) && !LANG_DIR.test(p.path);
    })
    .slice(0, MAX_SUBDIRS);
  if (!dirs.length) return [];
  const vars: Record<string, unknown> = { owner: repo.owner, name: repo.name };
  const fields = dirs.map((d, i) => {
    vars[`e${i}`] = `HEAD:${d.path}`;
    return `d${i}: object(expression: $e${i}) { ... on Tree { ${T2} } }`;
  });
  const query = `query($owner: String!, $name: String!, ${dirs.map((_, i) => `$e${i}: String!`).join(", ")}) {
  repository(owner: $owner, name: $name) { ${fields.join("\n    ")} }
}`;
  try {
    const data = await client.graphql<{ repository: Record<string, TreeNode> | null }>(query, vars, { ttlSeconds: RULES_TTL });
    return dirs.flatMap((_, i) => flatten(data.repository?.[`d${i}`] ?? null));
  } catch (err) {
    // A huge folder can time out; the top-level files are still useful without it.
    if (err instanceof GitHubError && err.kind === "api") return [];
    throw err;
  }
}

async function fetchBlobs(
  client: GitHubClient,
  owner: string,
  name: string,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  const vars: Record<string, unknown> = { owner, name };
  const fields = paths.map((p, i) => {
    vars[`e${i}`] = `HEAD:${p}`;
    return `f${i}: object(expression: $e${i}) { ... on Blob { text byteSize isBinary } }`;
  });
  const query = `query($owner: String!, $name: String!, ${paths.map((_, i) => `$e${i}: String!`).join(", ")}) {
  repository(owner: $owner, name: $name) { ${fields.join("\n    ")} }
}`;
  const data = await client.graphql<{ repository: Record<string, { text: string | null; byteSize: number; isBinary: boolean } | null> | null }>(
    query,
    vars,
    { ttlSeconds: RULES_TTL },
  );
  paths.forEach((p, i) => {
    const blob = data.repository?.[`f${i}`];
    if (blob?.text && !blob.isBinary && blob.byteSize <= MAX_BYTES) out.set(p, blob.text);
  });
  return out;
}

const WORKFLOW_CLA = /contributor-assistant\/github-action|cla-assistant|cla-bot|easycla|cla\/google/i;
const WORKFLOW_DCO = /\bdco\b|signed-off-by|signoff/i;

export interface RuleSources {
  repoUrl: string;
  defaultBranch: string;
  docs: RuleDocument[];
  /** Compliance hints found from file names or workflows rather than prose. */
  fileSignals: { cla: string[]; dco: string[] };
}

export async function fetchRuleSources(client: GitHubClient, repo: RepoRef): Promise<RuleSources> {
  const slug = `${repo.owner}/${repo.name}`;
  const tree = await client.graphql<TreeData>(TREE_QUERY, { owner: repo.owner, name: repo.name }, { ttlSeconds: RULES_TTL });
  const r = tree.repository;
  if (!r) throw new RepoNotFoundError(slug);
  const branch = r.defaultBranchRef?.name ?? "HEAD";

  const paths = [r.root, r.github, r.docs, r.doc, r.documentation].flatMap((n) => flatten(n));
  paths.push(...(await listSubdirs(client, repo, paths)));
  const picked = pickRuleFiles(paths);
  const texts = await fetchBlobs(client, repo.owner, repo.name, picked.map((p) => p.path));

  const docs: RuleDocument[] = [];
  const fileSignals = { cla: [] as string[], dco: [] as string[] };
  for (const p of picked) {
    const text = texts.get(p.path);
    const url = `${r.url}/blob/${branch}/${p.path}`;
    const base = p.path.toLowerCase().split("/").pop()!;
    if (p.kind === "compliance") {
      if (/dco/.test(base)) fileSignals.dco.push(`file: ${p.path}`);
      else fileSignals.cla.push(`file: ${p.path}`);
    }
    if (p.kind === "workflow") {
      if (text && WORKFLOW_CLA.test(text)) fileSignals.cla.push(`workflow: ${p.path}`);
      if (text && WORKFLOW_DCO.test(text)) fileSignals.dco.push(`workflow: ${p.path}`);
      continue;
    }
    if (text !== undefined) docs.push({ path: p.path, kind: p.kind, url, text });
  }

  // GitHub falls back to the owner's .github repo when a repo has no CONTRIBUTING file of its own.
  const hasContributing = docs.some((d) => d.kind === "contributing" || d.kind === "ai-policy");
  if (!hasContributing && tree.org && repo.name.toLowerCase() !== ".github") {
    const orgPaths = [tree.org.root, tree.org.github, tree.org.docs].flatMap((n) => flatten(n));
    const orgPicked = pickRuleFiles(orgPaths).filter((p) => p.kind === "contributing" || p.kind === "ai-policy" || p.kind === "pr-template");
    const orgTexts = await fetchBlobs(client, repo.owner, ".github", orgPicked.map((p) => p.path));
    for (const p of orgPicked) {
      const text = orgTexts.get(p.path);
      if (text !== undefined) {
        docs.push({ path: p.path, kind: p.kind, url: `https://github.com/${repo.owner}/.github/blob/HEAD/${p.path}`, text, fromRepo: `${repo.owner}/.github` });
      }
    }
  }
  docs.push(...(await fetchLinkedDocs(client, repo, docs)));
  return { repoUrl: r.url, defaultBranch: branch, docs, fileSignals };
}

const BLOB_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/#?]+)\/([^#?]+)/i;

/** Follows links to contributing guides kept in another repo of the same owner, such as `containerd/project`. */
async function fetchLinkedDocs(client: GitHubClient, repo: RepoRef, docs: RuleDocument[]): Promise<RuleDocument[]> {
  const seen = new Set(docs.map((d) => `${d.fromRepo ?? `${repo.owner}/${repo.name}`}:${d.path}`.toLowerCase()));
  const targets: { owner: string; name: string; ref: string; path: string; kind: SourceKind }[] = [];
  for (const d of docs) {
    if (d.kind !== "contributing" && d.kind !== "agent-instructions") continue;
    for (const l of links(d.text)) {
      const m = l.url.match(BLOB_URL);
      if (!m || m[1]!.toLowerCase() !== repo.owner.toLowerCase() || m[2]!.toLowerCase() === repo.name.toLowerCase()) continue;
      const path = decodeURIComponent(m[4]!);
      const kind = classifyPath(path);
      const key = `${m[1]}/${m[2]}:${path}`.toLowerCase();
      if ((kind === "contributing" || kind === "ai-policy") && !seen.has(key) && targets.length < MAX_LINKED) {
        seen.add(key);
        targets.push({ owner: m[1]!, name: m[2]!, ref: m[3]!, path, kind });
      }
    }
  }
  if (!targets.length) return [];
  const vars: Record<string, unknown> = {};
  const fields = targets.map((t, i) => {
    Object.assign(vars, { [`o${i}`]: t.owner, [`n${i}`]: t.name, [`e${i}`]: `${t.ref}:${t.path}` });
    return `r${i}: repository(owner: $o${i}, name: $n${i}) { object(expression: $e${i}) { ... on Blob { text byteSize isBinary } } }`;
  });
  const params = targets.map((_, i) => `$o${i}: String!, $n${i}: String!, $e${i}: String!`).join(", ");
  type Blob = { text: string | null; byteSize: number; isBinary: boolean } | null;
  const query = `query(${params}) {\n  ${fields.join("\n  ")}\n}`;
  const data = await client.graphql<Record<string, { object: Blob } | null>>(query, vars, { ttlSeconds: RULES_TTL });
  return targets.flatMap((t, i) => {
    const blob = data[`r${i}`]?.object;
    if (!blob?.text || blob.isBinary || blob.byteSize > MAX_BYTES) return [];
    return [{ path: t.path, kind: t.kind, url: `https://github.com/${t.owner}/${t.name}/blob/${t.ref}/${t.path}`, text: blob.text, fromRepo: `${t.owner}/${t.name}` }];
  });
}

const CHECK_CLA = /\bcla\b|license\/cla|contributor[- ]license|easycla|cla-bot|cla\/google|clabot/i;
const CHECK_DCO = /\bdco\b/i;

/** Adds evidence that lives outside the docs: CLA/DCO bots seen as PR status checks, and config files. */
export function applyComplianceSignals(rules: RepoRules, sources: Pick<RuleSources, "fileSignals">, checkNames: string[]): RepoRules {
  const cla = [...sources.fileSignals.cla, ...checkNames.filter((n) => CHECK_CLA.test(n)).map((n) => `status check on merged PRs: ${n}`)];
  const dco = [...sources.fileSignals.dco, ...checkNames.filter((n) => CHECK_DCO.test(n)).map((n) => `status check on merged PRs: ${n}`)];
  return {
    ...rules,
    cla: { ...rules.cla, signals: cla, required: rules.cla.required || cla.length > 0 },
    dco: { ...rules.dco, signals: dco, required: rules.dco.required || dco.length > 0 },
  };
}

export async function checkRepoRules(
  client: GitHubClient,
  repo: RepoRef,
  options: { analyzer?: RulesAnalyzer; checkNames?: string[] } = {},
): Promise<RepoRules> {
  const sources = await fetchRuleSources(client, repo);
  const analyzer = options.analyzer ?? new KeywordRulesAnalyzer();
  const rules = await analyzer.analyze(sources.docs, repo);
  return applyComplianceSignals(rules, sources, options.checkNames ?? []);
}

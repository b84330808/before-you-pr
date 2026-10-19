import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface QueryOptions {
  /** How long a cached response stays fresh. 0 disables caching for this call. */
  ttlSeconds?: number;
}

export interface GitHubClient {
  graphql<T>(query: string, variables?: Record<string, unknown>, options?: QueryOptions): Promise<T>;
}

export class GitHubError extends Error {
  readonly kind: "auth" | "not-found" | "rate-limit" | "api";
  constructor(kind: GitHubError["kind"], message: string) {
    super(message);
    this.name = "GitHubError";
    this.kind = kind;
  }
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { type?: string; message: string; path?: (string | number)[] }[];
}

/** Stable cache/fixture key for a query and its variables. */
export function queryKey(query: string, variables: Record<string, unknown> = {}): string {
  const vars = Object.keys(variables)
    .sort()
    .map((k) => [k, variables[k]]);
  return createHash("sha256").update(query.replace(/\s+/g, " ").trim()).update(JSON.stringify(vars)).digest("hex").slice(0, 24);
}

/** GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`. */
export async function resolveToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000, windowsHide: true });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // fall through to the error below
  }
  throw new GitHubError(
    "auth",
    "No GitHub token found. Run `gh auth login`, or set GITHUB_TOKEN (a token with no scopes is enough for public repos).",
  );
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BEFORE_YOU_PR_CACHE_DIR) return env.BEFORE_YOU_PR_CACHE_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "before-you-pr", "cache");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "before-you-pr");
}

export interface HttpClientOptions {
  token: string;
  endpoint?: string;
  cacheDir?: string | null;
  /** Skip reading the cache (responses are still written). */
  refresh?: boolean;
  userAgent?: string;
  onRateLimit?: (remaining: number, resetAt: Date) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Talks to the GitHub GraphQL API, with an on-disk TTL cache. */
export class HttpGitHubClient implements GitHubClient {
  readonly #token: string;
  readonly #endpoint: string;
  readonly #cacheDir: string | null;
  readonly #refresh: boolean;
  readonly #userAgent: string;
  readonly #tokenTag: string;
  readonly #onRateLimit?: HttpClientOptions["onRateLimit"];
  rateLimit: { remaining: number; resetAt: Date } | null = null;

  constructor(options: HttpClientOptions) {
    this.#token = options.token;
    this.#endpoint = options.endpoint ?? process.env.GITHUB_GRAPHQL_URL ?? "https://api.github.com/graphql";
    this.#cacheDir = options.cacheDir === undefined ? defaultCacheDir() : options.cacheDir;
    this.#refresh = options.refresh ?? false;
    this.#userAgent = options.userAgent ?? "before-you-pr";
    // Different accounts can see different data, so cache entries are per token.
    this.#tokenTag = createHash("sha256").update(this.#token).digest("hex").slice(0, 12);
    this.#onRateLimit = options.onRateLimit;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}, options: QueryOptions = {}): Promise<T> {
    const ttl = options.ttlSeconds ?? 600;
    const file = this.#cacheDir && ttl > 0 ? join(this.#cacheDir, `${this.#tokenTag}-${queryKey(query, variables)}.json`) : null;
    if (file && !this.#refresh) {
      const hit = await readCache<T>(file, ttl);
      if (hit !== undefined) return hit;
    }
    const data = await this.#post<T>(query, variables);
    if (file) await writeCache(file, data);
    return data;
  }

  async #post<T>(query: string, variables: Record<string, unknown>, attempt = 0): Promise<T> {
    const res = await fetch(this.#endpoint, {
      method: "POST",
      headers: {
        authorization: `bearer ${this.#token}`,
        "content-type": "application/json",
        "user-agent": this.#userAgent,
      },
      body: JSON.stringify({ query, variables }),
    });
    this.#trackRateLimit(res.headers);

    if (res.status === 401) throw new GitHubError("auth", "GitHub rejected the token (401). Run `gh auth login` or check GITHUB_TOKEN.");
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "0");
      if (attempt < 2 && retryAfter > 0 && retryAfter <= 60) {
        await sleep(retryAfter * 1000);
        return this.#post(query, variables, attempt + 1);
      }
      throw new GitHubError("rate-limit", `GitHub rate limit hit (${res.status}). Try again after ${this.rateLimit?.resetAt.toISOString() ?? "a while"}.`);
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(1000 * (attempt + 1));
      return this.#post(query, variables, attempt + 1);
    }
    if (!res.ok) throw new GitHubError("api", `GitHub API returned ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const body = (await res.json()) as GraphQLResponse<T>;
    const errors = body.errors ?? [];
    if (errors.some((e) => e.type === "RATE_LIMITED")) throw new GitHubError("rate-limit", "GitHub GraphQL rate limit exceeded.");
    // GitHub sometimes answers a valid query with "Something went wrong"; a retry usually works.
    if (!body.data && errors.some((e) => /something went wrong/i.test(e.message)) && attempt < 2) {
      await sleep(1000 * (attempt + 1));
      return this.#post(query, variables, attempt + 1);
    }
    // NOT_FOUND for optional fields (an org without a .github repo) is expected; callers check for null.
    const fatal = errors.filter((e) => e.type !== "NOT_FOUND");
    if (!body.data || fatal.length) {
      const message = (fatal[0] ?? errors[0])?.message ?? "empty response";
      throw new GitHubError("api", `GitHub GraphQL error: ${message}`);
    }
    return body.data;
  }

  #trackRateLimit(headers: Headers) {
    const remaining = headers.get("x-ratelimit-remaining");
    const reset = headers.get("x-ratelimit-reset");
    if (remaining === null || reset === null) return;
    this.rateLimit = { remaining: Number(remaining), resetAt: new Date(Number(reset) * 1000) };
    this.#onRateLimit?.(this.rateLimit.remaining, this.rateLimit.resetAt);
  }
}

async function readCache<T>(file: string, ttlSeconds: number): Promise<T | undefined> {
  try {
    const entry = JSON.parse(await readFile(file, "utf8")) as { savedAt: number; data: T };
    if (Date.now() - entry.savedAt <= ttlSeconds * 1000) return entry.data;
  } catch {
    // missing or unreadable cache entry
  }
  return undefined;
}

async function writeCache(file: string, data: unknown): Promise<void> {
  try {
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ savedAt: Date.now(), data }));
    await rename(tmp, file);
  } catch {
    // caching is best effort
  }
}

export async function createDefaultClient(options: Omit<HttpClientOptions, "token"> & { token?: string } = {}): Promise<HttpGitHubClient> {
  const token = options.token ?? (await resolveToken());
  return new HttpGitHubClient({ ...options, token });
}

import { readFile, writeFile } from "node:fs/promises";
import { queryKey, type GitHubClient } from "./client.ts";

export interface FixtureFile {
  recordedAt: string;
  responses: Record<string, { variables: Record<string, unknown>; data: unknown }>;
}

/** Wraps a live client and keeps every response so it can be saved as a test fixture. */
export class RecordingClient implements GitHubClient {
  readonly #inner: GitHubClient;
  readonly fixture: FixtureFile;

  constructor(inner: GitHubClient, recordedAt = new Date()) {
    this.#inner = inner;
    this.fixture = { recordedAt: recordedAt.toISOString(), responses: {} };
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const data = await this.#inner.graphql<T>(query, variables, { ttlSeconds: 0 });
    this.fixture.responses[queryKey(query, variables)] = { variables, data };
    return data;
  }

  async save(file: string): Promise<void> {
    await writeFile(file, `${JSON.stringify(scrubViewer(this.fixture))}\n`);
  }
}

/** Stand-in for the login of whoever recorded a fixture. */
export const FIXTURE_LOGIN = "fixture-user";

/**
 * Removes the recording account from a fixture: its login, its open PR count and its recent PR count.
 * Other people's public activity stays, since the tests are about it.
 */
export function scrubViewer(fixture: FixtureFile): FixtureFile {
  const responses: FixtureFile["responses"] = {};
  for (const [key, { variables, data }] of Object.entries(fixture.responses)) {
    const copy = structuredClone(data) as Record<string, unknown>;
    if (copy.viewer) copy.viewer = { login: FIXTURE_LOGIN };
    for (const field of ["inRepo", "recent"]) if (copy[field] && "inRepo" in copy && "recent" in copy) copy[field] = { issueCount: 0 };
    responses[key] = { variables, data: copy };
  }
  return { ...fixture, responses };
}

/** Answers queries from a recorded fixture; fails loudly on anything that was not recorded. */
export class ReplayClient implements GitHubClient {
  readonly fixture: FixtureFile;

  constructor(fixture: FixtureFile) {
    this.fixture = fixture;
  }

  static async load(file: string): Promise<ReplayClient> {
    return new ReplayClient(JSON.parse(await readFile(file, "utf8")) as FixtureFile);
  }

  get recordedAt(): Date {
    return new Date(this.fixture.recordedAt);
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const hit = this.fixture.responses[queryKey(query, variables)];
    if (!hit) throw new Error(`No recorded response for variables ${JSON.stringify(variables)}; run \`npm run record\`.`);
    return structuredClone(hit.data) as T;
  }
}

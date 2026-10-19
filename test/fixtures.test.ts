import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FIXTURE_LOGIN, scrubViewer, type FixtureFile } from "../src/github/fixtures.ts";

const dir = join(import.meta.dirname, "fixtures");

describe("fixtures", () => {
  it("scrubViewer replaces the recording account and its PR counts", () => {
    const fixture: FixtureFile = {
      recordedAt: "2026-10-19T00:00:00Z",
      responses: {
        a: { variables: {}, data: { viewer: { login: "someone" }, inRepo: { issueCount: 3 }, recent: { issueCount: 9 } } },
        b: { variables: {}, data: { repository: { owner: { login: "kept" } } } },
      },
    };
    const out = scrubViewer(fixture);
    assert.deepEqual(out.responses.a!.data, { viewer: { login: FIXTURE_LOGIN }, inRepo: { issueCount: 0 }, recent: { issueCount: 0 } });
    assert.deepEqual(out.responses.b!.data, { repository: { owner: { login: "kept" } } });
    assert.deepEqual((fixture.responses.a!.data as { viewer: unknown }).viewer, { login: "someone" }, "the input is not modified");
  });

  it("recorded fixtures do not identify who recorded them", async () => {
    for (const f of await readdir(dir)) {
      const fixture = JSON.parse(await readFile(join(dir, f), "utf8")) as FixtureFile;
      for (const { data } of Object.values(fixture.responses)) {
        const d = data as { viewer?: { login: string }; inRepo?: { issueCount: number }; recent?: { issueCount: number } };
        if (d.viewer) assert.equal(d.viewer.login, FIXTURE_LOGIN, f);
        if (d.inRepo) assert.equal(d.inRepo.issueCount, 0, f);
        if (d.recent) assert.equal(d.recent.issueCount, 0, f);
      }
    }
  });
});

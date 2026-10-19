import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReplayClient } from "../src/github/fixtures.ts";
import { createMcpServer } from "../src/mcp.ts";
import { VERSION } from "../src/version.ts";

async function connect(fixture: string) {
  const replay = await ReplayClient.load(join(import.meta.dirname, "fixtures", `${fixture}.json`));
  const server = createMcpServer(async () => replay, { now: () => replay.recordedAt });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { type: string; text: string }[])[0]!.text;

describe("MCP server", () => {
  it("lists read-only tools", async () => {
    const client = await connect("black-5260");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["before_you_pr", "check_issue", "check_merge_friendliness", "check_repo_rules"]);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint));
    assert.match(client.getInstructions() ?? "", /Follow the verdict/);
  });

  it("before_you_pr returns the verdict as text and structured content", async () => {
    const client = await connect("black-5260");
    const result = await client.callTool({ name: "before_you_pr", arguments: { repo: "psf/black", issue: 5260 } });
    assert.match(text(result), /DON'T/);
    assert.equal((result.structuredContent as { verdict: string }).verdict, "dont");
  });

  it("check_issue and check_merge_friendliness return JSON", async () => {
    const client = await connect("black-5260");
    const issue = JSON.parse(text(await client.callTool({ name: "check_issue", arguments: { repo: "psf/black", issue: 5260 } })));
    assert.equal(issue.number, 5260);
    assert.ok(issue.prs.length >= 12);
    const merge = JSON.parse(text(await client.callTool({ name: "check_merge_friendliness", arguments: { repo: "https://github.com/psf/black" } })));
    assert.ok(merge.merged.total > 0);
  });

  it("check_repo_rules quotes its sources", async () => {
    const client = await connect("pydantic-11692");
    const rules = JSON.parse(text(await client.callTool({ name: "check_repo_rules", arguments: { repo: "pydantic/pydantic" } })));
    assert.equal(rules.assignment.required, true);
    assert.match(rules.assignment.evidence[0].url, /^https:\/\/github\.com\/pydantic\/pydantic\/blob\/.+#L\d+$/);
  });
});

describe("package metadata", () => {
  it("keeps VERSION in sync with package.json", async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
    assert.equal(VERSION, pkg.version);
  });
});

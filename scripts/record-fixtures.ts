// Records live GitHub responses for the test scenarios: `npm run record [name...]`.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeYouPr } from "../src/check.ts";
import { createDefaultClient } from "../src/github/client.ts";
import { RecordingClient } from "../src/github/fixtures.ts";
import { SCENARIOS } from "../test/scenarios.ts";

const dir = join(import.meta.dirname, "..", "test", "fixtures");
await mkdir(dir, { recursive: true });
const live = await createDefaultClient({ cacheDir: null });
const only = process.argv.slice(2);

for (const s of SCENARIOS.filter((s) => !only.length || only.includes(s.name))) {
  const now = new Date();
  const recorder = new RecordingClient(live, now);
  const report = await beforeYouPr({ repo: s.repo, issue: s.issue, client: recorder, now });
  await recorder.save(join(dir, `${s.name}.json`));
  console.log(`${s.name}: ${report.verdict} (${Object.keys(recorder.fixture.responses).length} responses)`);
}

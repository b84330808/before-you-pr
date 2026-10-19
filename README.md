# before-you-pr

**An agent skill, with a CLI and an MCP server, that checks a repo's rules and an issue's status before anyone writes code.**

Ask your coding agent "can I work on psf/black#5260?" and before-you-pr answers **go**, **comment & claim first** or **don't**, with a link or a quoted rule behind each reason.

It splits the work between code and the model, each doing what it is good at:

- **Code collects and judges the facts.** A bundled script asks GitHub for:
  - every PR that ever touched the issue (open, merged or closed), and why the closed ones were closed;
  - who has claimed the issue, and whether they are still active;
  - labels, and how often outside PRs get merged;
  - your own PR pace, and CLA/DCO bots.

  These are computed, not guessed.
- **The model reads the rules.** Every repo writes its CONTRIBUTING, AI policy and AGENTS.md differently. So the script only pulls out the relevant passages, with line numbers, and the agent judges them: is AI help allowed, must the PR text be human-written, must you be assigned first, is a CLA or DCO needed.

It only reads. It never opens PRs, posts comments or signs anything, and it tells the agent not to either.

## Quick start

**As a skill in Claude Code:**

```text
/plugin marketplace add b84330808/before-you-pr
/plugin install before-you-pr@before-you-pr
```

Then just ask, for example: "I want to fix https://github.com/pydantic/pydantic/issues/11692. Should I start?"

- The skill runs the check, reads the repo's rules and tells you what to do next. It runs again right before a PR is opened.
- It needs Node.js 20+ and `gh auth login` (or `GITHUB_TOKEN`); there is nothing else to install.
- To install it by hand, copy [`skills/before-you-pr/`](skills/before-you-pr/) into `~/.claude/skills/`.

**From the command line**, the same check looks like this:

```console
$ npx before-you-pr psf/black 5260

⛔ DON'T — PR #5528 by @Kayvan-Zahiri is already open, updated 4 days ago. Review or test it instead of opening a duplicate.

Why
  ✖ PR #5534 by @rajat397 is already open, updated 5 days ago. Review or test it instead of opening a duplicate.
  ! 10 earlier PRs were closed without merging: #5459 by @davidscottpope-gif (closed by @cobaltt7: AI or automation
    concerns (label "spam / ai")); #5443 by @00200200 (closed by @cobaltt7: maintainers want a different approach); …
  · No clear AI policy found; disclose AI assistance anyway and make sure you understand every line.

Issue #5260: `ruff:ignore` should be processed as a pragma in `contains_pragma_comment`
  OPEN   #5528 by @Kayvan-Zahiri (contributor), closing reference, updated 4d ago
  OPEN   #5534 by @rajat397 (none), closing reference, updated 5d ago
  CLOSED #5443 by @00200200 (none), closing reference, updated 19d ago
         closed by @cobaltt7 (maintainer): maintainers want a different approach — "As discussed in
         https://github.com/psf/black/issues/5260, we'd prefer to find a better heuristic that either handles all
         comments, or better detects pragmas without special-cases. …"
  (+8 more closed PRs)

Repo rules
  Issue first: open or discuss an issue before a PR (at least for larger changes)
    "If you are making a large change, please open an issue first to discuss it beforehand." (docs/contributing/the_basics.md:5)

Merge friendliness (last 61 days)
  83 merged PRs, 75 from outside contributors (90%)
  median time to merge: 3.5 days for outside PRs, 3.1 days overall

Next steps
  1. Review, test or comment on the existing PR instead of opening another one.
```

_(Output trimmed and wrapped. It was recorded on 2026-10-19 and is replayed in this repo's tests.)_

## Why I built this

In October 2026 I was contributing to open source with an AI coding assistant. On 19 October [AgentScan](https://github.com/MatteoGabriele/agentscan), a bot that prettier and many other projects run on new PRs, commented on two of my prettier PRs that my account showed signs of automation. Its evidence was accurate. I had forked nine repos in a day, opened PRs seconds after pushing, and commented on an issue and opened a PR in the same repo minutes apart.

The flag was fair, and it made me look at the rush from the maintainers' side. While I was scanning popular repos for issues to fix, the same patterns kept coming up:

- [psf/black#5260](https://github.com/psf/black/issues/5260) had ten closed PRs for one issue, with two more still open.
- sqlfluff runs a bot that closes PRs it thinks have no human behind them. On [one issue](https://github.com/sqlfluff/sqlfluff/issues/8705) it closed four PRs in three days, each within a minute of it being opened.
- Sphinx and Vite want PR descriptions and comments written in your own words. Sphinx also forbids AI agents from opening PRs on their own.
- pydantic automatically closes PRs for issues the author was not assigned to.
- pylint's `AGENTS.md` tells agents to check for open PRs twice and to respect a claim for 15 days.

None of this is hidden, but it is scattered across CONTRIBUTING files, `AGENTS.md`, PR templates, issue timelines and closed PRs. Almost nobody, human or agent, reads all of it before starting. `before-you-pr` reads it for you, shows what it found, and tells you whether to start, to ask first, or to leave the issue alone.

I changed how I work, too. My assistant still prepares and tests a change, but I review it and open the PR myself.

It is deliberately conservative: it will tell you to slow down far more often than to go. It is meant to cut down duplicate and unwanted PRs, not to help anyone produce more of them.

## What it checks

1. **Repo rules.** The skill and the MCP server hand the passages to the agent to judge. The CLI judges them itself, with a strict keyword scan. The rules come from `CONTRIBUTING.*` (root, `.github/`, `docs/`), AI-policy files, `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, PR templates, the org's `.github` repo, and contributing guides linked from another repo of the same owner (such as `containerd/project`).
   - **AI policy:** forbidden, PR text must be human-written, disclosure required, allowed, or not stated. It also flags "no autonomous agents" rules and conditional limits.
   - **CLA / DCO:** from the docs, `.clabot` and `dco.yml` files, CLA/DCO workflows, and the status checks on recently merged PRs (for example `license/cla`).
   - **Assign-first, issue-first and claim-window rules**, and imperative rules in agent instruction files.
2. **Issue status.**
   - Every PR that closes, is connected to, mentions, or contains the issue's number, in any state (open, draft, merged or closed). It uses `closedByPullRequestsReferences(includeClosedPrs: true)`, timeline `CROSS_REFERENCED_EVENT` and `CONNECTED_EVENT`, and a search for unlinked PRs.
   - For each PR closed without merging, who closed it (its author, a bot or a maintainer) and why: duplicate, AI or automation concerns, process not followed, stale, not wanted, or a different approach wanted.
   - Claims: "I'd like to work on this", `/assign`, `.take`, `@rustbot claim`, and assignments. A claim is **active** if its owner did something within the window (a comment, a PR, a commit referencing the issue, or an assignment). The window is the repo's own if it states one, otherwise 15 days, after pylint's rule.
   - Labels such as `needs triage`, `wontfix` or `good first issue`, and whether a maintainer has engaged yet.
3. **Merge friendliness.**
   - The share of recently merged PRs that came from outside contributors (`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`, and not anyone who merges PRs).
   - The median time to merge.
   - How many outside PRs were closed unmerged, compared as per-day rates because the two samples can cover different spans.
4. **Your own pace.** How many PRs you already have open in this repo, and how many you opened in the last 24 hours.

### How the verdict is reached

Each finding has a level, and the strictest one wins.

| Verdict | Typical reasons |
|---|---|
| ⛔ **don't** | an open, linked PR (updated in the last 60 days); an active claim or assignment; the issue is closed or labelled `wontfix`/`duplicate`; the repo forbids AI-generated contributions and you use AI; the repo is archived; you already have a PR for it |
| 💬 **comment & claim first** | the repo requires assignment first; the open PR looks abandoned; a stale assignment; a PR only mentions the issue; someone pushed a commit for it recently; earlier PRs were closed for AI, process or "not wanted" reasons, or three or more were closed; `needs triage` labels; an untriaged feature request; outside PRs rarely get merged; you are opening PRs in a burst; a check failed |
| ✅ **go** | none of the above. Run it again right before you open the PR, because someone may have opened one in the meantime. |

Notes, such as "disclose AI use", "sign off your commits yourself" or "a claim expired, so mention it in your PR", never block, but they are listed in the next steps.

## Command line

Requires Node.js 20 or later (developed on 24), and a GitHub token: `GITHUB_TOKEN`, `GH_TOKEN`, or a logged-in [`gh`](https://cli.github.com/). For public repos a token with no scopes is enough.

```bash
npx before-you-pr sphinx-doc/sphinx 4248
```

```bash
npx before-you-pr https://github.com/pydantic/pydantic/issues/11692 --json
```

The npm package is not published yet. Until it is, run the same CLI from a clone of this repo: `node skills/before-you-pr/scripts/before-you-pr.mjs sphinx-doc/sphinx 4248`.

| Option | Meaning |
|---|---|
| `--json` | the full report as JSON (see [`src/types.ts`](src/types.ts)) |
| `--agent` | compact JSON for an AI agent: the facts-only verdict, rule excerpts to judge, and instructions; this is what the skill uses |
| `--no-ai` | you write the change and the PR text without AI tools, so AI rules become notes |
| `--claim-days <n>` | the claim window in days (default: the repo's stated rule, otherwise 15) |
| `--window <n>` | days of merged PRs to sample (default 90) |
| `--refresh` | ignore cached responses |
| `--no-color` | plain output |

Exit codes: `0` go, `2` comment first, `3` don't, `1` error. That makes it easy to gate a script on the result. With `--agent` the exit code is `0` unless there is an error, because the verdict is in the JSON.

Responses are cached on disk to save API rate limit: rules and merge statistics for 6 hours, issue state and your own PR counts for 5 minutes. The cache lives in `%LOCALAPPDATA%\before-you-pr\cache` on Windows and `~/.cache/before-you-pr` elsewhere; set `BEFORE_YOU_PR_CACHE_DIR` to change it. A full check costs five to eight GraphQL requests.

### As an MCP server

Claude Code:

```bash
claude mcp add before-you-pr -- npx -y before-you-pr mcp
```

Claude Desktop, Cursor and other MCP clients:

```json
{
  "mcpServers": {
    "before-you-pr": { "command": "npx", "args": ["-y", "before-you-pr", "mcp"] }
  }
}
```

| Tool | What it returns |
|---|---|
| `before_you_pr` | the full check as text plus `structuredContent`, with the facts-only verdict and the rule excerpts for the agent to judge |
| `check_repo_rules` | rule passages about AI use, assignment, CLA/DCO and disclosure, with line numbers, plus keyword hints |
| `check_issue` | linked PRs in any state with close reasons, and claims |
| `check_merge_friendliness` | outside-contributor share, median time to merge, closed-unmerged counts |

The server's instructions ask agents to call `before_you_pr` before they start and again before a PR is opened, to follow the verdict, and never to sign a CLA, add a DCO sign-off or open a PR for the user when the repo wants a human to do it.

### As a library

```ts
import { beforeYouPr, formatReport } from "before-you-pr";

const report = await beforeYouPr({ repo: "psf/black", issue: 5260 });
console.log(report.verdict); // "dont"
console.log(formatReport(report));
```

## How the rules are read, and where it can be wrong

Contribution rules are free text with no common format, so before-you-pr does not pretend to understand them with code alone.

**With an agent (the skill or the MCP server):**

1. The script splits each rule file into sentences, keeping track of headings, so a sentence under "AI Policy" counts as AI policy even when it does not say so.
2. It keeps the passages that touch AI use, assignment and claims, CLA/DCO, disclosure, automation and duplicates, with their line numbers. The filter is broad on purpose, and capped at about 16,000 characters.
3. It hands those passages to the agent, together with a verdict built only from GitHub data (`factsVerdict`).
4. The agent decides what the rules say, quotes `file:line`, and takes the stricter of the two verdicts.

For example, Sphinx's PR template says that all interaction must be done by humans, including submitting the PR. A keyword list misses that sentence; a model reading the passage does not.

**On its own (the plain CLI):** a strict keyword analyzer turns the same passages into rules, and every finding links to its file and line.

Keyword matching is easy to fool: [one survey of 703 popular repos](https://github.com/sujeito-operator/ai-contribution-policy) found that half of its keyword hits for "don't open PRs" were not about AI at all. So the analyzer is strict about strong claims:

- "Forbidden" needs an explicit AI term, a code or contribution subject, and no conditions such as "unless", "low-quality" or "that you cannot explain".
- Anything conditional is reported as a limit.
- Mentions of AI tools in agent instruction files do not count as policy.

In the agent output these results appear only as `keywordHints`.

You can also plug your own analyzer into the library by implementing `RulesAnalyzer`:

```ts
import { beforeYouPr, KeywordRulesAnalyzer, type RulesAnalyzer } from "before-you-pr";

const analyzer: RulesAnalyzer = {
  name: "keyword+llm",
  async analyze(docs, repo) {
    const rules = new KeywordRulesAnalyzer().analyze(docs, repo);
    // Ask a model to confirm or correct rules.ai.policy, keeping the quoted evidence.
    return rules;
  },
};
await beforeYouPr({ repo: "sphinx-doc/sphinx", analyzer });
```

Known limits:

- The keyword analyzer only understands English. The agent path can read other languages, as long as the passage filter catches the sentence.
- Only the first 100 comments and timeline events of an issue are read.
- `authorAssociation` hides private org members. Anyone who merged a PR in the sample counts as an insider, but the share of outside PRs can still be a little high.
- The unlinked-PR search only finds PRs that contain the issue number.

## Prior art

| Project | What it does | How before-you-pr differs |
|---|---|---|
| [AgentScan](https://github.com/MatteoGabriele/agentscan) | maintainer-side bot that flags PR authors whose account activity looks automated | runs on the contributor's side, before any PR exists, and looks at the repo and issue rather than the account |
| [goodfirstissue.dev](https://goodfirstissue.dev), [up-for-grabs.net](https://up-for-grabs.net), [CodeTriage](https://www.codetriage.com) | help you find issues to work on | check whether a specific issue is still free and welcome |
| [open-source-ai-contribution-policies](https://github.com/melissawm/open-source-ai-contribution-policies) | curated table of about 190 projects' AI policies | reads the current policy of any repo, with quotes |
| [issue-scout](https://github.com/saihardhikreddy/issue-scout), [should-i-contribute](https://github.com/definitelynotchirag/should-i-contribute) | issue discovery with claim checks; repo-level GO/NO-GO from merge statistics | covers CLA/DCO, `AGENTS.md`/`CLAUDE.md`, claim activity windows, close reasons and an MCP server in one check |
| GitHub's own settings (2026) | maintainers can limit open PRs per user, restrict PRs to collaborators, archive PRs | before-you-pr tells contributors where those limits are coming from before they hit them |

## Roadmap

- A GitHub Action for maintainers that comments when a new PR targets an issue that already has an open PR.
- Measure how often the excerpts contain each repo's real policy, using [open-source-ai-contribution-policies](https://github.com/melissawm/open-source-ai-contribution-policies) as the reference.
- Reading machine-readable policies such as [ai-policy.dev](https://github.com/43081j/ai-policy) frontmatter when repos adopt them.

## Development

```bash
npm install
npm test           # node --test, replaying recorded GitHub responses (needs Node 22.18+ for .ts files)
npm run typecheck
npm run build      # emits dist/
npm run record     # re-records test/fixtures from the live API (needs a token)
npm run bundle     # rebuilds skills/before-you-pr/scripts/before-you-pr.mjs; CI fails if it is out of date
```

The scenario tests replay real responses recorded from psf/black, pylint, sqlfluff, Sphinx, pydantic, Vite and Cherry Studio ([`test/scenarios.ts`](test/scenarios.ts)). Recording replaces your own login and PR counts with placeholders, so fixtures do not show who recorded them.

## 日本語の概要

before-you-pr は、GitHub の issue に取りかかる前に、リポジトリのルールと issue の状況を確認するツールです。確認するのは、AI 利用ポリシー、CLA/DCO、アサイン必須かどうか、状態を問わずその issue に関係する PR、誰が担当を宣言しているか（15 日ルール）、外部コントリビューターの PR がどれだけマージされているか、の六つです。そのうえで「進めてよい」「まずコメントして担当を宣言する」「やめておく」のどれかを、根拠の引用付きで返します。GitHub のデータの集計と判定はプログラムが行い、書式がリポジトリごとに違う規約文はエージェント（LLM）が読んで判断します。Claude Code のスキルとして使えるほか、CLI と MCP サーバーも用意しています。作者は AI アシスタントを使って OSS に貢献していたところ、AgentScan に自動化アカウントの疑いを指摘されました。この経験から、重複した PR や望まれていない PR を減らすために作ったツールです。

## 中文摘要

before-you-pr 會在你動手寫程式之前，先幫你檢查 GitHub repo 的貢獻規則和 issue 的狀態。檢查項目有六項：AI 貢獻政策、CLA/DCO、是否需要先被指派、與該 issue 相關的所有 PR（不分狀態）、誰認領了它以及認領是否仍有效（15 天規則），還有外部貢獻者的 PR 有多少被合併。最後它會給出「可以做」、「先留言認領」或「不要做」三者之一，並附上每個理由的原文出處。GitHub 資料的查詢和判斷由程式負責；每個 repo 寫法都不同的規則文字，則交給 agent（LLM）閱讀判斷。它主要是 Claude Code 的 skill，也提供 CLI 和 MCP server。作者在用 AI 助手參與開源時，帳號被 AgentScan 標記為疑似自動化。這個工具就是為了負責任地貢獻、減少重複和不受歡迎的 PR 而做的。

---

MIT License. Written with help from an AI coding assistant (Claude Code).

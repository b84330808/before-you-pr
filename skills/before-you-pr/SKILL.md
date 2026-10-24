---
name: before-you-pr
description: Checks whether a GitHub issue is free and welcome to work on before any code is written. It finds every PR linked to the issue (open, merged or closed, and why closed ones were rejected), active claims and assignments, and the repo's own rules on AI-assisted contributions, CLA/DCO and assign-first. Use it whenever the user wants to fix, implement or contribute to an issue in a repository they do not maintain, picks an open-source issue to work on, or is about to open a pull request there. Use it again right before the PR is opened.
license: MIT
compatibility: Requires Node.js 20+ and GitHub access through `gh auth login` or GITHUB_TOKEN. Read-only.
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/before-you-pr.mjs *)
---

# Before you PR

This check exists to stop duplicate and unwanted pull requests. Follow its outcome even when it means not doing the task the user asked for. Explain why, and offer a better next step.

## 1. Collect the facts

```bash
node ${CLAUDE_SKILL_DIR}/scripts/before-you-pr.mjs OWNER/REPO ISSUE --agent
```

- `ISSUE` can be a number or an issue URL. Leave it out to check only the repo's rules.
- The script only reads from GitHub. It prints JSON and exits 0, or exits 1 with an error message.
- If it fails because of authentication, ask the user to run `gh auth login`. Never ask for a token in chat.

The JSON has these fields:

| Field | What it is | How much to trust it |
|---|---|---|
| `factsVerdict`, `factsReasons` | verdict from GitHub data only: linked PRs, claims and assignments, labels, outside-contributor merge rate, whether only collaborators can open PRs, the user's own PR pace, CLA/DCO bots | Trust it. It is computed, not guessed. |
| `excerpts` | passages from the repo's CONTRIBUTING, AI-policy, AGENTS.md/CLAUDE.md and PR-template files, with `file`, `url` and line numbers | You judge these (step 2). |
| `keywordHints` | what a keyword scan made of those same files | Hints only. They can be wrong. The text wins. |
| `sources` | every rule file that was read, with URLs | Open one if the excerpts look incomplete. |
| `issue`, `merge`, `viewer` | the details behind the facts | For quoting in your answer. |

## 2. Read the rules yourself

From `excerpts`, decide each of these and note the `file:line` that supports it. Write "not stated" when nothing does.

1. **AI policy.** Are AI-assisted contributions forbidden, allowed only if the PR text and comments are written by a human, allowed with disclosure, allowed, or not stated? May an agent open the PR on its own?
2. **Process.** Must the contributor be assigned, claim the issue, or discuss the change before opening a PR? Is the user already assigned (`issue.assignees`, `viewer.login`)?
3. **Legal.** Is a CLA or a DCO sign-off required?
4. **Anything else the PR must contain**, such as an "AI disclosure" or "Agent Note" section in the PR template.

If a CONTRIBUTING file only points somewhere else (a docs site, another repo), read that page before deciding.

## 3. Decide

The final verdict is the strictest of `factsVerdict` and these rules:

- **dont**: the repo forbids AI-assisted contributions and you are helping write the change.
- **comment-first**:
  - the repo requires assignment, a claim or discussion first, and the user has not done it; or
  - the excerpts are ambiguous about something that would block the PR.
- Requirements such as disclosure, human-written text, a CLA or a DCO sign-off do not block. They go into the next steps.

Order: `dont` beats `comment-first`, which beats `go`.

Tell the user, briefly:

- the verdict;
- the two or three reasons that decided it, each with a link (a PR URL, or the excerpt's `url#L<line>`);
- the next step.

## 4. Act on the verdict

- **dont**:
  - Do not write the fix or open a PR.
  - If an open PR already covers the issue, suggest reviewing or testing it.
  - Otherwise suggest another issue.
- **comment-first**:
  - Draft a short comment for the user: what they plan to change and how, and a request to be assigned.
  - If the repo wants human-written comments, give the user bullet points to put in their own words, not a finished comment.
  - Wait for a maintainer before writing code.
- **go**:
  - Do the work.
  - Run step 1 again right before opening the PR, because someone may have opened one in the meantime.

In every case:

- Never post comments, open PRs or push to someone else's repository unless the user explicitly asks you to. Never do it when the repo says a human must.
- Never sign a CLA, and never add `Signed-off-by` for the user. Tell them it is needed and let them do it.
- If disclosure is required, or the policy is not stated, include one honest line about how AI was used.
- If PR text must be human-written, leave the description to the user and give them notes instead.
- If `factsReasons` includes `pr-burst` or `many-open-prs`, say so and suggest following up on the user's existing PRs first. Bursts of PRs strain reviewers, and bots such as AgentScan flag them as automated.

import type { RuleDocument, RuleExcerpt } from "../types.ts";
import { AI_TERM } from "./keyword-analyzer.ts";
import { segment, type Sentence } from "./text.ts";

// Deliberately broad: these pick passages for a person or a model to read, not conclusions.
const TOPIC =
  /\b(?:assign\w*|claim\w*|permission|ask (?:first|before)|before (?:you )?(?:start|begin|open|submit|work)|discuss\w*|open an issue|issue first|CLAs?|contributor licen[cs]e|DCO|sign(?:ed)?[- ]?off|certificate of origin|disclos\w*|autonomous\w*|bots?|automat\w*|agents?|duplicate\w*|existing (?:PRs?|pull requests?|work)|spam|low[- ]quality|own words|human[- ]written|by a human)\b/i;
const AGENT_SECTION = /pull request|\bPRs?\b|issues?|contribut|before|submit|commit|review/i;
const DCO_CODE = /Signed-off-by:|--signoff\b|\bgit commit\b.*\s-s\b/;

const MAX_PER_SECTION = 25;
const MAX_PER_DOC = 5_000;
const MAX_TOTAL = 16_000;

/**
 * Picks the passages of the rule documents that talk about AI, assignment and claims, CLA/DCO,
 * disclosure, automation and duplicates, with line numbers. Sections under such a heading are kept
 * whole; elsewhere only matching sentences are kept. Agent instruction files mention AI everywhere,
 * so for them AI terms alone do not count.
 */
export function ruleExcerpts(docs: RuleDocument[]): RuleExcerpt[] {
  const out: RuleExcerpt[] = [];
  let total = 0;
  for (const doc of docs) {
    if (doc.kind === "workflow" || doc.kind === "compliance") continue;
    const isAgentDoc = doc.kind === "agent-instructions";
    const topical = (text: string) => TOPIC.test(text) || (!isAgentDoc && AI_TERM.test(text));
    const sections = new Map<string, Sentence[]>();
    for (const s of segment(doc.text)) {
      const key = s.headings.join(" > ");
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key)!.push(s);
    }
    let docChars = 0;
    for (const [heading, sentences] of sections) {
      const lastHeading = heading.split(" > ").pop() ?? "";
      const wholeSection = doc.kind === "ai-policy" || topical(lastHeading) || (isAgentDoc && AGENT_SECTION.test(lastHeading) && sentences.some((s) => topical(s.text)));
      const picked = sentences
        .filter((s) => (s.code ? DCO_CODE.test(s.text) : wholeSection || topical(s.text)))
        .slice(0, MAX_PER_SECTION);
      if (!picked.length) continue;
      const lines = picked.map((s) => ({ line: s.line, text: s.text }));
      const size = lines.reduce((n, l) => n + l.text.length, 0);
      if (docChars + size > MAX_PER_DOC || total + size > MAX_TOTAL) continue;
      docChars += size;
      total += size;
      out.push({
        file: doc.fromRepo ? `${doc.fromRepo}:${doc.path}` : doc.path,
        url: doc.url,
        kind: doc.kind,
        heading: heading || null,
        lines,
      });
    }
  }
  return out;
}

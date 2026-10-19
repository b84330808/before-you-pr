/** A sentence (or one line of code) from a Markdown, reStructuredText or plain-text document. */
export interface Sentence {
  text: string;
  /** 1-based line where the sentence starts. */
  line: number;
  /** Headings the sentence sits under, outermost first. */
  headings: string[];
  code: boolean;
}

const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ADORNMENT = /^([=\-~^"'`#*+:.])\1{2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)]|#\.)\s+/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const BOLD_HEADING = /^\s*(?:\*\*|__)([^*_]{2,60}?[^*_.!?:])(?:\*\*|__):?\s*$/;

/** Inline cleanup that keeps one input line on one output line. */
export function cleanInline(line: string): string {
  return line
    .replace(/<!--|-->/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/`([^`<]+?)\s*<[^>]+>`_{1,2}/g, "$1")
    .replace(/:[a-z]+:`([^`<]+?)(?:\s*<[^>]+>)?`/g, "$1")
    .replace(/``([^`]+)``/g, "$1")
    .replace(/`([^`]+)`_{0,2}/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,:;!?]|$)/g, "$1$2")
    .replace(/^\s*>\s?/, "")
    .replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/g, "")
    .replace(/^\s*\.\.\s+(note|warning|important|tip|attention|caution|admonition)::/i, "")
    .replace(/^\s*!!!\s+\w+(\s+"[^"]*")?/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  const boundary = /[.!?](?=\s+["'(\[*_`]?[A-Z0-9])/g;
  let start = 0;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    const end = m.index + 1;
    // Do not split after common abbreviations.
    if (/\b(e\.g|i\.e|etc|vs|cf|approx|Mr|Ms|Dr|No)\.$/i.test(text.slice(Math.max(0, end - 6), end))) continue;
    out.push({ text: text.slice(start, end), offset: start });
    start = end;
  }
  out.push({ text: text.slice(start), offset: start });
  return out
    .map((s) => {
      const lead = s.text.length - s.text.trimStart().length;
      return { text: s.text.trim(), offset: s.offset + lead };
    })
    .filter((s) => s.text.length > 0);
}

export function segment(doc: string): Sentence[] {
  const lines = doc.replace(/\r\n?/g, "\n").split("\n");
  const sentences: Sentence[] = [];
  const headingStack: { level: number; text: string }[] = [];
  const rstLevels: string[] = [];
  let block: { text: string; line: number }[] = [];
  let fence: string | null = null;
  let rstLiteralIndent: number | null = null;

  const headings = () => headingStack.map((h) => h.text);
  const pushHeading = (level: number, text: string) => {
    while (headingStack.length && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop();
    headingStack.push({ level, text: cleanInline(text) });
  };
  const flush = () => {
    if (!block.length) return;
    let joined = "";
    const starts: { offset: number; line: number }[] = [];
    for (const part of block) {
      if (joined) joined += " ";
      starts.push({ offset: joined.length, line: part.line });
      joined += part.text;
    }
    for (const s of splitSentences(joined)) {
      let line = block[0]!.line;
      for (const st of starts) if (st.offset <= s.offset) line = st.line;
      sentences.push({ text: s.text, line, headings: headings(), code: false });
    }
    block = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;

    if (fence) {
      if (raw.trim().startsWith(fence)) fence = null;
      else if (raw.trim()) sentences.push({ text: raw.trim(), line: lineNo, headings: headings(), code: true });
      continue;
    }
    const fenceMatch = raw.match(FENCE);
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1]!;
      continue;
    }
    if (rstLiteralIndent !== null) {
      const indent = raw.length - raw.trimStart().length;
      if (!raw.trim()) continue;
      if (indent > rstLiteralIndent) {
        sentences.push({ text: raw.trim(), line: lineNo, headings: headings(), code: true });
        continue;
      }
      rstLiteralIndent = null;
    }

    if (!raw.trim()) {
      flush();
      continue;
    }

    const md = raw.match(MD_HEADING);
    if (md) {
      flush();
      pushHeading(md[1]!.length, md[2]!);
      continue;
    }
    // reStructuredText / setext headings: a single text line underlined (and maybe overlined).
    const next = lines[i + 1];
    if (next !== undefined && ADORNMENT.test(next) && !ADORNMENT.test(raw) && block.length === 0 && next.trim().length >= Math.min(3, raw.trim().length)) {
      const ch = next.trim()[0]!;
      const overlined = i > 0 && ADORNMENT.test(lines[i - 1]!) && lines[i - 1]!.trim()[0] === ch;
      const key = overlined ? `^${ch}` : ch;
      if (!rstLevels.includes(key)) rstLevels.push(key);
      pushHeading(rstLevels.indexOf(key) + 1, raw.trim());
      i++;
      continue;
    }
    if (ADORNMENT.test(raw)) continue;
    const bold = raw.match(BOLD_HEADING);
    if (bold && block.length === 0) {
      flush();
      pushHeading(7, bold[1]!);
      continue;
    }

    if (/^\s*\.\.\s+(code-block|code|sourcecode|highlight)::/.test(raw)) {
      flush();
      rstLiteralIndent = raw.length - raw.trimStart().length;
      continue;
    }
    if (/^\s*\.\.\s+_[^:]+:\s*\S/.test(raw)) continue; // rst link target

    if (LIST_ITEM.test(raw) || TABLE_ROW.test(raw)) flush();
    const text = cleanInline(raw.replace(LIST_ITEM, "").replace(/^\s*\|\s*|\s*\|\s*$/g, "").replace(/\s*\|\s*/g, " | "));
    if (text) block.push({ text, line: lineNo });
    if (/::\s*$/.test(raw) && !/^\s*\.\./.test(raw)) {
      flush();
      rstLiteralIndent = raw.length - raw.trimStart().length;
    }
  }
  flush();
  return sentences;
}

/** URLs in a document, with the text that links to them. */
export function links(doc: string): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  for (const m of doc.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) out.push({ text: m[1]!, url: m[2]! });
  for (const m of doc.matchAll(/`([^`<]+?)\s*<(https?:\/\/[^>]+)>`_/g)) out.push({ text: m[1]!, url: m[2]! });
  for (const m of doc.matchAll(/^\.\.\s+_([^:]+):\s*(https?:\/\/\S+)/gm)) out.push({ text: m[1]!, url: m[2]! });
  for (const m of doc.matchAll(/^\[([^\]]+)\]:\s*(https?:\/\/\S+)/gm)) out.push({ text: m[1]!, url: m[2]! });
  return out;
}

import type { Evidence, RepoRef, RepoRules, RuleDocument, RulesAnalyzer } from "../types.ts";
import { links, segment, type Sentence } from "./text.ts";

// "AI" is matched case-sensitively so that words like "ai" in other languages or identifiers do not count.
const AI_TERM =
  /\bAI\b|\bA\.I\.|\bAIs\b|\bai[- ](?:generated|assisted|tools?)\b|\bLLMs?\b|[Ll]arge [Ll]anguage [Mm]odels?|\b[Gg]enerative\b|\bGenAI\b|\bChatGPT\b|\bCopilot\b|\bClaude\b|\bGemini\b|\bCodex\b|[Mm]achine[- ]generated|\b[Aa]gentic\b|\b[Cc]oding agents?\b|\b[Cc]hatbots?\b|\b[Vv]ibe[- ]cod|[Nn]atural [Ll]anguage [Pp]rocessing|[Aa]rtificial [Ii]ntelligence/;

const PROHIBIT =
  /\b(?:prohibit(?:ed|s)?|forbid(?:den|s)?|banned|disallow(?:ed)?|unacceptable|not acceptable|declines? to accept|refuses? to accept)\b|\bban(?:s)? (?:on |the use of )?(?:AI|LLMs?|generative)|\bno (?:AI|LLMs?)\b(?! (?:policy|tools? (?:is|are) (?:required|needed)))/i;
const NOT_ALLOWED =
  /\b(?:not|never|no longer)\b[^.;]{0,40}\b(?:accept(?:ed)?|allow(?:ed)?|permit(?:ted)?|welcome[d]?|merge[d]?|tolerate[d]?|considered)\b|\b(?:must not|may not|cannot|can't|do not|don't)\s+(?:use|submit|open|send|contribute)\b/i;
const CLOSE_REJECT =
  /\b(?:will|may|might|can) be (?:closed|rejected|declined|ignored|removed|deleted|locked)\b|\b(?:we|maintainers|the team) (?:will|may|might|can) (?:close|reject|decline|ignore)\b|\breject(?:ed|s)?\b/i;
const CONDITION =
  /\b(?:unless|undisclosed|unreviewed|unverified|untested|fully|entirely|purely|mostly|wholly|solely|primarily|autonomous(?:ly)?|low[- ]quality|slop|spam|bulk|mass|incoherent|nonsensical|blindly|copy[- ]?past\w*|if (?:you|the|it|they|we|a|an|these|this)|when (?:you|the|it|they|a|an)|that (?:you )?(?:do not|don't|cannot|can't|can not)|which (?:do|does) not|does not (?:include|meet)|doesn't|do not meet|don't meet|not meet|reserve the right|at our discretion|or not|regardless|without (?:a |any |proper |careful )?(?:disclos\w*|human|understand\w*|testing|verif\w*|explanation|context|rationale|attribution|being|having|careful|checking))\b/i;
const OBLIGATION = /\b(?:must|should|need to|needs to|required|requires|please|expected|ask (?:you|contributors|that you) to|have to|has to)\b/i;
const TEXT_SUBJECT =
  /\b(?:PR|pull[- ]requests?|issues?|commits?)\s+(?:descriptions?|text|bodies|body|titles?|summar(?:y|ies)|messages?)\b|\b(?:descriptions?|comments|communications?|discussions?|replies|responses|messages)\b|\bspeak for you\b|\bown words\b/i;
const HUMAN_TEXT =
  /\bown words\b|\bspeak for you\b|\bwritten by (?:a )?(?:human|you|yourself)\b|\bhuman[- ](?:written|authored)\b|\b(?:do not|don't|never|must not|should not|shouldn't|may not|please don't|please do not|avoid)\b[^.;]{0,40}\b(?:use|let|using)\b[^.;]{0,40}?(?:AI|LLMs?|an LLM|ChatGPT|chatbots?|generative)\b[^.;]{0,60}\b(?:write|writing|generate|speak|draft|compose|respond|reply|answer|communicat\w*|explain|for you)/i;
const CODE_SUBJECT = /\b(?:code|contributions?|patch(?:es)?|changes|submissions?|pull requests?|PRs?)\b/i;
const DISCLOSE_VERB = /\bdisclos(?:e|ed|es|ure|ing)\b|\bAssisted-by\b|\bGenerated-by\b/i;
const DISCLOSE_SOFT =
  /\b(?:declare|state|mention|indicate|specify|document|label|tag|flag|acknowledge|reveal|note)\b[^.;]{0,30}\b(?:whether|which|if|how|the use|use of|usage|any use)\b/i;
const SECURITY = /\b(?:security|vulnerabilit\w*|responsible disclosure|coordinated disclosure|CVE)\b/i;
const AGENT =
  /\b(?:autonomous(?:ly)?|fully[- ]automated|unattended|automated (?:PRs?|pull requests?|accounts?|submissions?|contributions?)|AI agents?|coding agents?|agents?)\b/i;
const HUMAN_LOOP = /\bhuman must\b|\bmust be (?:reviewed|submitted|opened|checked) by a human\b|\bhuman[- ]in[- ]the[- ]loop\b|\ba human (?:must|needs to|has to|should) (?:review|check|submit|open)/i;
const ALLOW =
  /\b(?:welcome[ds]?|allowed|permitted|acceptable|fine|okay|encourage[ds]?|(?:can|may) use|free to use|feel free to use|are free to|not (?:prohibited|forbidden|banned))\b/i;
const USAGE = /\b(?:use|uses|using|usage|assist\w*|tools?|help)\b/i;
const RESPONSIBILITY =
  /\b(?:must|should|need to|needs to|have to|expected to)\b[^.;]{0,40}\b(?:understand|explain|review|verify|test|own)\b|\bresponsib(?:le|ility)\b|\baccountable\b/i;

const ASSIGN_NOT_REQUIRED = [
  /\b(?:do not|don't|no) need (?:to )?(?:ask(?:ing)? )?(?:for )?(?:permission|to be assigned|assignment|to (?:ask|claim|get assigned|be assigned))\b/i,
  /\bno need to (?:ask|claim|be assigned|get assigned|comment)\b/i,
  /\bwe (?:do not|don't|won't|will not) assign\b/i,
  /\b(?:do not|don't|please don't|please do not)\b[^.;]{0,20}\b(?:ask|comment)\b[^.;]{0,30}\b(?:to be assigned|for assignment|to claim|assign(?:ed)? to you|if you can (?:work|take))/i,
  /\b(?:can|may|feel free to|are welcome to)\b[^.;]{0,40}\bwithout (?:asking|being assigned|waiting|permission)\b/i,
];
const ASSIGN_REQUIRED = [
  /\bwithout (?:first )?(?:being |having been |getting )?assigned\b/i,
  /\b(?:must|need to|needs to|should|have to|please|required to)\b[^.;]{0,50}\b(?:be assigned|get assigned|ask (?:to be|for (?:it|the issue|an issue) to be) assigned|request (?:to be )?assign\w*|wait (?:to be|until (?:you are|you're)|for (?:an? )?(?:maintainer|assignment|approval)))/i,
  /\b(?:comment|ask|let us know|tell us)\b[^.;]{0,60}\b(?:before|prior to)\b[^.;]{0,40}\b(?:start|work|begin|open|submit|creat|send)/i,
  /\bonly (?:work on|pick up|take|start on)\b[^.;]{0,40}\bassigned\b/i,
  /\b(?:unassigned|not assigned)\b[^.;]{0,60}\b(?:closed|rejected|declined|not (?:be )?(?:accepted|reviewed|merged))/i,
  /\bassign(?:ed)? (?:it|the issue|this(?: issue)?) to (?:you|yourself)\b/i,
];
const ISSUE_FIRST = [
  /\b(?:open|create|file|start|raise|submit)\s+(?:an?\s+|a new\s+)?(?:[\w-]+\s+)?(?:issue|discussion|suggestion|feature request|proposal|RFC)\b[^.;]{0,80}\b(?:before|first|prior to|beforehand)\b/i,
  /\b(?:discuss|discussed|discussion|agree|agreed|approval|approved)\b[^.;]{0,60}\bbefore\b[^.;]{0,50}\b(?:PR|pull request|submit|start|implement|work|writ|open|creat)/i,
  /\bhave it approved before\b/i,
];
const NOT_NEEDED = /\b(?:no need|not necessary|do not need|don't need|not required|isn't required|is not required)\b/i;

const CLA = /\bCLAs?\b|[Cc]ontributor [Ll]icen[cs]e [Aa]greement|cla-assistant|cla\.developers\.google|\bEasyCLA\b|\bcla-bot\b|\bclabot\b/;
const NO_CLA = /\b(?:no|not|without|don't|do not|doesn't|does not|never)\b[^.;]{0,30}(?:\bCLA\b|contributor license agreement)/i;
const DCO =
  /Developer Certificate of Origin|\bDCO\b|Signed-off-by|--signoff\b|\bgit commit\b[^.;]{0,20}\s-s\b|\bsign[- ]?off\b[^.;]{0,30}\bcommits?\b|\bcommits?\b[^.;]{0,30}\bsign(?:ed)?[- ]?off\b/i;
const DCO_CODE = /Signed-off-by:|--signoff\b|\bgit commit\b.*\s-s\b/;

const CLAIM_CONTEXT = /\b(?:claim\w*|assign\w*|unassign\w*|reassign\w*|abandon\w*|working on)\b/i;
const AGENT_RULE_TOPIC = /\b(?:issues?|pull requests?|PRs?|claim\w*|assign\w*|disclos\w*|co-authored|commit messages?|sign\w*|duplicates?|existing work)\b/i;
const IMPERATIVE = /\b(?:do not|don't|never|must|always|rule|stop)\b/i;
const GUIDE_LINK = /contribut|devguide|developer[- ]guide|development[- ]guide|ai[- ]?polic|ai[- ]tools/i;

interface Hit {
  doc: RuleDocument;
  s: Sentence;
}

function evidence(repo: RepoRef, { doc, s }: Hit): Evidence {
  const max = 280;
  const text = s.text.length > max ? `${s.text.slice(0, max - 1).trimEnd()}…` : s.text;
  return { file: doc.fromRepo ? `${doc.fromRepo}:${doc.path}` : doc.path, line: s.line, text, url: `${doc.url}#L${s.line}` };
}

function windowDays(text: string): number | null {
  const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4 };
  const days = text.match(/\b(\d{1,3})\s*(?:calendar |business )?days?\b/i);
  if (days) return Number(days[1]);
  const weeks = text.match(/\b(\d{1,2}|a|one|two|three|four)\s*weeks?\b/i);
  if (weeks) return (Number(weeks[1]) || words[weeks[1]!.toLowerCase()] || 1) * 7;
  return null;
}

/** Default analyzer: sentence-level keyword rules that always quote what they matched. */
export class KeywordRulesAnalyzer implements RulesAnalyzer {
  readonly name = "keyword";

  analyze(docs: RuleDocument[], repo: RepoRef): RepoRules {
    const ai = {
      forbidden: [] as Hit[],
      humanWrittenText: [] as Hit[],
      disclosure: [] as Hit[],
      noAutonomousAgents: [] as Hit[],
      allowed: [] as Hit[],
      restrictions: [] as Hit[],
      mentions: [] as Hit[],
    };
    const cla: Hit[] = [];
    const dco: Hit[] = [];
    const assignRequired: Hit[] = [];
    const assignNotRequired: Hit[] = [];
    const issueFirst: Hit[] = [];
    const agentRules: Hit[] = [];
    let claimWindow: { days: number; hit: Hit } | null = null;
    const externalGuides = new Set<string>();

    for (const doc of docs) {
      if (doc.kind === "workflow") continue;
      const sentences = segment(doc.text);
      for (const s of sentences) {
        const hit = { doc, s };
        const t = s.text;
        if (s.code) {
          if (DCO_CODE.test(t)) dco.push(hit);
          continue;
        }
        if (CLA.test(t) && !NO_CLA.test(t)) cla.push(hit);
        if (DCO.test(t)) dco.push(hit);

        const aiInSentence = AI_TERM.test(t);
        // Agent instruction files are addressed to AI by definition, so their headings say nothing about policy.
        const aiContext =
          aiInSentence || doc.kind === "ai-policy" || (doc.kind !== "agent-instructions" && s.headings.some((h) => AI_TERM.test(h)));
        if (aiContext) this.#classifyAi(hit, aiInSentence, ai);

        if (ASSIGN_NOT_REQUIRED.some((re) => re.test(t))) assignNotRequired.push(hit);
        else if (ASSIGN_REQUIRED.some((re) => re.test(t))) assignRequired.push(hit);
        if (ISSUE_FIRST.some((re) => re.test(t)) && !NOT_NEEDED.test(t)) issueFirst.push(hit);

        if (!claimWindow && CLAIM_CONTEXT.test(t)) {
          const days = windowDays(t);
          if (days && days >= 1 && days <= 365) claimWindow = { days, hit };
        }
        if (doc.kind === "agent-instructions" && AGENT_RULE_TOPIC.test(t) && IMPERATIVE.test(t) && t.length > 20) agentRules.push(hit);
      }
      if (doc.kind === "contributing" || doc.kind === "agent-instructions") {
        for (const l of links(doc.text)) {
          if ((GUIDE_LINK.test(l.text) || GUIDE_LINK.test(l.url)) && isProjectSite(l.url, repo)) externalGuides.add(l.url);
        }
      }
    }

    const ev = (hits: Hit[], max = 4) => dedupe(hits.map((h) => evidence(repo, h))).slice(0, max);
    const aiOut = {
      forbidden: ev(ai.forbidden),
      humanWrittenText: ev(ai.humanWrittenText),
      disclosure: ev(ai.disclosure),
      noAutonomousAgents: ev(ai.noAutonomousAgents),
      allowed: ev(ai.allowed),
      restrictions: ev(ai.restrictions),
      mentions: ev(ai.mentions, 3),
    };
    const policy = aiOut.forbidden.length
      ? "forbidden"
      : aiOut.humanWrittenText.length
        ? "human-written-text-required"
        : aiOut.disclosure.length
          ? "disclosure-required"
          : aiOut.allowed.length || aiOut.restrictions.length || aiOut.noAutonomousAgents.length
            ? "allowed"
            : aiOut.mentions.length
              ? "unclear"
              : "not-stated";

    return {
      analyzer: this.name,
      sources: docs.map((d) => ({ path: d.path, kind: d.kind, url: d.url, ...(d.fromRepo ? { fromRepo: d.fromRepo } : {}) })),
      ai: { policy, ...aiOut },
      cla: { required: cla.length > 0, evidence: ev(cla, 3), signals: [] },
      dco: { required: dco.length > 0, evidence: ev(dco, 3), signals: [] },
      assignment: {
        required: assignRequired.length ? true : assignNotRequired.length ? false : null,
        evidence: ev(assignRequired, 3),
        notRequired: ev(assignNotRequired, 2),
      },
      issueFirst: { required: issueFirst.length > 0, evidence: ev(issueFirst, 3) },
      claimWindow: claimWindow ? { days: claimWindow.days, evidence: evidence(repo, claimWindow.hit) } : null,
      agentFiles: docs.filter((d) => d.kind === "agent-instructions").map((d) => d.path),
      agentRules: ev(agentRules, 6),
      externalGuides: [...externalGuides].slice(0, 5),
    };
  }

  #classifyAi(hit: Hit, aiInSentence: boolean, out: Record<"forbidden" | "humanWrittenText" | "disclosure" | "noAutonomousAgents" | "allowed" | "restrictions" | "mentions", Hit[]>) {
    const t = hit.s.text;
    const prohibits = PROHIBIT.test(t) || NOT_ALLOWED.test(t);
    const rejects = CLOSE_REJECT.test(t);
    const conditional = CONDITION.test(t);
    let classified = false;

    if ((AGENT.test(t) && (prohibits || rejects)) || HUMAN_LOOP.test(t)) {
      out.noAutonomousAgents.push(hit);
      classified = true;
    }
    const textRule = TEXT_SUBJECT.test(t) && (HUMAN_TEXT.test(t) || (prohibits && aiInSentence));
    if (textRule) {
      out.humanWrittenText.push(hit);
      classified = true;
    }
    if ((DISCLOSE_VERB.test(t) || (DISCLOSE_SOFT.test(t) && OBLIGATION.test(t))) && !SECURITY.test(t)) {
      out.disclosure.push(hit);
      classified = true;
    }
    if (!classified && (prohibits || rejects) && hit.doc.kind !== "agent-instructions") {
      // "Forbidden" is a strong claim: it needs an explicit AI term, a code/contribution subject and no conditions.
      const blanket = aiInSentence && CODE_SUBJECT.test(t) && !conditional && !/\bresult in\b/i.test(t);
      if (blanket) out.forbidden.push(hit);
      else out.restrictions.push(hit);
      classified = true;
    }
    if (!classified && ALLOW.test(t) && USAGE.test(t) && aiInSentence) {
      out.allowed.push(hit);
      classified = true;
    }
    // Agent instruction files mention AI tools for operational reasons; only clear rules count from them.
    if (hit.doc.kind === "agent-instructions") return;
    if (!classified && RESPONSIBILITY.test(t)) {
      out.restrictions.push(hit);
      classified = true;
    }
    if (!classified && aiInSentence) out.mentions.push(hit);
  }
}

/** True for the project's own docs site or org pages, not for this repo's files or other projects. */
function isProjectSite(url: string, repo: RepoRef): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const owner = repo.owner.toLowerCase();
  const name = repo.name.toLowerCase().replace(/\.(js|py|rs)$/, "");
  if (u.hostname === "github.com") {
    const [o, n] = u.pathname.toLowerCase().split("/").filter(Boolean);
    return o === owner && n !== name;
  }
  const host = u.hostname.toLowerCase();
  return host.includes(name) || host.includes(owner);
}

function dedupe(items: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return items.filter((e) => {
    const k = e.text.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

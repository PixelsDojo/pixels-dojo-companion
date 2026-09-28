import { askOllama, OllamaUnavailableError } from "./ollama";

// ---------------------------------------------------------------------------
// Number helpers
// ---------------------------------------------------------------------------

// Strip list ordinals (e.g. "1. " at line start) before number extraction.
function stripOrdinals(text: string): string {
  return text.replace(/^\s*\d+\.\s+/gm, "");
}

// Normalize a number token: remove commas, expand k suffix.
// Returns null if not a valid number.
function normalizeNum(s: string): number | null {
  const m = s.match(/^([\d,]+(?:\.\d+)?)([kK])?$/);
  if (!m) return null;
  const base = parseFloat(m[1].replace(/,/g, ""));
  if (isNaN(base)) return null;
  return m[2] ? base * 1000 : base;
}

// Extract all meaningful numbers from text, excluding ordinal list prefixes.
// "~1,400" → 1400; "1.4k" → 1400; "1. Craft" → the "1" is stripped.
function extractFactNumbers(text: string): Set<string> {
  const nums = new Set<string>();
  const stripped = stripOrdinals(text);
  for (const m of stripped.matchAll(/~?(\d[\d,]*(?:\.\d+)?[kK]?)\b/g)) {
    const n = normalizeNum(m[1]);
    if (n !== null) nums.add(String(n));
  }
  return nums;
}

// ---------------------------------------------------------------------------
// Name helpers
// ---------------------------------------------------------------------------

// Find which known names (lowercased) appear in text.
function extractKnownNames(text: string, knownNames: Set<string>): Set<string> {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const name of knownNames) {
    if (lower.includes(name)) found.add(name);
  }
  return found;
}

// For the CODE ANSWER: extract all multi-word sequences AND every 2+ word sub-sequence.
// This ensures "Craft Alpine Rug" also registers "Alpine Rug" so that a rephrase saying
// "Making Alpine Rug" is recognisable as verb + known-item, not an invented name.
function extractCodeMultiNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/\b(?:[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b/g)) {
    const words = m[0].toLowerCase().split(" ");
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 2; j <= words.length; j++) {
        names.add(words.slice(i, j).join(" "));
      }
    }
  }
  return names;
}

// For the REPHRASE: only full greedy multi-word sequences (no sub-sequences).
// We then check whether each can be explained as "leading verb + known sub-sequence".
function extractRephraseMultiNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/\b(?:[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b/g)) {
    names.add(m[0].toLowerCase());
  }
  return names;
}

// ---------------------------------------------------------------------------
// Public types and validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid:          boolean;
  missingNumbers: string[];
  extraNumbers:   string[];
  missingNames:   string[];
  extraNames:     string[];
  inventedReason: boolean;
}

// Patterns that indicate an invented explanation for missing data (e.g. "not available until
// level X" when the code answer contained no level requirement).
const LEVEL_GATE_RE =
  /\b(?:not\s+available\s+until|haven[''']t\s+reached|reach(?:ing)?\s+(?:a\s+(?:certain\s+)?)?level|need\s+to\s+(?:be\s+)?level|requires?\s+(?:a\s+)?level|unlock(?:ed)?\s+at\s+level|once\s+you\s+(?:hit|reach)\s+level|not\s+yet\s+unlock|certain\s+level)\b/i;

/**
 * Validate that a rephrase preserves all real facts from the code answer.
 *
 * Rules:
 *  - Every number from the code answer (excluding list ordinals) must appear
 *    in the rephrase with the same value (commas, ~ and k are normalized).
 *  - Every item name from the code answer must appear in the rephrase.
 *  - No item name that wasn't in the code answer may be added.
 *  - List ordinals ("1. " "2. " at line start) are ignored.
 *  - "~" prefix and comma formatting are normalized before comparison.
 *
 * @param knownItemNames  Optional pre-computed set of lowercased display names
 *                        the code answer mentions.  When provided, name checking
 *                        is exact (from the catalog).  When omitted, falls back
 *                        to multi-word Title Case heuristic.
 */
export function validateRephrase(
  codeAnswer: string,
  rephrased:  string,
  knownItemNames?: Set<string>,
): ValidationResult {
  // Numbers
  const codeNums = extractFactNumbers(codeAnswer);
  const rpNums   = extractFactNumbers(rephrased);
  const missingNumbers = [...codeNums].filter(n => !rpNums.has(n));
  // Extra numbers the LLM invented (not in code answer) — catches hallucinated level requirements
  const extraNumbers   = [...rpNums].filter(n => !codeNums.has(n));

  // Missing known names — every item name the code answer mentions must appear in rephrase.
  let missingNames: string[] = [];
  if (knownItemNames && knownItemNames.size > 0) {
    const codeKnown = extractKnownNames(codeAnswer, knownItemNames);
    const rpKnown   = extractKnownNames(rephrased,  knownItemNames);
    missingNames = [...codeKnown].filter(n => !rpKnown.has(n));
  }

  // Extra item names — multi-word Title Case sequences added by the LLM that don't
  // exist in the code answer. Uses suffix matching so "Making Alpine Rug" is not
  // flagged when the code answer already contains "Craft Alpine Rug" ("Alpine Rug"
  // is a sub-sequence the code already knows about).
  const codeMulti = extractCodeMultiNames(codeAnswer);
  const rpMulti   = extractRephraseMultiNames(rephrased);
  const extraNames = [...rpMulti].filter(rpName => {
    if (codeMulti.has(rpName)) return false;
    // Allow "verb + known item" patterns by stripping leading words one at a time
    const words = rpName.split(" ");
    for (let i = 1; i < words.length; i++) {
      if (codeMulti.has(words.slice(i).join(" "))) return false;
    }
    return true; // genuinely new — flag as invented
  });

  // Reject if the rephrase adds a level-gate explanation not present in the code answer.
  const inventedReason = LEVEL_GATE_RE.test(rephrased) && !LEVEL_GATE_RE.test(codeAnswer);

  return {
    valid: missingNumbers.length === 0 && extraNumbers.length === 0 && missingNames.length === 0 && extraNames.length === 0 && !inventedReason,
    missingNumbers,
    extraNumbers,
    missingNames,
    extraNames,
    inventedReason,
  };
}

// ---------------------------------------------------------------------------
// rephraseWithValidation
// ---------------------------------------------------------------------------

// Extract the persona's own name from a voice string (e.g. "Your name is Pixin." → "Pixin").
function extractPersonaName(personaVoice: string): string | null {
  const m = personaVoice.match(/\bYour name is (\w+)/i);
  return m ? m[1] : null;
}

// Strip a leading self-address like "Pixin, ..." or "Pixin: ..." from the rephrase.
function stripLeadingPersonaName(text: string, name: string): string {
  return text.replace(new RegExp(`^${name}[,:\\-]\\s*`, "i"), "");
}

export async function rephraseWithValidation(
  codeAnswer:     string,
  personaVoice:   string,
  knownItemNames?: Set<string>,
  maxMs = 8_000,
): Promise<string> {
  const prompt =
    `Rewrite this in your voice. Keep every item name and number exactly as written. ` +
    `Do not add, remove, or combine anything. Do not begin your reply with your own name. Max 120 words.\n\n` +
    `Your voice: ${personaVoice}\n\n` +
    `Text to rewrite:\n${codeAnswer}`;

  let rephrased: string;
  try {
    rephrased = await Promise.race([
      askOllama(prompt, { numPredict: 120 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("rephrase timeout")), maxMs)
      ),
    ]);
  } catch (err) {
    if (
      err instanceof OllamaUnavailableError ||
      (err instanceof Error && err.message === "rephrase timeout")
    ) {
      return codeAnswer;
    }
    return codeAnswer;
  }

  // Strip leading self-address in case the LLM ignores the instruction.
  const personaName = extractPersonaName(personaVoice);
  if (personaName) rephrased = stripLeadingPersonaName(rephrased, personaName);

  const result = validateRephrase(codeAnswer, rephrased, knownItemNames);
  if (!result.valid) {
    return codeAnswer;
  }

  return rephrased;
}

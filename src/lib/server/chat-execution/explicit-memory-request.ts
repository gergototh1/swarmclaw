/**
 * Catch an explicit "remember this" without a model.
 *
 * WHY THIS IS NOT THE MISTAKE IT LOOKS LIKE. Pattern matching is famously bad
 * at deciding what is *worth* remembering — an earlier fleet built exactly
 * that, filled a database with "ok" and "thanks", and threw it away. This does
 * the opposite job: it does not judge significance at all. It only recognises
 * that the user gave an instruction, which is a thing a phrase list can do
 * reliably. Everything about *what* is worth keeping is left to the agent and
 * to the rubric it now receives.
 *
 * WHY IT MATTERS HERE. The LLM classifier that used to do this needs a
 * generation model, and every agent in this install runs on a CLI provider
 * with none configured — so `classifyDirectMemoryIntent` throws on every turn
 * and the throw is swallowed. "Remember that X" has therefore been a silent
 * no-op. This makes the one case the user asked for explicitly work with no
 * model at all.
 */

/**
 * Imperatives that mean "write this down", in Hungarian and English.
 *
 * Accent-insensitive: the text is folded before matching, so "jegyezd" also
 * matches a user typing without accents. Deliberately narrow — "emlékszel"
 * ("do you remember") is a question, not an instruction, and must not match.
 */
const REMEMBER_PATTERNS: RegExp[] = [
  // Hungarian imperatives
  /\b(?:jegyezd\s+meg|jegyezd\s+fel|ird\s+fel|irdd\s+fel)\b/,
  /\bne\s+felejtsd\s+el\b/,
  /\btartsd\s+eszben\b/,
  /\bemlekezz\s+(?:arra|erre|ra|re)?\b/,
  /\bmentsd\s+el\s+(?:magadnak|a\s+memoriaba)\b/,
  // English imperatives
  /\bremember\s+(?:that|this|to|for)\b/,
  /\b(?:please\s+)?(?:make\s+a\s+)?note\s+that\b/,
  /\bdon'?t\s+forget\s+that\b/,
  /\bkeep\s+in\s+mind\s+that\b/,
  /\bsave\s+(?:this|that)\s+(?:to|in)\s+memory\b/,
]

/**
 * The instruction, when it opens the message, is not part of the fact.
 *
 * Anchored to the start (past an optional "kérlek"/"please") on purpose. An
 * instruction in the middle of a sentence — "a build megy, jegyezd meg ezt" —
 * has context in front of it, and cutting there would file the fragment
 * without the thing it refers to.
 */
const LEAD_IN = /^(?:k[eé]rlek\s+|please\s+)?(?:jegyezd\s+meg|jegyezd\s+fel|[ií]rd\s+fel|ne\s+felejtsd\s+el|tartsd\s+[eé]szben|eml[eé]kezz(?:\s+(?:arra|erre|r[aá]|re))?|remember\s+(?:that|this)|(?:make\s+a\s+)?note\s+that|don'?t\s+forget\s+that|keep\s+in\s+mind\s+that)\b\s*[,:]?\s*(?:hogy\s+)?/i

/**
 * A continuation that means the turn asked for work beyond the memory write.
 *
 * Deciding "is this turn *only* a memory write" is a judgement, and a phrase
 * list cannot make it. So the detector refuses whenever it sees the shape of
 * a second request rather than guessing — the agent then handles the turn
 * normally and can still write the memory itself.
 */
const COMPOSITE_TAIL = /\b(?:and\s+then|and\s+also|then\s+(?:make|create|write|run|open|send|check)|es\s+(?:utana|azutan|akkor)|majd\s+(?:csinalj|keszits|irj|futtasd|nyisd|kuldd)|utana\s+(?:csinalj|keszits|irj))\b/

export interface ExplicitMemoryRequest {
  /** The fact to store, with the instruction stripped off the front. */
  content: string
}

/** Fold accents so a user typing "jegyezd" or "jegyezd" matches either way. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/**
 * Return the fact to store when the message is an explicit instruction to
 * remember something, or null when it is not.
 */
export function detectExplicitMemoryRequest(message: string): ExplicitMemoryRequest | null {
  const raw = String(message || '').trim()
  if (!raw) return null
  // A bare "remember?" is a question. Require enough text that something
  // followed the instruction.
  if (raw.length < 15) return null

  const folded = fold(raw)
  if (!REMEMBER_PATTERNS.some((pattern) => pattern.test(folded))) return null

  // A question mark at the end turns the same words into a query
  // ("emlékszel, hogy mit döntöttünk?"), which is a recall, not a write.
  if (/\?\s*$/.test(raw)) return null

  // "Remember X and then make a file" is two requests. Claiming this turn is
  // finished after the write would silently drop the second one.
  if (COMPOSITE_TAIL.test(folded)) return null

  // Strip the instruction from the original text, not the folded one, so the
  // stored fact keeps its accents. The lead-in is matched case-insensitively
  // against the original; where it does not match (because of accents) fall
  // back to storing the whole message, which is still correct, just wordier.
  const stripped = raw.replace(LEAD_IN, '').trim()
  const content = stripped.length >= 8 ? stripped : raw

  return { content }
}

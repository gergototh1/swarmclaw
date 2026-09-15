import { validateHumanAnswers, type HumanQuestionAnswer, type HumanQuestionPayload } from '@/lib/human-question'

export interface QuestionDraft {
  selected: string[]
  other: string
}

export function createDrafts(payload: HumanQuestionPayload): QuestionDraft[] {
  return payload.questions.map(() => ({ selected: [], other: '' }))
}

export function toggleOption(draft: QuestionDraft, label: string, multiSelect: boolean): QuestionDraft {
  if (!multiSelect) {
    return { selected: draft.selected[0] === label ? [] : [label], other: '' }
  }
  const selected = draft.selected.includes(label)
    ? draft.selected.filter((value) => value !== label)
    : [...draft.selected, label]
  return { selected, other: '' }
}

/**
 * Szabad szöveg beírása eldobja a kiválasztást — a kettő ugyanarra a kérdésre
 * két különböző válasz, és a szerver is csak az egyiket fogadja el.
 *
 * Az aszimmetria szándékos: a szöveg kiürítése (visszatörlés) NEM állítja
 * vissza a kiválasztást, mert nincs mit visszaállítani — a beírás pillanatában
 * már eldobtuk. A user újra rákattint, ha mégis opciót akar.
 */
export function setOther(draft: QuestionDraft, text: string): QuestionDraft {
  return text.trim() ? { selected: [], other: text } : { selected: draft.selected, other: text }
}

export function draftsToAnswers(payload: HumanQuestionPayload, drafts: QuestionDraft[]): HumanQuestionAnswer[] {
  return payload.questions.map((question, index) => {
    const draft = drafts[index] || { selected: [], other: '' }
    const other = draft.other.trim()
    return {
      ...(question.header ? { header: question.header } : {}),
      question: question.question,
      selected: draft.selected,
      ...(other ? { other } : {}),
    }
  })
}

export function canSubmit(payload: HumanQuestionPayload, drafts: QuestionDraft[]): boolean {
  return validateHumanAnswers(payload, draftsToAnswers(payload, drafts)).ok
}

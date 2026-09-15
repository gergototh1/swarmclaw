import { z } from 'zod'

export const MAX_QUESTIONS = 4
export const MAX_OPTIONS_PER_QUESTION = 4

export const HumanQuestionOptionSchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
})

export const HumanQuestionItemSchema = z.object({
  header: z.string().max(40).optional(),
  question: z.string().min(1).max(2000),
  multiSelect: z.boolean().optional(),
  options: z.array(HumanQuestionOptionSchema).max(MAX_OPTIONS_PER_QUESTION),
})

export const HumanQuestionPayloadSchema = z.object({
  questions: z.array(HumanQuestionItemSchema).min(1).max(MAX_QUESTIONS),
  expectedFormat: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
})

export const HumanQuestionAnswerSchema = z.object({
  header: z.string().optional(),
  question: z.string().min(1),
  selected: z.array(z.string()),
  other: z.string().optional(),
})

export const HumanQuestionAnswersSchema = z.array(HumanQuestionAnswerSchema)

export type HumanQuestionOption = z.infer<typeof HumanQuestionOptionSchema>
export type HumanQuestionItem = z.infer<typeof HumanQuestionItemSchema>
export type HumanQuestionPayload = z.infer<typeof HumanQuestionPayloadSchema>
export type HumanQuestionAnswer = z.infer<typeof HumanQuestionAnswerSchema>

export type NormalizeQuestionResult =
  | { ok: true; payload: HumanQuestionPayload }
  | { ok: false; error: string }

export type ValidateAnswersResult =
  | { ok: true }
  | { ok: false; error: string }

type OptionResult = { ok: true; option: HumanQuestionOption } | { ok: false; reason: string }

function toOption(value: unknown): OptionResult {
  if (typeof value === 'string') {
    const label = value.trim()
    if (!label) return { ok: false, reason: 'the option text is empty' }
    return { ok: true, option: { label } }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    if (!label) return { ok: false, reason: 'the option is missing a non-empty "label"' }
    const description = typeof record.description === 'string' ? record.description.trim() : ''
    return { ok: true, option: description ? { label, description } : { label } }
  }
  return { ok: false, reason: `the option has an unsupported type (${value === null ? 'null' : typeof value})` }
}

// A hívó (a `questions[]` ág és az egyetlen-elemes ág) ugyanazt az üzenetet adja
// vissza, ha egy kérdésnek "no-question" (üres/hiányzó `question`) a baja, mert
// annak a szövegét a hívó kontextusa (lista vs. egyetlen elem) szabja meg. Egy
// rossz option viszont már itt névvel/indexszel azonosítható, ezért azt a
// helyben, a `bad-option` ágon adjuk vissza.
type ItemResult =
  | { ok: true; item: HumanQuestionItem }
  | { ok: false; kind: 'no-question' }
  | { ok: false; kind: 'bad-option'; error: string }

function toItem(value: unknown): ItemResult {
  if (!value || typeof value !== 'object') return { ok: false, kind: 'no-question' }
  const record = value as Record<string, unknown>
  const question = typeof record.question === 'string' ? record.question.trim() : ''
  if (!question) return { ok: false, kind: 'no-question' }
  const header = typeof record.header === 'string' ? record.header.trim() : ''

  // Egy hiányzó vagy explicit üres `options` kulcs legális szabadszöveges
  // kérdés (lásd a modul tesztjeit); egy JELENLÉVŐ, de rosszul alakított
  // option viszont hiba, nem néma kiszűrés — lásd a task-1-report.md "Fix
  // round 1" bejegyzését arról, miért veszélyes volt a régi néma szűrés.
  const options: HumanQuestionOption[] = []
  if (Array.isArray(record.options)) {
    for (let i = 0; i < record.options.length; i++) {
      const parsed = toOption(record.options[i])
      if (!parsed.ok) {
        return {
          ok: false,
          kind: 'bad-option',
          error: `Question "${question}" has a malformed option at index ${i}: ${parsed.reason}.`,
        }
      }
      options.push(parsed.option)
    }
  }

  return {
    ok: true,
    item: {
      question,
      ...(header ? { header } : {}),
      ...(record.multiSelect === true ? { multiSelect: true } : {}),
      options,
    },
  }
}

function optionsLimitError(item: HumanQuestionItem): string | null {
  if (item.options.length > MAX_OPTIONS_PER_QUESTION) {
    return `At most ${MAX_OPTIONS_PER_QUESTION} options per question are allowed; "${item.question}" has ${item.options.length}.`
  }
  return null
}

/**
 * Az `ask_human` nyers argumentumaiból csinál kérdés-csomagot.
 *
 * A régi alak (`question` + `options: string[]`) egyetlen kérdéssé fordul, mert
 * a postaládában lévő, még megválaszolatlan kérdések ilyenek, és azoknak a
 * frissítés után is meg kell jelenniük.
 */
export function normalizeHumanQuestionInput(raw: Record<string, unknown>): NormalizeQuestionResult {
  const items: HumanQuestionItem[] = []
  const rawQuestions = Array.isArray(raw.questions) ? raw.questions : null

  if (rawQuestions) {
    if (rawQuestions.length > MAX_QUESTIONS) {
      return { ok: false, error: `At most ${MAX_QUESTIONS} questions are allowed, got ${rawQuestions.length}.` }
    }
    for (const entry of rawQuestions) {
      const result = toItem(entry)
      if (!result.ok) {
        if (result.kind === 'no-question') {
          return { ok: false, error: 'Every entry in "questions" needs a non-empty "question" string.' }
        }
        return { ok: false, error: result.error }
      }
      const limitError = optionsLimitError(result.item)
      if (limitError) return { ok: false, error: limitError }
      items.push(result.item)
    }
  } else {
    const result = toItem(raw)
    if (!result.ok) {
      if (result.kind === 'no-question') return { ok: false, error: 'question is required.' }
      return { ok: false, error: result.error }
    }
    const limitError = optionsLimitError(result.item)
    if (limitError) return { ok: false, error: limitError }
    items.push(result.item)
  }

  const candidate = {
    questions: items,
    expectedFormat: typeof raw.expectedFormat === 'string' && raw.expectedFormat.trim() ? raw.expectedFormat.trim() : null,
    notes: typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : null,
  }

  const parsed = HumanQuestionPayloadSchema.safeParse(candidate)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') }
  }
  return { ok: true, payload: parsed.data }
}

export function validateHumanAnswers(payload: HumanQuestionPayload, answers: HumanQuestionAnswer[]): ValidateAnswersResult {
  if (!Array.isArray(answers) || answers.length !== payload.questions.length) {
    return { ok: false, error: `Expected ${payload.questions.length} answers, got ${Array.isArray(answers) ? answers.length : 0}.` }
  }
  for (let i = 0; i < payload.questions.length; i++) {
    const question = payload.questions[i]
    const answer = answers[i]
    // Az answer-tömb a böngészőből érkezik (POST /api/chats/:id/mailbox), és a
    // renderHumanAnswerText a válasz SAJÁT `header`/`question` mezőjét írja a
    // felhasználói buborékba — index alapú párosítás önmagában nem bizonyítja,
    // hogy az adott válasz tényleg ehhez a kérdéshez tartozik. Lásd a
    // task-1-report.md "Fix round 1" bejegyzését.
    if (answer?.question !== question.question) {
      return { ok: false, error: `Answer ${i + 1} does not match question "${question.question}".` }
    }
    const answerHeader = typeof answer?.header === 'string' ? answer.header.trim() : ''
    if (answerHeader && answerHeader !== (question.header ?? '')) {
      return { ok: false, error: `Answer header for "${question.question}" does not match the question.` }
    }
    const selected = Array.isArray(answer?.selected) ? answer.selected : []
    const other = typeof answer?.other === 'string' ? answer.other.trim() : ''
    if (!selected.length && !other) {
      return { ok: false, error: `Question "${question.question}" has no answer.` }
    }
    if (question.multiSelect !== true && selected.length > 1) {
      return { ok: false, error: `Question "${question.question}" accepts a single option.` }
    }
    const labels = new Set(question.options.map((option) => option.label))
    for (const value of selected) {
      if (!labels.has(value)) {
        return { ok: false, error: `"${value}" is not an option of "${question.question}".` }
      }
    }
  }
  return { ok: true }
}

export function renderHumanQuestionText(payload: HumanQuestionPayload): string {
  const blocks = payload.questions.map((question) => {
    const lines: string[] = []
    if (question.header) lines.push(question.header)
    lines.push(question.question)
    question.options.forEach((option, index) => {
      lines.push(option.description ? `${index + 1}. ${option.label} — ${option.description}` : `${index + 1}. ${option.label}`)
    })
    return lines.join('\n')
  })
  if (payload.notes) blocks.push(payload.notes)
  return blocks.join('\n\n')
}

// A `header` a rövid címke ("Adatbázis"); ha van, az azonosítja a kérdést a
// válasz-buborékban, mert az sokkal olvashatóbb, mint a teljes kérdésmondat.
export function renderHumanAnswerText(answers: HumanQuestionAnswer[]): string {
  return answers
    .map((answer) => {
      const other = typeof answer.other === 'string' ? answer.other.trim() : ''
      const parts = [...answer.selected, ...(other ? [other] : [])]
      return `${answer.header || answer.question}: ${parts.join(', ')}`
    })
    .join('\n')
}

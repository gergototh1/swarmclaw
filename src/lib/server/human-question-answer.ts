import {
  normalizeHumanQuestionInput,
  renderHumanAnswerText,
  validateHumanAnswers,
  type HumanQuestionAnswer,
} from '@/lib/human-question'
import { ackMailboxEnvelope, listMailbox, sendMailboxEnvelope } from '@/lib/server/chatrooms/session-mailbox'
import { appendMessage, getMessageBySeq, replaceMessageAt } from '@/lib/server/messages/message-repository'
import { enqueueSessionRun } from '@/lib/server/runtime/session-run-manager'
import { cancelWatchJob, listWatchJobs, mailboxWatchJobMatches } from '@/lib/server/runtime/watch-jobs'
import type { MailboxEnvelope } from '@/types'

export interface AnswerHumanQuestionInput {
  sessionId: string
  correlationId: string
  answers: HumanQuestionAnswer[]
}

export type AnswerHumanQuestionResult =
  | { ok: true; envelopeId: string; enqueued: boolean }
  | { ok: false; error: string; status: number }

function readMessageSeq(envelope: MailboxEnvelope): number | null {
  try {
    const parsed = JSON.parse(envelope.payload) as Record<string, unknown>
    return typeof parsed.messageSeq === 'number' ? parsed.messageSeq : null
  } catch {
    return null
  }
}

function closeQuestionMessage(
  sessionId: string,
  envelope: MailboxEnvelope,
  status: 'answered' | 'superseded',
  answers?: HumanQuestionAnswer[],
): void {
  const seq = readMessageSeq(envelope)
  if (seq === null) return
  const message = getMessageBySeq(sessionId, seq)
  if (!message || message.kind !== 'question') return
  replaceMessageAt(sessionId, seq, {
    ...message,
    questionState: {
      correlationId: envelope.correlationId || '',
      status,
      ...(answers ? { answers, answeredAt: Date.now() } : {}),
    },
  })
}

function findPendingRequest(sessionId: string, correlationId: string): MailboxEnvelope | null {
  return listMailbox(sessionId, { limit: 200 })
    .find((envelope) => envelope.type === 'human_request'
      && envelope.status !== 'ack'
      && envelope.correlationId === correlationId) || null
}

/**
 * A user válasza: naplóba, a kérdés lezárása, boríték, ack — ebben a sorrendben.
 *
 * A boríték elsüti a `wait_for_reply` várakozást, ami azonnal új kört indít, és
 * annak a körnek már látnia kell a választ a naplóban.
 */
export function answerHumanQuestion(input: AnswerHumanQuestionInput): AnswerHumanQuestionResult {
  const request = findPendingRequest(input.sessionId, input.correlationId)
  if (!request) return { ok: false, error: `No open question with correlationId "${input.correlationId}".`, status: 404 }

  let parsedPayload: Record<string, unknown>
  try {
    parsedPayload = JSON.parse(request.payload) as Record<string, unknown>
  } catch {
    return { ok: false, error: 'The stored question could not be read.', status: 500 }
  }
  const normalized = normalizeHumanQuestionInput(parsedPayload)
  if (!normalized.ok) return { ok: false, error: normalized.error, status: 500 }

  const validation = validateHumanAnswers(normalized.payload, input.answers)
  if (!validation.ok) return { ok: false, error: validation.error, status: 400 }

  const text = renderHumanAnswerText(input.answers)
  appendMessage(input.sessionId, { role: 'user', text, time: Date.now() })
  closeQuestionMessage(input.sessionId, request, 'answered', input.answers)

  // Pontosan azt kérdezzük, amit a trigger is kérdez majd, ugyanazzal a
  // predikátummal — a saját másolat kétszer is elcsúszott tőle. Ha itt "van
  // várakozó" jönne ki ott, ahol a trigger nem talál semmit, a tartalék kör
  // elmaradna, és a user válasza némán a földre esne.
  const replyPayload = JSON.stringify({ answers: input.answers, text })
  const hasWaiter = listWatchJobs({ status: 'active' })
    .some((job) => mailboxWatchJobMatches(job, input.sessionId, {
      type: 'human_reply',
      correlationId: input.correlationId,
      fromSessionId: input.sessionId,
      payload: replyPayload,
    }))

  const reply = sendMailboxEnvelope({
    toSessionId: input.sessionId,
    type: 'human_reply',
    payload: replyPayload,
    fromSessionId: input.sessionId,
    fromAgentId: null,
    correlationId: input.correlationId,
    ttlSec: null,
  })
  ackMailboxEnvelope(input.sessionId, request.id)

  // Ha az agent nem regisztrált tartós várakozást, a boríték senkit nem ébreszt
  // fel. A válasz akkor sem hullhat a földre: sima körrel megy tovább.
  if (!hasWaiter) {
    enqueueSessionRun({
      sessionId: input.sessionId,
      message: text,
      source: 'human_question_answer',
      internal: false,
    })
  }

  return { ok: true, envelopeId: reply.id, enqueued: !hasWaiter }
}

/**
 * A user válasz helyett gépelt: a nyitott kérdés lezárul, a várakozás leáll.
 *
 * Enélkül a később megnyomott gomb egy második kört indítana ugyanarra a
 * beszélgetésre.
 */
export function supersedePendingHumanQuestions(sessionId: string): number {
  const pending = listMailbox(sessionId, { limit: 200 })
    .filter((envelope) => envelope.type === 'human_request' && envelope.status !== 'ack')
  if (!pending.length) return 0

  for (const envelope of pending) {
    closeQuestionMessage(sessionId, envelope, 'superseded')
    ackMailboxEnvelope(sessionId, envelope.id)
  }

  const correlationIds = new Set(pending.map((envelope) => envelope.correlationId).filter((id): id is string => !!id))
  const stale = listWatchJobs({ sessionId, status: 'active' })
    .filter((job) => job.type === 'mailbox'
      && typeof job.condition.correlationId === 'string'
      && correlationIds.has(job.condition.correlationId))
  for (const job of stale) {
    cancelWatchJob(job.id)
  }

  return pending.length
}

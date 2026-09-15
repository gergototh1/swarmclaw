import {
  normalizeHumanQuestionInput,
  renderHumanAnswerText,
  validateHumanAnswers,
  type HumanQuestionAnswer,
} from '@/lib/human-question'
import { ackMailboxEnvelope, listMailbox, sendMailboxEnvelope } from '@/lib/server/chatrooms/session-mailbox'
import { log } from '@/lib/server/logger'
import { findMessage, replaceMessageAt } from '@/lib/server/messages/message-repository'
import { enqueueSessionRun } from '@/lib/server/runtime/session-run-manager'
import { cancelWatchJob, listWatchJobs, mailboxWatchJobMatches } from '@/lib/server/runtime/watch-jobs'
import { errorMessage } from '@/lib/shared-utils'
import type { MailboxEnvelope } from '@/types'

const TAG = 'human-question'

export interface AnswerHumanQuestionInput {
  sessionId: string
  correlationId: string
  answers: HumanQuestionAnswer[]
}

export type AnswerHumanQuestionResult =
  | { ok: true; envelopeId: string }
  | { ok: false; error: string; status: number }

/**
 * A kérdés-üzenet lezárása.
 *
 * correlationId alapján keressük, nem a naplóbeli sorszáma alapján. A seq
 * nem stabil: a kör végén a napló újraíródik (`replaceAllMessages`), és egy
 * kör közben elkapott seq már egy másik sorra mutat. Élesben pont így maradt a
 * kártya örökre `pending`. A correlationId magán az üzeneten van, azt az
 * újraírás nem mozdítja.
 */
function closeQuestionMessage(
  sessionId: string,
  correlationId: string,
  status: 'answered' | 'superseded',
  answers?: HumanQuestionAnswer[],
): void {
  if (!correlationId) return
  const found = findMessage(sessionId, (message) => message.kind === 'question'
    && message.questionState?.correlationId === correlationId)
  if (!found) return
  replaceMessageAt(sessionId, found.seq, {
    ...found.message,
    questionState: {
      correlationId,
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
 * A user válasza: a kérdés lezárása, a várakozás leállítása, boríték, ack, új kör.
 *
 * A kört mindig mi indítjuk, nem a `wait_for_reply` várakozás. Ezen a forkon a
 * CLI-provideres ügynököknél a heartbeat ki van kapcsolva
 * (`storage-normalization.ts`), és minden watch-job ébresztés a heartbeaten megy
 * át — a várakozás tehát soha nem ébresztené fel őket, a válasz pedig némán
 * elveszne. Élesben pontosan ez történt.
 *
 * A válasz user-bemenet, ezért `source: 'chat'`: ez az egyetlen forrás, amit a
 * futtatás nem köt budget- és estop-kapuhoz (`isAutonomyManagedEnqueue`).
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

  closeQuestionMessage(input.sessionId, input.correlationId, 'answered', input.answers)

  const text = renderHumanAnswerText(input.answers)
  const replyPayload = JSON.stringify({ answers: input.answers, text })

  // A várakozást a boríték ELŐTT állítjuk le. Utána már a boríték sütné el, és
  // egy heartbeattel rendelkező ügynök a mi körünk mellé egy második,
  // watch-job ébresztést is kapna.
  for (const job of listWatchJobs({ status: 'active' })) {
    const matches = mailboxWatchJobMatches(job, input.sessionId, {
      type: 'human_reply',
      correlationId: input.correlationId,
      fromSessionId: input.sessionId,
      payload: replyPayload,
    })
    if (matches) cancelWatchJob(job.id)
  }

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

  // A buborékot nem mi írjuk a naplóba: a kör előkészítése maga menti el a
  // bejövő user-üzenetet (`shouldPersistInboundUserMessage`), és kettő lenne.
  try {
    enqueueSessionRun({
      sessionId: input.sessionId,
      message: text,
      source: 'chat',
      internal: false,
    })
  } catch (err: unknown) {
    // A válasz rögzítve, a kérdés lezárva. Ha kör nem indulhat (például teljes
    // estop), azt nem a user küldése rontotta el; egy hiba a kártyán egy sikeres
    // küldés után pont az volna, amit a kártya `sent` állapota elkerül.
    log.warn(TAG, 'Could not start a turn for the human answer', {
      sessionId: input.sessionId,
      correlationId: input.correlationId,
      error: errorMessage(err),
    })
  }

  return { ok: true, envelopeId: reply.id }
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
    closeQuestionMessage(sessionId, envelope.correlationId || '', 'superseded')
    ackMailboxEnvelope(sessionId, envelope.id)
  }

  const correlationIds = new Set(pending.map((envelope) => envelope.correlationId).filter((id): id is string => !!id))
  // `job.sessionId` here, not `job.target.sessionId` as the matching predicate
  // uses: this asks "whose turn would resume", which is what we are cancelling,
  // rather than "whose mailbox is watched". Both creators of a mailbox watch job
  // set the two to the same session, so today they agree — a future caller that
  // watches another session's mailbox would need this revisited.
  const stale = listWatchJobs({ sessionId, status: 'active' })
    .filter((job) => job.type === 'mailbox'
      && typeof job.condition.correlationId === 'string'
      && correlationIds.has(job.condition.correlationId))
  for (const job of stale) {
    cancelWatchJob(job.id)
  }

  return pending.length
}

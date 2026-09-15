import { genId } from '@/lib/id'
import type { MailboxEnvelope } from '@/types'
import { loadSession, patchSession } from '@/lib/server/sessions/session-repository'
import { normalizeHumanQuestionInput, type HumanQuestionPayload } from '@/lib/human-question'

interface MailboxOptions {
  limit?: number
  includeAcked?: boolean
}

function normalizeMailboxList(raw: unknown): MailboxEnvelope[] {
  if (!Array.isArray(raw)) return []
  const out: MailboxEnvelope[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const v = item as MailboxEnvelope
    if (!v.id || !v.toSessionId) continue
    out.push(v)
  }
  return out
}

function pruneExpired(envelopes: MailboxEnvelope[], now = Date.now()): MailboxEnvelope[] {
  return envelopes.filter((env) => !env.expiresAt || env.expiresAt > now)
}

function normalizeHumanRequestValue(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().toLowerCase()
    : ''
}

function parseHumanRequestPayload(payload: string): HumanQuestionPayload | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const normalized = normalizeHumanQuestionInput(parsed)
    return normalized.ok ? normalized.payload : null
  } catch {
    return null
  }
}

function normalizeHumanRequestSignature(input: {
  payload: HumanQuestionPayload
  fromSessionId?: string | null
  fromAgentId?: string | null
}): string {
  return JSON.stringify({
    questions: input.payload.questions.map((question) => ({
      header: normalizeHumanRequestValue(question.header),
      question: normalizeHumanRequestValue(question.question),
      multiSelect: question.multiSelect === true,
      options: question.options.map((option) => normalizeHumanRequestValue(option.label)),
    })),
    expectedFormat: normalizeHumanRequestValue(input.payload.expectedFormat),
    notes: normalizeHumanRequestValue(input.payload.notes),
    fromSessionId: normalizeHumanRequestValue(input.fromSessionId),
    fromAgentId: normalizeHumanRequestValue(input.fromAgentId),
  })
}

function normalizeMailbox(target: { mailbox?: MailboxEnvelope[] | null }, now = Date.now()): MailboxEnvelope[] {
  return pruneExpired(normalizeMailboxList(target.mailbox || []), now)
}

/**
 * Does the chat show this request as a question card?
 *
 * Only `request_input` writes a `questions` array, and it always writes the
 * card message next to it. A request written before cards existed carries a
 * single `question` string and has no card.
 */
function isCardBackedHumanRequest(envelope: MailboxEnvelope): boolean {
  try {
    const parsed: unknown = JSON.parse(envelope.payload)
    return !!parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).questions)
  } catch {
    return false
  }
}

function findLatestBridgeableHumanRequestEnvelope(
  sessionId: string,
  target = loadSession(sessionId),
): MailboxEnvelope | null {
  if (!target) throw new Error(`Session not found: ${sessionId}`)
  const envelopes = normalizeMailbox(target)
  const repliedCorrelationIds = new Set(
    envelopes
      .filter((envelope) => envelope.type === 'human_reply' && envelope.status !== 'ack' && envelope.correlationId)
      .map((envelope) => envelope.correlationId as string),
  )
  return envelopes
    .filter((envelope) => envelope.type === 'human_request' && envelope.status !== 'ack')
    .filter((envelope) => !envelope.correlationId || !repliedCorrelationIds.has(envelope.correlationId))
    // A card question is closed only by answering it (`answerHumanQuestion`) or
    // by superseding it where the user types. Acking it here would leave its
    // card with live buttons that 404, and the answer turn of one card would
    // be recorded as the reply to another card that is still open.
    .filter((envelope) => !isCardBackedHumanRequest(envelope))
    .sort((a, b) => b.createdAt - a.createdAt)[0] || null
}

export function findPendingHumanRequestEnvelope(params: {
  sessionId: string
  payload: HumanQuestionPayload
  fromSessionId?: string | null
  fromAgentId?: string | null
}): MailboxEnvelope | null {
  const target = loadSession(params.sessionId)
  if (!target) throw new Error(`Session not found: ${params.sessionId}`)
  const expectedSignature = normalizeHumanRequestSignature(params)
  const envelopes = normalizeMailbox(target)
  return envelopes
    .filter((envelope) => envelope.type === 'human_request' && envelope.status !== 'ack')
    .find((envelope) => {
      const parsed = parseHumanRequestPayload(envelope.payload)
      if (!parsed) return false
      return normalizeHumanRequestSignature({
        payload: parsed,
        fromSessionId: envelope.fromSessionId || null,
        fromAgentId: envelope.fromAgentId || null,
      }) === expectedSignature
    }) || null
}

export function sendMailboxEnvelope(input: {
  toSessionId: string
  type: string
  payload: string
  fromSessionId?: string | null
  fromAgentId?: string | null
  toAgentId?: string | null
  correlationId?: string | null
  ttlSec?: number | null
}): MailboxEnvelope {
  const target = loadSession(input.toSessionId)
  if (!target) throw new Error(`Target session not found: ${input.toSessionId}`)

  const now = Date.now()
  const ttl = typeof input.ttlSec === 'number' && Number.isFinite(input.ttlSec)
    ? Math.max(0, Math.min(7 * 24 * 3600, Math.trunc(input.ttlSec)))
    : null
  const envelope: MailboxEnvelope = {
    id: genId(6),
    type: (input.type || 'message').trim() || 'message',
    payload: String(input.payload || ''),
    fromSessionId: input.fromSessionId || null,
    fromAgentId: input.fromAgentId || null,
    toSessionId: input.toSessionId,
    toAgentId: input.toAgentId || null,
    correlationId: input.correlationId || null,
    status: 'new',
    createdAt: now,
    expiresAt: ttl ? now + ttl * 1000 : null,
    ackAt: null,
  }

  patchSession(input.toSessionId, (current) => {
    if (!current) return null
    return {
      ...current,
      mailbox: [...normalizeMailbox(current, now), envelope],
      lastActiveAt: now,
    }
  })
  import('@/lib/server/runtime/watch-jobs')
    .then(({ triggerMailboxWatchJobs }) => {
      triggerMailboxWatchJobs({ sessionId: input.toSessionId, envelope })
    })
    .catch(() => {
      // best-effort trigger only
    })
  return envelope
}

export function listMailbox(sessionId: string, opts: MailboxOptions = {}): MailboxEnvelope[] {
  const target = loadSession(sessionId)
  if (!target) throw new Error(`Session not found: ${sessionId}`)
  const list = pruneExpired(normalizeMailboxList(target.mailbox || []))
  const includeAcked = opts.includeAcked === true
  const filtered = includeAcked ? list : list.filter((env) => env.status !== 'ack')
  const limit = Math.max(1, Math.min(500, Math.trunc(opts.limit || 50)))
  return filtered
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
}

export function ackMailboxEnvelope(sessionId: string, envelopeId: string): MailboxEnvelope | null {
  const target = loadSession(sessionId)
  if (!target) throw new Error(`Session not found: ${sessionId}`)
  const ackAt = Date.now()
  let acked: MailboxEnvelope | null = null
  patchSession(sessionId, (current) => {
    if (!current) return null
    const list = normalizeMailbox(current)
    const idx = list.findIndex((env) => env.id === envelopeId)
    if (idx === -1) return current
    list[idx] = {
      ...list[idx],
      status: 'ack',
      ackAt,
    }
    acked = list[idx]
    return {
      ...current,
      mailbox: list,
      lastActiveAt: ackAt,
    }
  })
  return acked
}

export function clearMailbox(sessionId: string, includeAcked = true): { before: number; after: number } {
  const target = loadSession(sessionId)
  if (!target) throw new Error(`Session not found: ${sessionId}`)
  let before = 0
  let after = 0
  patchSession(sessionId, (current) => {
    if (!current) return null
    const list = normalizeMailbox(current)
    const afterList = includeAcked ? [] : list.filter((env) => env.status !== 'ack')
    before = list.length
    after = afterList.length
    return {
      ...current,
      mailbox: afterList,
      lastActiveAt: Date.now(),
    }
  })
  return { before, after }
}

export function bridgeHumanReplyFromChat(input: {
  sessionId: string
  payload: string
  fromSessionId?: string | null
}): MailboxEnvelope | null {
  const payload = String(input.payload || '').trim()
  if (!payload) return null
  const pending = findLatestBridgeableHumanRequestEnvelope(input.sessionId)
  if (!pending) return null
  const envelope = sendMailboxEnvelope({
    toSessionId: input.sessionId,
    type: 'human_reply',
    payload,
    fromSessionId: input.fromSessionId || input.sessionId,
    correlationId: pending.correlationId || null,
  })
  ackMailboxEnvelope(input.sessionId, pending.id)
  return envelope
}

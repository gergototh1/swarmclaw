import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { dispatchWake } from '@/lib/server/runtime/wake-dispatcher'
import type { ToolBuildContext } from './context'
import type { Extension, ExtensionHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { createWatchJob } from '@/lib/server/runtime/watch-jobs'

export const MAX_WAKE_DELAY_MINUTES = 43_200

export interface WakeRequest {
  delayMinutes: number
  message: string
}

/**
 * Validate a `schedule_wake` call before anything is persisted.
 *
 * WHY THIS IS SEPARATE AND STRICT. The old guard was
 * `delayMinutes < 0 || delayMinutes > 43_200`, and both comparisons are false
 * for `undefined`, so a call that omitted the argument sailed through: `runAt`
 * became `NaN`, and `createWatchJob` stored a row that can never fire. One such
 * row is in the live store (`1df02819902d384c2365`, "Scheduled wake in
 * undefined minutes", `runAt: null`, still `active` two days on). The agent got
 * a success-shaped answer, so it never corrected itself and never tried again --
 * which is why every "I'll tell you when it's done" in that session went
 * unanswered until the user asked again.
 *
 * An error naming the argument and its unit is what lets the agent retry; a
 * silently dead job is not.
 */
export function normalizeWakeRequest(args: unknown): WakeRequest | { error: string } {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)

  const rawDelay = normalized.delayMinutes
  // A CLI agent often sends numbers as strings; accept that, reject the rest.
  const delayMinutes = typeof rawDelay === 'number'
    ? rawDelay
    : typeof rawDelay === 'string' && rawDelay.trim() !== ''
      ? Number(rawDelay)
      : Number.NaN
  if (!Number.isFinite(delayMinutes)) {
    return { error: `delayMinutes is required: how many minutes from now to wake, 0 to ${MAX_WAKE_DELAY_MINUTES} (30 days). Use 0 to wake immediately.` }
  }
  if (delayMinutes < 0 || delayMinutes > MAX_WAKE_DELAY_MINUTES) {
    return { error: `delayMinutes must be between 0 and ${MAX_WAKE_DELAY_MINUTES} minutes (30 days); got ${delayMinutes}.` }
  }

  const message = typeof normalized.message === 'string' ? normalized.message.trim() : ''
  if (!message) {
    return { error: 'message is required: what to tell yourself when you wake. A wake with nothing to say does nothing.' }
  }

  return { delayMinutes, message }
}

/**
 * Core Schedule Execution Logic
 */
async function executeScheduleWake(args: unknown, context: { sessionId?: string }) {
  if (!context.sessionId) return 'Cannot schedule wake: no session context.'
  const request = normalizeWakeRequest(args)
  if ('error' in request) return `Error: ${request.error}`
  const { delayMinutes, message } = request

  if (delayMinutes === 0) {
    enqueueSystemEvent(context.sessionId, `[Scheduled Wake Event / Reminder] ${message}`)
    dispatchWake({
      mode: 'immediate',
      sessionId: context.sessionId,
      reason: 'scheduled_wake',
      source: 'schedule_wake',
      resumeMessage: message,
    })
    return 'Successfully scheduled an immediate wake event.'
  }

  const runAt = Date.now() + delayMinutes * 60 * 1000
  const watch = await createWatchJob({
    type: 'time',
    sessionId: context.sessionId,
    resumeMessage: message,
    description: `Scheduled wake in ${delayMinutes} minutes`,
    target: { source: 'schedule_wake' },
    condition: {},
    runAt,
  })

  return JSON.stringify({
    ok: true,
    jobId: watch.id,
    delayMinutes,
    runAt,
    message,
  })
}

/**
 * Register as a Built-in Extension
 */
const ScheduleExtension: Extension = {
  name: 'Core Scheduler',
  description: 'Schedule durable wake events and reminders for agents.',
  hooks: {
    getCapabilityDescription: () => 'I can set a conversational timer (`schedule_wake`) to remind myself to check back on something later in this chat.',
  } as ExtensionHooks,
  tools: [
    {
      name: 'schedule_wake',
      description: 'Schedule a wake event (reminder) for yourself in this chatroom.',
      parameters: {
        type: 'object',
        properties: {
          delayMinutes: { type: 'number' },
          message: { type: 'string' }
        },
        required: ['delayMinutes', 'message']
      },
      execute: async (args, context) => executeScheduleWake(args, { sessionId: context.session.id })
    }
  ]
}

registerNativeCapability('schedule', ScheduleExtension)

/**
 * Legacy Bridge
 */
export function buildScheduleTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasExtension('schedule_wake')) return []
  return [
    tool(
      async (args) => executeScheduleWake(args, { sessionId: bctx.ctx?.sessionId || undefined }),
      {
        name: 'schedule_wake',
        description: ScheduleExtension.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}

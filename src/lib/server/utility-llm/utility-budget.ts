import { hmrSingleton } from '@/lib/shared-utils'

/**
 * What the host's helper model is allowed to spend.
 *
 * Extraction that runs on every turn is what makes a memory store useful — a
 * comparable fleet holds 3658 auto-extracted candidates against this one's 43
 * hand-written memories. It is also a real bill: these calls go through a
 * subscription, so "on every turn" without a brake is a way to spend a day's
 * quota on housekeeping.
 *
 * Three brakes, each overridable in settings:
 *   - a fleet-wide daily cap,
 *   - a concurrency limit, so a burst of sessions cannot fan out,
 *   - a per-session cooldown, so one conversation cannot call it every message.
 *
 * A cap of 0 turns the helpers off entirely. That is the off switch, and it is
 * deliberately the same field: an operator worried about cost should not have
 * to find a second setting.
 */

/** Roughly a busy day of extraction, well under a subscription's daily room. */
export const DEFAULT_UTILITY_DAILY_CAP = 200
/** Two at once keeps a burst from stacking CLI processes on a small machine. */
export const DEFAULT_UTILITY_MAX_CONCURRENT = 2
/** One extraction a minute per conversation is plenty; a turn rarely takes less. */
export const DEFAULT_UTILITY_COOLDOWN_SEC = 60

const MAX_REASONABLE_CONCURRENT = 8

export interface UtilityBudget {
  dailyCap: number
  maxConcurrent: number
  cooldownSec: number
}

export interface UtilityBudgetSettings {
  utilityDailyCap?: number | null
  utilityMaxConcurrent?: number | null
  utilityPerSessionCooldownSec?: number | null
}

function intOr(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.trunc(value)
  if (rounded < min || rounded > max) return fallback
  return rounded
}

export function resolveUtilityBudget(settings: UtilityBudgetSettings | null | undefined): UtilityBudget {
  return {
    // 0 is meaningful here (off), so the floor is 0 rather than 1.
    dailyCap: intOr(settings?.utilityDailyCap, DEFAULT_UTILITY_DAILY_CAP, 0, 100_000),
    maxConcurrent: intOr(settings?.utilityMaxConcurrent, DEFAULT_UTILITY_MAX_CONCURRENT, 1, MAX_REASONABLE_CONCURRENT),
    cooldownSec: intOr(settings?.utilityPerSessionCooldownSec, DEFAULT_UTILITY_COOLDOWN_SEC, 0, 86_400),
  }
}

interface UtilityBudgetState {
  day: string
  usedToday: number
  inFlight: number
  lastCallBySession: Map<string, number>
}

const state = hmrSingleton<UtilityBudgetState>('__swarmclaw_utility_budget__', () => ({
  day: '',
  usedToday: 0,
  inFlight: 0,
  lastCallBySession: new Map<string, number>(),
}))

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export type UtilityClaim =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'daily_cap' | 'busy' | 'cooldown' }

export function claimUtilityCall(input: {
  sessionId?: string | null
  budget: UtilityBudget
  now?: number
}): UtilityClaim {
  const now = typeof input.now === 'number' ? input.now : Date.now()
  const { budget } = input

  if (budget.dailyCap <= 0) return { ok: false, reason: 'disabled' }

  const today = dayKey(now)
  if (state.day !== today) {
    state.day = today
    state.usedToday = 0
    // Yesterday's cooldowns cannot still be running; dropping them keeps the
    // map from growing for the life of the process.
    state.lastCallBySession.clear()
  }

  if (state.usedToday >= budget.dailyCap) return { ok: false, reason: 'daily_cap' }
  if (state.inFlight >= budget.maxConcurrent) return { ok: false, reason: 'busy' }

  // The cooldown is per conversation. Work with no session — the daily digest,
  // a fleet-wide pass — is not a conversation and is not held back by one.
  const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId.trim() : null
  if (sessionId && budget.cooldownSec > 0) {
    const last = state.lastCallBySession.get(sessionId)
    if (typeof last === 'number' && now - last < budget.cooldownSec * 1000) {
      return { ok: false, reason: 'cooldown' }
    }
    state.lastCallBySession.set(sessionId, now)
  }

  state.usedToday++
  state.inFlight++
  return { ok: true }
}

/** Always call this in a `finally`: a leaked slot shrinks the limit for good. */
export function releaseUtilityCall(): void {
  state.inFlight = Math.max(0, state.inFlight - 1)
}

export function utilityBudgetSnapshot(): { day: string; usedToday: number; inFlight: number } {
  return { day: state.day, usedToday: state.usedToday, inFlight: state.inFlight }
}

export function __resetUtilityBudgetForTests(): void {
  state.day = ''
  state.usedToday = 0
  state.inFlight = 0
  state.lastCallBySession.clear()
}

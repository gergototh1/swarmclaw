import { NON_LANGGRAPH_PROVIDER_IDS } from '@/lib/provider-sets'

/**
 * Which model does the host's own helper work.
 *
 * Working-state extraction, the message classifier, autonomy observation, the
 * daily memory digest and the abstract writer all need a model that is NOT the
 * agent's. On an install where every agent runs on a coding CLI and no API key
 * is configured there was no such model, so all of them failed — 696 times in
 * one log — and the memory store filled with raw transcripts nobody ever
 * distilled.
 *
 * Resolution order, cheapest thing that works first:
 *   1. `utilityProvider` / `utilityModel` — the one place an operator sets this.
 *   2. `dreamProvider` / `dreamModel` — consolidation already looked here.
 *   3. the installed coding CLI, on a cheap model.
 *
 * A local model is deliberately not in this list: the whole point is that a
 * weak machine should not be the one doing the inference.
 */

/** Short, frequent, throwaway work — the cheapest model is the right one. */
export const DEFAULT_UTILITY_CLI_MODEL = 'claude-haiku-4-5-20251001'

export type UtilityModelChoice =
  | { kind: 'provider'; provider: string; model: string }
  | { kind: 'cli'; model: string }

export interface UtilityModelSettings {
  utilityProvider?: string | null
  utilityModel?: string | null
  dreamProvider?: string | null
  dreamModel?: string | null
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function resolveUtilityModelChoice(settings: UtilityModelSettings | null | undefined): UtilityModelChoice {
  const pairs: Array<[string, string]> = [
    [clean(settings?.utilityProvider), clean(settings?.utilityModel)],
    [clean(settings?.dreamProvider), clean(settings?.dreamModel)],
  ]

  for (const [provider, model] of pairs) {
    // A provider with no model is not a configuration, it is half of one.
    // Guessing the model would pick something the operator never asked for.
    if (!provider || !model) continue
    // An operator may point the helper at a CLI on purpose — to spend the
    // subscription rather than an API key, or to use a stronger model for it.
    if (NON_LANGGRAPH_PROVIDER_IDS.has(provider)) return { kind: 'cli', model }
    return { kind: 'provider', provider, model }
  }

  return { kind: 'cli', model: DEFAULT_UTILITY_CLI_MODEL }
}

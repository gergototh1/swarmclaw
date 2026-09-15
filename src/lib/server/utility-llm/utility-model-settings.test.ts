import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_UTILITY_CLI_MODEL, resolveUtilityModelChoice } from './utility-model-settings'

/*
 * Melyik modell végzi a segédmunkát, és mikor.
 *
 * Sorrend: a settings `utilityProvider`/`utilityModel` mezője az egyetlen hely,
 * ahol ezt beállítod; utána a régi `dreamProvider`/`dreamModel` (a konszolidáció
 * már így is ezt kereste); és ha egyik sincs, akkor a CLI, ami már telepítve és
 * hitelesítve van.
 *
 * A CLI-tartalék NEM jogosultság-tágítás: `--strict-mcp-config` üres configgal
 * indul, tehát a segédhívásnak nincs egyetlen toolja sem, és sosem folytat
 * beszélgetést.
 *
 * Helyi modellt szándékosan nem választunk: gyenge gépen a helyi inferencia
 * pont azt a gépet terheli, amin az app fut.
 */
describe('resolveUtilityModelChoice', () => {
  it('prefers the utility model the operator configured', () => {
    const choice = resolveUtilityModelChoice({ utilityProvider: 'openai', utilityModel: 'gpt-5-mini' })
    assert.deepEqual(choice, { kind: 'provider', provider: 'openai', model: 'gpt-5-mini' })
  })

  it('falls back to the dream model, which consolidation already looked for', () => {
    const choice = resolveUtilityModelChoice({ dreamProvider: 'groq', dreamModel: 'llama-x' })
    assert.deepEqual(choice, { kind: 'provider', provider: 'groq', model: 'llama-x' })
  })

  it('lets the utility model win over the dream model', () => {
    const choice = resolveUtilityModelChoice({
      utilityProvider: 'openai', utilityModel: 'gpt-5-mini',
      dreamProvider: 'groq', dreamModel: 'llama-x',
    })
    assert.equal(choice.kind === 'provider' && choice.provider, 'openai')
  })

  it('falls back to the installed CLI when nothing is configured', () => {
    const choice = resolveUtilityModelChoice({})
    assert.deepEqual(choice, { kind: 'cli', model: DEFAULT_UTILITY_CLI_MODEL })
  })

  it('uses a cheap model for the CLI fallback', () => {
    // A kivonatolás rövid és sok: a legolcsóbb modell való rá, nem az, amin az
    // agent dolgozik.
    assert.match(DEFAULT_UTILITY_CLI_MODEL, /haiku/i)
  })

  it('honours an explicit CLI model without needing a provider', () => {
    const choice = resolveUtilityModelChoice({ utilityProvider: 'claude-cli', utilityModel: 'claude-sonnet-5' })
    assert.deepEqual(choice, { kind: 'cli', model: 'claude-sonnet-5' })
  })

  it('treats a provider with no model as unconfigured rather than guessing', () => {
    assert.deepEqual(resolveUtilityModelChoice({ utilityProvider: 'openai' }), { kind: 'cli', model: DEFAULT_UTILITY_CLI_MODEL })
  })

  it('ignores blank settings', () => {
    assert.equal(resolveUtilityModelChoice({ utilityProvider: '  ', utilityModel: '  ' }).kind, 'cli')
  })
})

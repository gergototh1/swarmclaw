import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { delegateToolName, resolveDelegationTargets } from './delegate-targets'

/*
 * MIÉRT VAN EZ.
 *
 * A `spawn_subagent` egyetlen általános tool, `agentId: { type: 'string' }`
 * paraméterrel, enum nélkül. A névsort a leíráshoz CSAK akkor fűztük hozzá, ha
 * `delegationTargetMode === 'selected'` -- a Sidekick viszont `'all'` módban
 * van, tehát azt kapta, hogy "Delegate tasks to other agents", és sehol nem
 * derült ki, hogy a `777e99a7` a "Fejlesztő", és hogy ő kódol.
 *
 * Mérhető következmény: a 2026-09-13/14-i kétnapos, 31 fordulós fejlesztés
 * alatt a `delegation_jobs` táblába a `70dd3e11` sessionből NULLA sor került.
 * A Sidekick végig a Claude Code SAJÁT `Agent` tooljával dolgozott -- azzal,
 * amelyik névvel és leírással ellátott ügynöklistát hoz magával. A modell azt
 * a menüt használta, amelyiket látta.
 *
 * Az OpenAI Agents SDK és a LangGraph Swarm is ugyanoda konvergál: minden
 * célügynök KÜLÖN tool, `transfer_to_<agent_name>` néven, a cél saját
 * leírásával. Ez ugyanaz, `delegate_to_` előtaggal.
 */
describe('delegateToolName', () => {
  it('builds a readable tool name from the agent name', () => {
    assert.equal(delegateToolName('Fejlesztő'), 'delegate_to_fejleszto')
    assert.equal(delegateToolName('Videó Lektor'), 'delegate_to_video_lektor')
  })

  it('folds Hungarian accents rather than dropping the letters', () => {
    // "Kutató" -> kutato, nem "kutat".
    assert.equal(delegateToolName('Kutató'), 'delegate_to_kutato')
    assert.equal(delegateToolName('Ügyfélkezelő'), 'delegate_to_ugyfelkezelo')
  })

  it('produces a name a tool API will accept', () => {
    for (const raw of ['Signal Scout', 'remo', 'A/B — Tester 2.0', 'Ügyfélkezelő']) {
      assert.match(delegateToolName(raw), /^delegate_to_[a-z0-9_]+$/)
    }
  })

  it('never returns a bare prefix for an unusable name', () => {
    assert.notEqual(delegateToolName('???'), 'delegate_to_')
    assert.match(delegateToolName('???'), /^delegate_to_[a-z0-9_]+$/)
  })
})

describe('resolveDelegationTargets', () => {
  const agents = {
    me: { id: 'me', name: 'Sidekick', description: 'General assistant.' },
    dev: { id: 'dev', name: 'Fejlesztő', description: 'Kódol, tesztel, mergel.' },
    res: { id: 'res', name: 'Kutató', description: 'Piac- és cégkutatás.' },
    dup: { id: 'dup', name: 'Fejlesztő', description: 'Másik fejlesztő.' },
    gone: { id: 'gone', name: 'Régi', description: 'x', trashedAt: 1 },
  }

  it('returns nothing when delegation is off', () => {
    const targets = resolveDelegationTargets({ agentId: 'me', delegationEnabled: false }, agents)
    assert.deepEqual(targets, [])
  })

  it('lists every other agent in "all" mode', () => {
    const targets = resolveDelegationTargets(
      { agentId: 'me', delegationEnabled: true, delegationTargetMode: 'all' },
      agents,
    )
    assert.deepEqual(targets.map((t) => t.id).sort(), ['dev', 'dup', 'res'])
  })

  it('never offers the caller itself', () => {
    const targets = resolveDelegationTargets(
      { agentId: 'dev', delegationEnabled: true, delegationTargetMode: 'all' },
      agents,
    )
    assert.equal(targets.some((t) => t.id === 'dev'), false)
  })

  it('skips a trashed agent', () => {
    const targets = resolveDelegationTargets(
      { agentId: 'me', delegationEnabled: true, delegationTargetMode: 'all' },
      agents,
    )
    assert.equal(targets.some((t) => t.id === 'gone'), false)
  })

  it('honours the selected list, which is the operator\'s restriction', () => {
    const targets = resolveDelegationTargets(
      {
        agentId: 'me',
        delegationEnabled: true,
        delegationTargetMode: 'selected',
        delegationTargetAgentIds: ['dev'],
      },
      agents,
    )
    assert.deepEqual(targets.map((t) => t.id), ['dev'])
  })

  it('gives two agents sharing a name distinct tool names', () => {
    // Egy ütköző név csendben elnyelné az egyik ügynököt a tool-táblából.
    const targets = resolveDelegationTargets(
      { agentId: 'me', delegationEnabled: true, delegationTargetMode: 'all' },
      agents,
    )
    const names = targets.map((t) => t.toolName)
    assert.equal(new Set(names).size, names.length, `duplicate tool names: ${names.join(', ')}`)
  })

  it('carries the agent id, so the caller never has to guess it', () => {
    const targets = resolveDelegationTargets(
      { agentId: 'me', delegationEnabled: true, delegationTargetMode: 'all' },
      agents,
    )
    const dev = targets.find((t) => t.id === 'dev')
    assert.ok(dev)
    assert.equal(dev.name, 'Fejlesztő')
    assert.match(dev.description, /Kódol/)
  })

  it('caps the roster so a large fleet cannot flood the tool table', () => {
    const many: Record<string, { id: string; name: string; description: string }> = {}
    for (let i = 0; i < 40; i++) many[`a${i}`] = { id: `a${i}`, name: `Agent ${i}`, description: 'x' }
    const targets = resolveDelegationTargets(
      { agentId: 'me', delegationEnabled: true, delegationTargetMode: 'all' },
      many,
    )
    assert.ok(targets.length <= 12, `expected at most 12 targets, got ${targets.length}`)
  })
})

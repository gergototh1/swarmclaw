import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { crudActionsFor } from './crud'

/*
 * A `manage_*` család egyetlen, közös action-enumot hirdetett minden
 * erőforrásra: `list, get, create, update, delete, claim_task, check, request`.
 *
 * Ebből a `claim_task` csak a `manage_tasks`-on, a `check` és a `request` csak
 * a `manage_secrets`-en létezik (crud.ts: `action === 'claim_task' && toolKey
 * === 'manage_tasks'`). A `manage_webhooks`-nak hirdetett `claim_task` tehát
 * egy olyan érték, amit a tool "Unknown action"-nel utasít vissza -- egy enum,
 * ami érvénytelen kimenetet legitimál, rosszabb, mint a hiányzó enum: pont azt
 * a hibaosztályt engedi be, amit az enumnak ki kellene zárnia.
 *
 * A readOnly erőforrások ugyanígy nem hirdethetnek írást: a `create` ott
 * garantáltan "Cannot create ... (read-only)" választ ad (crud.ts:600).
 */
describe('crudActionsFor', () => {
  it('offers claim_task only on tasks', () => {
    assert.ok(crudActionsFor('manage_tasks', false).includes('claim_task'))
    for (const key of ['manage_agents', 'manage_projects', 'manage_schedules', 'manage_webhooks', 'manage_secrets', 'manage_connectors']) {
      assert.equal(crudActionsFor(key, false).includes('claim_task'), false, `${key} cannot claim a task`)
    }
  })

  it('offers check and request only on secrets', () => {
    const secrets = crudActionsFor('manage_secrets', false)
    assert.ok(secrets.includes('check'))
    assert.ok(secrets.includes('request'))
    for (const key of ['manage_tasks', 'manage_agents', 'manage_projects', 'manage_schedules', 'manage_webhooks', 'manage_connectors']) {
      const actions = crudActionsFor(key, false)
      assert.equal(actions.includes('check'), false, `${key} has no check action`)
      assert.equal(actions.includes('request'), false, `${key} has no request action`)
    }
  })

  it('always offers the plain CRUD verbs', () => {
    for (const key of ['manage_tasks', 'manage_agents', 'manage_projects', 'manage_schedules', 'manage_webhooks', 'manage_secrets', 'manage_connectors']) {
      const actions = crudActionsFor(key, false)
      for (const verb of ['list', 'get', 'create', 'update', 'delete']) {
        assert.ok(actions.includes(verb), `${key} must offer ${verb}`)
      }
    }
  })

  it('hides the write verbs on a read-only resource', () => {
    const actions = crudActionsFor('manage_agents', true)
    assert.deepEqual(actions, ['list', 'get'])
  })

  it('never returns an empty list, so the enum is always constructible', () => {
    assert.ok(crudActionsFor('something_unknown', false).length > 0)
  })
})

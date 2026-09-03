import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'
import { extensionTablePrefix, validateMigrationSql } from './extension-storage'

describe('extensionTablePrefix', () => {
  it('derives ext_<id>_ from the filename', () => {
    assert.equal(extensionTablePrefix('aisignal.mjs'), 'ext_aisignal_')
    assert.equal(extensionTablePrefix('my-plugin.js'), 'ext_my_plugin_')
  })
})

describe('validateMigrationSql', () => {
  it('accepts CREATE TABLE with the prefix and rejects without', () => {
    assert.equal(validateMigrationSql('ext_a_', 'CREATE TABLE IF NOT EXISTS ext_a_items (id TEXT)').ok, true)
    assert.equal(validateMigrationSql('ext_a_', 'CREATE TABLE sessions_copy (id TEXT)').ok, false)
    assert.equal(validateMigrationSql('ext_a_', 'CREATE INDEX idx ON ext_a_items(id)').ok, true)
  })
})

describe('runExtensionMigrations + createExtensionStorage', () => {
  it('applies each version once and the storage can read the table', () => {
    const out = runWithTempDataDir<{ first: number[]; second: number[]; rows: number }>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { runExtensionMigrations, createExtensionStorage } = mod.default || mod
      const mig = [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_t_items (id TEXT PRIMARY KEY, v INTEGER)' }]
      const first = runExtensionMigrations('t.mjs', mig).applied
      const second = runExtensionMigrations('t.mjs', mig).applied
      const s = createExtensionStorage('t.mjs')
      s.transaction(() => { s.exec('INSERT INTO ext_t_items (id, v) VALUES (?, ?)', ['a', 1]); s.exec('INSERT INTO ext_t_items (id, v) VALUES (?, ?)', ['b', 2]) })
      console.log(JSON.stringify({ first, second, rows: s.all('SELECT * FROM ext_t_items').length }))
    `)
    assert.deepEqual(out.first, [1]); assert.deepEqual(out.second, []); assert.equal(out.rows, 2)
  })

  it('refuses a migration that creates a table outside the prefix', () => {
    const out = runWithTempDataDir<{ error: string }>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { runExtensionMigrations } = mod.default || mod
      try { runExtensionMigrations('t.mjs', [{ version: 1, sql: 'CREATE TABLE evil (id TEXT)' }]); console.log(JSON.stringify({ error: '' })) }
      catch (e) { console.log(JSON.stringify({ error: String(e.message) })) }
    `)
    assert.match(out.error, /ext_t_/)
  })

  it('rolls a half-failing migration back and records nothing for it', () => {
    const out = runWithTempDataDir<{ error: string; tables: string[]; recorded: number }>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { runExtensionMigrations } = mod.default || mod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      let error = ''
      try {
        runExtensionMigrations('t.mjs', [
          { version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_t_kept (id TEXT)' },
          { version: 2, sql: 'CREATE TABLE IF NOT EXISTS ext_t_half (id TEXT); INSERT INTO ext_t_absent (id) VALUES (1)' },
        ])
      } catch (e) { error = String(e.message) }
      const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_t_%' ORDER BY name").all().map((r) => r.name)
      const recorded = getDb().prepare('SELECT version FROM ext_migrations WHERE extension_id = ?').all('t.mjs').map((r) => r.version)
      console.log(JSON.stringify({ error, tables, recorded: recorded.length === 1 && recorded[0] === 1 ? 1 : -1 }))
    `)
    assert.match(out.error, /v2/)
    assert.deepEqual(out.tables, ['ext_t_kept'])
    assert.equal(out.recorded, 1)
  })

  it('rejects two migrations declaring the same version', () => {
    const out = runWithTempDataDir<{ error: string }>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { runExtensionMigrations } = mod.default || mod
      let error = ''
      try {
        runExtensionMigrations('t.mjs', [
          { version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_t_a (id TEXT)' },
          { version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_t_b (id TEXT)' },
        ])
      } catch (e) { error = String(e.message) }
      console.log(JSON.stringify({ error }))
    `)
    assert.match(out.error, /version 1/)
  })

  it('does not re-run a version whose sql was edited after it was applied', () => {
    const out = runWithTempDataDir<{ second: number[]; tables: string[] }>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { runExtensionMigrations } = mod.default || mod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      runExtensionMigrations('t.mjs', [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_t_original (id TEXT)' }])
      const second = runExtensionMigrations('t.mjs', [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_t_edited (id TEXT)' }]).applied
      const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ext_t_%' ORDER BY name").all().map((r) => r.name)
      console.log(JSON.stringify({ second, tables }))
    `)
    assert.deepEqual(out.second, [])
    assert.deepEqual(out.tables, ['ext_t_original'])
  })
})

describe('setup(ctx) through the manager', () => {
  it('runs migrations, hands storage to setup, and the tool can use it', () => {
    const out = runWithTempDataDir<{ count: number }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()
      await m.saveExtensionSource('st_a.mjs', \`
        let storage = null
        export default {
          name: 'ST',
          migrations: [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_st_a_notes (id TEXT PRIMARY KEY)' }],
          setup(ctx) { storage = ctx.storage },
          tools: [{ name: 'st_add', description: 'x', parameters: { type: 'object', properties: {} },
            execute: () => { storage.exec('INSERT OR IGNORE INTO ext_st_a_notes (id) VALUES (?)', ['n1']); return String(storage.all('SELECT * FROM ext_st_a_notes').length) } }],
        }\`)
      m.reload()
      const entry = m.getTools(['st_a.mjs']).find((t) => t.tool.name === 'st_add')
      const count = Number(await entry.tool.execute({}, { session: {}, message: '' }))
      console.log(JSON.stringify({ count }))
    `)
    assert.equal(out.count, 1)
  })

  it('rejects the extension when setup(ctx) throws, naming the setup stage', () => {
    const out = runWithTempDataDir<{ loaded: boolean; stage: string; error: string }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()
      await m.saveExtensionSource('st_boom.mjs', \`
        export default {
          name: 'STBoom',
          tools: [{ name: 'st_boom', description: 'x', parameters: { type: 'object', properties: {} }, execute: () => 'ok' }],
          setup() { throw new Error('setup exploded') },
        }\`)
      m.reload()
      const meta = m.listExtensions().find((e) => e.filename === 'st_boom.mjs')
      console.log(JSON.stringify({
        loaded: m.getTools(['st_boom.mjs']).length > 0,
        stage: meta?.lastFailureStage || '',
        error: meta?.lastFailureError || '',
      }))
    `)
    assert.equal(out.loaded, false)
    assert.equal(out.stage, 'load.setup')
    assert.match(out.error, /setup exploded/)
  })

  it('gives setup an oauth stub that rejects with a named, readable error', () => {
    const out = runWithTempDataDir<{ has: boolean; name: string; message: string }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const m = getExtensionManager()
      await m.saveExtensionSource('st_oauth.mjs', \`
        let seen = null
        export default {
          name: 'STOauth',
          setup(ctx) { seen = ctx.oauth },
          tools: [{ name: 'st_oauth_probe', description: 'x', parameters: { type: 'object', properties: {} },
            execute: async () => {
              const has = seen.hasGoogleCredential('gmail')
              try { await seen.getGoogleAccessToken('gmail'); return JSON.stringify({ has, name: '', message: '' }) }
              catch (e) { return JSON.stringify({ has, name: e.name, message: e.message }) }
            } }],
        }\`)
      m.reload()
      const entry = m.getTools(['st_oauth.mjs']).find((t) => t.tool.name === 'st_oauth_probe')
      console.log(await entry.tool.execute({}, { session: {}, message: '' }))
    `)
    assert.equal(out.has, false)
    assert.equal(out.name, 'GoogleOAuthNotConfiguredError')
    assert.match(out.message, /not configured/i)
  })
})

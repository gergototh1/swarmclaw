import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

// Nothing in this file imports './extension-storage' statically. That import
// chain reaches '@/lib/server/storage', whose module body opens (and on a fresh
// checkout creates) ./data/swarmclaw.db in WAL mode and installs shutdown
// handlers for it. Even the two pure helpers below therefore run inside
// runWithTempDataDir, so the test process never becomes a second writer on the
// developer's database.

describe('extensionTablePrefix', () => {
  it('derives ext_<id>_ from the filename', () => {
    const out = runWithTempDataDir<{ aisignal: string; hyphenated: string }>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { extensionTablePrefix } = mod.default || mod
      console.log(JSON.stringify({ aisignal: extensionTablePrefix('aisignal.mjs'), hyphenated: extensionTablePrefix('my-extension.js') }))
    `)
    assert.equal(out.aisignal, 'ext_aisignal_')
    assert.equal(out.hyphenated, 'ext_my_extension_')
  })
})

describe('validateMigrationSql', () => {
  it('checks the table name of every CREATE TABLE spelling, TEMP and VIRTUAL and bracket-quoted included', () => {
    const out = runWithTempDataDir<Record<string, boolean>>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { validateMigrationSql } = mod.default || mod
      const cases = {
        prefixed: 'CREATE TABLE IF NOT EXISTS ext_a_items (id TEXT)',
        unprefixed: 'CREATE TABLE sessions_copy (id TEXT)',
        index: 'CREATE INDEX idx ON ext_a_items(id)',
        temp: 'CREATE TEMP TABLE settings (id TEXT)',
        temporary: 'CREATE TEMPORARY TABLE settings (id TEXT)',
        virtual: 'CREATE VIRTUAL TABLE evil_fts USING fts5(body)',
        bracketed: 'CREATE TABLE [settings] (id TEXT)',
        bracketedIfNotExists: 'CREATE TABLE IF NOT EXISTS [settings] (id TEXT)',
        quotedWithoutSpace: 'CREATE TABLE"settings" (id TEXT)',
        tempPrefixed: 'CREATE TEMP TABLE ext_a_scratch (id TEXT)',
        virtualPrefixed: 'CREATE VIRTUAL TABLE ext_a_fts USING fts5(body)',
        bracketedPrefixed: 'CREATE TABLE [ext_a_items] (id TEXT)',
        tempView: 'CREATE TEMP VIEW settings AS SELECT 1',
        temporaryView: 'CREATE TEMPORARY VIEW settings AS SELECT 1',
        tempViewPrefixed: 'CREATE TEMP VIEW ext_a_report AS SELECT 1',
      }
      const result = {}
      for (const [key, sql] of Object.entries(cases)) result[key] = validateMigrationSql('ext_a_', sql).ok
      console.log(JSON.stringify(result))
    `)
    assert.deepEqual(out, {
      prefixed: true,
      unprefixed: false,
      index: true,
      temp: false,
      temporary: false,
      virtual: false,
      bracketed: false,
      bracketedIfNotExists: false,
      quotedWithoutSpace: false,
      tempPrefixed: true,
      virtualPrefixed: true,
      bracketedPrefixed: true,
      tempView: false,
      temporaryView: false,
      tempViewPrefixed: true,
    })
  })

  it('explains why a quoted non-ascii table name is rejected instead of blaming "IF"', () => {
    const out = runWithTempDataDir<{ error: string }>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { validateMigrationSql } = mod.default || mod
      const result = validateMigrationSql('ext_a_', 'CREATE TABLE IF NOT EXISTS "\u00e9vil" (id TEXT)')
      console.log(JSON.stringify({ error: result.ok ? '' : result.error }))
    `)
    // The name is still rejected, but not as a table literally called "IF".
    assert.doesNotMatch(out.error, /"IF"/)
    assert.match(out.error, /ext_a_/)
    assert.match(out.error, /letters, digits and underscore/)
  })

  it('says the prefix is matched case-sensitively when a table name only differs in case', () => {
    const out = runWithTempDataDir<{ error: string }>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { validateMigrationSql } = mod.default || mod
      const result = validateMigrationSql('ext_a_', 'CREATE TABLE EXT_A_ITEMS (id TEXT)')
      console.log(JSON.stringify({ error: result.ok ? '' : result.error }))
    `)
    assert.match(out.error, /EXT_A_ITEMS/)
    assert.match(out.error, /case/i)
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

  it('refuses a CREATE TEMP TABLE, which would otherwise shadow a host table for the process', () => {
    const out = runWithTempDataDir<{ error: string; applied: number }>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { runExtensionMigrations } = mod.default || mod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      let error = ''
      try { runExtensionMigrations('t.mjs', [{ version: 1, sql: 'CREATE TEMP TABLE settings (id TEXT)' }]) }
      catch (e) { error = String(e.message) }
      const applied = getDb().prepare('SELECT version FROM ext_migrations WHERE extension_id = ?').all('t.mjs').length
      console.log(JSON.stringify({ error, applied }))
    `)
    assert.match(out.error, /ext_t_/)
    assert.equal(out.applied, 0)
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
      await m.reload()
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
      await m.reload()
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
      await m.reload()
      const entry = m.getTools(['st_oauth.mjs']).find((t) => t.tool.name === 'st_oauth_probe')
      console.log(await entry.tool.execute({}, { session: {}, message: '' }))
    `)
    assert.equal(out.has, false)
    assert.equal(out.name, 'GoogleOAuthNotConfiguredError')
    assert.match(out.message, /not configured/i)
  })
})

describe('deleteExtension drops the extension schema', () => {
  it('removes its tables and its ext_migrations rows, so a reinstall re-runs its migrations', () => {
    const out = runWithTempDataDir<{
      deleted: boolean
      before: { tables: string[]; rows: number }
      after: { tables: string[]; rows: number }
      reinstalled: string
    }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      const snapshot = () => ({
        tables: getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name).filter((n) => n.startsWith('ext_del_a_')),
        rows: getDb().prepare('SELECT version FROM ext_migrations WHERE extension_id = ?').all('del_a.mjs').length,
      })
      const m = getExtensionManager()
      // v1 of the first installed version: one column.
      await m.saveExtensionSource('del_a.mjs', \`
        let storage = null
        export default {
          name: 'DelA',
          migrations: [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_del_a_notes (id TEXT PRIMARY KEY)' }],
          setup(ctx) { storage = ctx.storage },
          tools: [{ name: 'del_a_add', description: 'x', parameters: { type: 'object', properties: {} },
            execute: () => { storage.exec('INSERT INTO ext_del_a_notes (id) VALUES (?)', ['n1']); return String(storage.all('SELECT * FROM ext_del_a_notes').length) } }],
        }\`)
      await m.reload()
      const before = snapshot()
      const deleted = await m.deleteExtension('del_a.mjs')
      const after = snapshot()
      // A newer version whose v1 declares three columns. If the uninstall left
      // the old ext_migrations row behind, this migration is skipped and the
      // tool call below fails with "no such column".
      await m.saveExtensionSource('del_a.mjs', \`
        let storage = null
        export default {
          name: 'DelA',
          migrations: [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_del_a_notes (id TEXT PRIMARY KEY, body TEXT, tag TEXT)' }],
          setup(ctx) { storage = ctx.storage },
          tools: [{ name: 'del_a_add', description: 'x', parameters: { type: 'object', properties: {} },
            execute: () => { storage.exec('INSERT INTO ext_del_a_notes (id, body, tag) VALUES (?, ?, ?)', ['n1', 'b', 't']); return String(storage.all('SELECT * FROM ext_del_a_notes').length) } }],
        }\`)
      await m.reload()
      const entry = m.getTools(['del_a.mjs']).find((t) => t.tool.name === 'del_a_add')
      let reinstalled = ''
      try { reinstalled = String(await entry.tool.execute({}, { session: {}, message: '' })) }
      catch (e) { reinstalled = 'ERROR: ' + e.message }
      console.log(JSON.stringify({ deleted, before, after, reinstalled }))
    `)
    assert.equal(out.deleted, true)
    assert.deepEqual(out.before, { tables: ['ext_del_a_notes'], rows: 1 })
    assert.deepEqual(out.after, { tables: [], rows: 0 })
    assert.equal(out.reinstalled, '1')
  })

  it('deletes an extension that never ran a migration and leaves other extensions alone', () => {
    const out = runWithTempDataDir<{ deleted: boolean; tables: string[]; keeperRows: number }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      const m = getExtensionManager()
      await m.saveExtensionSource('del_b.mjs', \`
        export default {
          name: 'DelB',
          tools: [{ name: 'del_b_noop', description: 'x', parameters: { type: 'object', properties: {} }, execute: () => 'ok' }],
        }\`)
      await m.saveExtensionSource('del_c.mjs', \`
        export default {
          name: 'DelC',
          migrations: [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_del_c_keep (id TEXT)' }],
        }\`)
      await m.reload()
      const deleted = await m.deleteExtension('del_b.mjs')
      const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name).filter((n) => n.startsWith('ext_del_'))
      const keeperRows = getDb().prepare('SELECT version FROM ext_migrations WHERE extension_id = ?').all('del_c.mjs').length
      console.log(JSON.stringify({ deleted, tables, keeperRows }))
    `)
    assert.equal(out.deleted, true)
    assert.deepEqual(out.tables, ['ext_del_c_keep'])
    assert.equal(out.keeperRows, 1)
  })

  it('still deletes when one of the extension tables is already gone', () => {
    const out = runWithTempDataDir<{ deleted: boolean; error: string; rows: number }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      const m = getExtensionManager()
      await m.saveExtensionSource('del_d.mjs', \`
        export default {
          name: 'DelD',
          migrations: [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_del_d_notes (id TEXT)' }],
        }\`)
      await m.reload()
      getDb().exec('DROP TABLE ext_del_d_notes')
      let deleted = false
      let error = ''
      try { deleted = await m.deleteExtension('del_d.mjs') } catch (e) { error = String(e.message) }
      const rows = getDb().prepare('SELECT version FROM ext_migrations WHERE extension_id = ?').all('del_d.mjs').length
      console.log(JSON.stringify({ deleted, error, rows }))
    `)
    assert.equal(out.error, '')
    assert.equal(out.deleted, true)
    assert.equal(out.rows, 0)
  })
})

describe('ctx.settings() inside setup(ctx)', () => {
  it('reads the stored settings without re-entering the extension loader', () => {
    const out = runWithTempDataDir<{
      setupCalls: number
      settings: Record<string, unknown> | null
      stage: string
      error: string
      loaded: boolean
    }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const storageMod = await import('@/lib/server/storage')
      const { loadSettings, saveSettings } = storageMod.default || storageMod
      const m = getExtensionManager()
      await m.saveExtensionSource('set_a.mjs', \`
        export default {
          name: 'SetA',
          ui: { settingsFields: [
            { key: 'token', label: 'Token', type: 'text' },
            { key: 'mode', label: 'Mode', type: 'text', defaultValue: 'fallback' },
          ] },
          setup(ctx) {
            globalThis.__setupCalls = (globalThis.__setupCalls || 0) + 1
            globalThis.__setupSettings = ctx.settings()
          },
          tools: [{ name: 'set_a_probe', description: 'x', parameters: { type: 'object', properties: {} }, execute: () => 'ok' }],
        }\`)
      const stored = loadSettings()
      stored.extensionSettings = { ...(stored.extensionSettings || {}), 'set_a.mjs': { token: 'stored-token' } }
      saveSettings(stored)
      // saveExtensionSource reloads on its own, so count only the reload below.
      globalThis.__setupCalls = 0
      let error = ''
      try { await m.reload() } catch (e) { error = String(e && e.message ? e.message : e) }
      // Counted here, before anything else can trigger a further load: one
      // reload must call setup exactly once.
      const setupCalls = globalThis.__setupCalls || 0
      let meta = null
      try { meta = m.listExtensions().find((e) => e.filename === 'set_a.mjs') } catch (e) { error = error || String(e && e.message ? e.message : e) }
      let loaded = false
      try { loaded = m.getTools(['set_a.mjs']).length > 0 } catch { loaded = false }
      console.log(JSON.stringify({
        setupCalls,
        settings: globalThis.__setupSettings || null,
        stage: (meta && meta.lastFailureStage) || '',
        error,
        loaded,
      }))
    `)
    // Pre-fix this recursed until the stack was exhausted: setup ran ~1300 times
    // and the extension did not load.
    assert.equal(out.setupCalls, 1)
    assert.equal(out.error, '')
    assert.equal(out.stage, '')
    assert.equal(out.loaded, true)
    // Stored values, not merely the declared field list, plus declared defaults.
    assert.deepEqual(out.settings, { token: 'stored-token', mode: 'fallback' })
  })
})

describe('deleteExtension with a nested extension prefix', () => {
  it('keeps the tables and migration rows of an extension whose prefix extends the deleted one', () => {
    const out = runWithTempDataDir<{
      deleted: boolean
      tables: string[]
      proRows: number
      proSelect: string
    }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      const m = getExtensionManager()
      await m.saveExtensionSource('nest_a.mjs', \`
        export default {
          name: 'NestA',
          migrations: [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_nest_a_notes (id TEXT PRIMARY KEY)' }],
        }\`)
      await m.saveExtensionSource('nest_a_pro.mjs', \`
        export default {
          name: 'NestAPro',
          migrations: [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_nest_a_pro_notes (id TEXT PRIMARY KEY)' }],
        }\`)
      await m.reload()
      getDb().prepare('INSERT INTO ext_nest_a_pro_notes (id) VALUES (?)').run('kept')
      const deleted = await m.deleteExtension('nest_a.mjs')
      const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name).filter((n) => n.startsWith('ext_nest_'))
      const proRows = getDb().prepare('SELECT version FROM ext_migrations WHERE extension_id = ?').all('nest_a_pro.mjs').length
      let proSelect = ''
      try { proSelect = String(getDb().prepare('SELECT COUNT(*) AS c FROM ext_nest_a_pro_notes').get().c) }
      catch (e) { proSelect = 'ERROR: ' + e.message }
      console.log(JSON.stringify({ deleted, tables, proRows, proSelect }))
    `)
    assert.equal(out.deleted, true)
    assert.deepEqual(out.tables, ['ext_nest_a_pro_notes'])
    assert.equal(out.proRows, 1)
    assert.equal(out.proSelect, '1')
  })
})

describe('deleteExtension drops prefixed views and triggers', () => {
  it('lets a reinstall re-run a migration that creates a view', () => {
    const out = runWithTempDataDir<{
      leftovers: Array<{ type: string; name: string }>
      stage: string
      reinstalled: string
    }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      const source = \`
        let storage = null
        export default {
          name: 'ViewA',
          migrations: [{ version: 1, sql: [
            'CREATE TABLE IF NOT EXISTS ext_view_a_notes (id TEXT PRIMARY KEY, seen INTEGER)',
            'CREATE VIEW ext_view_a_report AS SELECT id FROM ext_view_a_notes',
            'CREATE TRIGGER ext_view_a_stamp AFTER INSERT ON ext_view_a_notes BEGIN UPDATE ext_view_a_notes SET seen = 1 WHERE id = NEW.id; END',
          ].join('; ') }],
          setup(ctx) { storage = ctx.storage },
          tools: [{ name: 'view_a_count', description: 'x', parameters: { type: 'object', properties: {} },
            execute: () => { storage.exec('INSERT INTO ext_view_a_notes (id) VALUES (?)', ['n1']); return String(storage.all('SELECT * FROM ext_view_a_report').length) } }],
        }\`
      const m = getExtensionManager()
      await m.saveExtensionSource('view_a.mjs', source)
      await m.reload()
      await m.deleteExtension('view_a.mjs')
      const leftovers = getDb().prepare('SELECT type, name FROM sqlite_master ORDER BY name').all().filter((r) => String(r.name).startsWith('ext_view_a_'))
      await m.saveExtensionSource('view_a.mjs', source)
      await m.reload()
      const meta = m.listExtensions().find((e) => e.filename === 'view_a.mjs')
      const entry = m.getTools(['view_a.mjs']).find((t) => t.tool.name === 'view_a_count')
      let reinstalled = ''
      if (!entry) reinstalled = 'NOT LOADED'
      else {
        try { reinstalled = String(await entry.tool.execute({}, { session: {}, message: '' })) }
        catch (e) { reinstalled = 'ERROR: ' + e.message }
      }
      console.log(JSON.stringify({ leftovers, stage: (meta && meta.lastFailureStage) || '', reinstalled }))
    `)
    assert.deepEqual(out.leftovers, [])
    assert.equal(out.stage, '')
    assert.equal(out.reinstalled, '1')
  })
})

describe('deleteExtension drops prefixed indexes even on a table it does not own', () => {
  it('lets a reinstall re-run a migration that indexes a table outside its prefix', () => {
    const out = runWithTempDataDir<{
      leftovers: Array<{ type: string; name: string }>
      hostTableSurvived: boolean
      stage: string
      reinstalled: string
    }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      // Stands in for a host table: created directly, not through a migration,
      // because validateMigrationSql inspects CREATE TABLE/VIEW and would
      // refuse a migration that tried to create an unprefixed table itself.
      // CREATE INDEX is not inspected at all (see validateMigrationSql's doc
      // comment), so a migration naming its index with the extension's own
      // prefix while pointing it at a table outside that prefix is not
      // hypothetical -- it is exactly what an unchecked CREATE INDEX allows.
      getDb().exec('CREATE TABLE host_sweeps (id TEXT PRIMARY KEY, ran INTEGER)')
      const source = \`
        let storage = null
        export default {
          name: 'IdxA',
          migrations: [{ version: 1, sql: [
            'CREATE TABLE IF NOT EXISTS ext_idx_a_items (id TEXT PRIMARY KEY)',
            'CREATE UNIQUE INDEX ext_idx_a_sweeps_ran ON host_sweeps(ran)',
          ].join('; ') }],
          setup(ctx) { storage = ctx.storage },
          tools: [{ name: 'idx_a_count', description: 'x', parameters: { type: 'object', properties: {} },
            execute: () => { storage.exec('INSERT INTO ext_idx_a_items (id) VALUES (?)', ['n1']); return String(storage.all('SELECT * FROM ext_idx_a_items').length) } }],
        }\`
      const m = getExtensionManager()
      await m.saveExtensionSource('idx_a.mjs', source)
      await m.reload()
      await m.deleteExtension('idx_a.mjs')
      const leftovers = getDb().prepare('SELECT type, name FROM sqlite_master ORDER BY name').all().filter((r) => String(r.name).startsWith('ext_idx_a_'))
      const hostTableSurvived = getDb().prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'host_sweeps'").get() != null
      // Reinstall: same source, so the same CREATE UNIQUE INDEX (no "IF NOT
      // EXISTS") runs again. Pre-fix, the index from the first install is
      // still sitting in sqlite_master and this dies with "index ... already
      // exists", exactly the failure mode views and triggers had before they
      // were dropped on uninstall.
      await m.saveExtensionSource('idx_a.mjs', source)
      await m.reload()
      const meta = m.listExtensions().find((e) => e.filename === 'idx_a.mjs')
      const entry = m.getTools(['idx_a.mjs']).find((t) => t.tool.name === 'idx_a_count')
      let reinstalled = ''
      if (!entry) reinstalled = 'NOT LOADED'
      else {
        try { reinstalled = String(await entry.tool.execute({}, { session: {}, message: '' })) }
        catch (e) { reinstalled = 'ERROR: ' + e.message }
      }
      console.log(JSON.stringify({ leftovers, hostTableSurvived, stage: (meta && meta.lastFailureStage) || '', reinstalled }))
    `)
    assert.deepEqual(out.leftovers, [])
    // The index's own table is never touched -- only the prefixed index name
    // is dropped, not the host table it happens to point at.
    assert.equal(out.hostTableSurvived, true)
    assert.equal(out.stage, '')
    assert.equal(out.reinstalled, '1')
  })
})

describe('dropExtensionStorage without an ext_migrations table', () => {
  it('deletes cleanly in a database where no extension ever migrated', () => {
    const out = runWithTempDataDir<{ error: string; droppedObjects: string[]; droppedMigrationRows: number; migrationsTable: boolean }>(`
      const mod = await import('@/lib/server/extensions/extension-storage')
      const { dropExtensionStorage } = mod.default || mod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      let error = ''
      let result = { droppedObjects: [], droppedMigrationRows: -1 }
      try { result = dropExtensionStorage('never_migrated.mjs') } catch (e) { error = String(e.message) }
      const migrationsTable = getDb().prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'ext_migrations'").get() != null
      console.log(JSON.stringify({ error, droppedObjects: result.droppedObjects, droppedMigrationRows: result.droppedMigrationRows, migrationsTable }))
    `)
    assert.equal(out.error, '')
    assert.deepEqual(out.droppedObjects, [])
    assert.equal(out.droppedMigrationRows, 0)
    assert.equal(out.migrationsTable, false)
  })
})

describe('deleteExtension filename sanitising', () => {
  it('refuses a path-qualified filename instead of unlinking the file and orphaning its schema', () => {
    const out = runWithTempDataDir<{ error: string; stillInstalled: boolean; tables: string[] }>(`
      const extensionsMod = await import('@/lib/server/extensions')
      const { getExtensionManager } = extensionsMod.default || extensionsMod
      const storageMod = await import('@/lib/server/storage')
      const { getDb } = storageMod.default || storageMod
      const m = getExtensionManager()
      await m.saveExtensionSource('del_path.mjs', \`
        export default {
          name: 'DelPath',
          migrations: [{ version: 1, sql: 'CREATE TABLE IF NOT EXISTS ext_del_path_notes (id TEXT)' }],
        }\`)
      await m.reload()
      let error = ''
      try { await m.deleteExtension('./del_path.mjs') } catch (e) { error = String(e.message) }
      const stillInstalled = m.listExtensions().some((e) => e.filename === 'del_path.mjs')
      const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name).filter((n) => n.startsWith('ext_del_path'))
      console.log(JSON.stringify({ error, stillInstalled, tables }))
    `)
    assert.match(out.error, /Invalid filename/)
    assert.equal(out.stillInstalled, true)
    assert.deepEqual(out.tables, ['ext_del_path_notes'])
  })
})

#!/usr/bin/env node
/**
 * One-off cleanup for the digest rows and dangling edges the old
 * access-based compaction left behind.
 *
 * WHY THIS IS NEEDED ONCE. `runAccessBasedCompaction` used to `add` a new
 * `consolidated_insight` row on every idle window instead of rewriting one, so
 * the same digest accumulated: 191 of 347 rows in one live store, 67 in a
 * single day for one agent, with 1174 graph edges hanging off rows that recall
 * filters out anyway. The code now rewrites in place, which stops the growth
 * but does not undo it.
 *
 * WHAT IT DOES, per agent:
 *   - keeps the newest `origin: access-compaction` digest, deletes the rest
 *   - keeps the newest daily `consolidated_insight` digest, deletes the rest
 *   - drops every `linkedMemoryIds` entry naming a row that no longer exists
 *
 * Deletions go through the same back-reference cleanup the store does, so no
 * surviving row is left pointing at a deleted one.
 *
 * USAGE
 *   node scripts/memory-compact-digests.mjs                     # dry run
 *   node scripts/memory-compact-digests.mjs --apply             # write
 *   node scripts/memory-compact-digests.mjs --db <path/to/memory.db>
 *
 * The database must not be open in another process. Stop the desktop app (or
 * the dev server) first, and take a copy of memory.db before running --apply.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function parseArgs(argv) {
  const args = { apply: false, db: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true
    else if (argv[i] === '--db') args.db = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
  }
  return args
}

/** Where a desktop install keeps its data, then the repo checkout. */
function defaultDbPaths() {
  const home = os.homedir()
  return [
    process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'memory.db') : null,
    path.join(home, 'Library/Application Support/@swarmclawai/swarmclaw/home/data/memory.db'),
    path.join(home, '.config/swarmclaw/home/data/memory.db'),
    path.join(process.cwd(), 'data/memory.db'),
  ].filter(Boolean)
}

function resolveDb(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`no database at ${explicit}`)
    return explicit
  }
  const found = defaultDbPaths().find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error(`no memory.db found; pass --db <path>. Looked in:\n  ${defaultDbPaths().join('\n  ')}`)
  return found
}

function parseLinks(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && id.trim()) : []
  } catch {
    return []
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 30).join('\n')}\n`)
    return
  }

  const dbPath = resolveDb(args.db)
  const Database = require('better-sqlite3')
  const db = new Database(dbPath, { readonly: !args.apply })

  process.stdout.write(`database: ${dbPath}\nmode:     ${args.apply ? 'APPLY (writes)' : 'dry run'}\n\n`)

  const rows = db.prepare('SELECT id, agentId, category, metadata, linkedMemoryIds, updatedAt FROM memories').all()
  const alive = new Set(rows.map((row) => String(row.id)))

  // --- 1. digests: keep the newest per (agent, kind) -------------------------
  const groups = new Map()
  for (const row of rows) {
    if (String(row.category || '') !== 'consolidated_insight') continue
    let origin = ''
    try { origin = String(JSON.parse(row.metadata || '{}').origin || '') } catch { /* unparsable metadata is its own group */ }
    const key = `${row.agentId || ''}::${origin}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  const doomed = []
  for (const [key, group] of groups) {
    if (group.length <= 1) continue
    group.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    const [keep, ...rest] = group
    process.stdout.write(`${key}: ${group.length} digests -> keeping ${keep.id}, deleting ${rest.length}\n`)
    doomed.push(...rest.map((row) => String(row.id)))
  }
  if (!doomed.length) process.stdout.write('no duplicate digests found\n')

  // --- 2. dangling edges ----------------------------------------------------
  const doomedSet = new Set(doomed)
  const survives = (id) => alive.has(id) && !doomedSet.has(id)
  const relinks = []
  for (const row of rows) {
    if (doomedSet.has(String(row.id))) continue
    const links = parseLinks(row.linkedMemoryIds)
    if (!links.length) continue
    const kept = links.filter(survives)
    if (kept.length !== links.length) {
      relinks.push({ id: String(row.id), links: kept, dropped: links.length - kept.length })
    }
  }
  const droppedEdges = relinks.reduce((sum, entry) => sum + entry.dropped, 0)
  process.stdout.write(`\n${droppedEdges} dangling edge(s) across ${relinks.length} row(s)\n`)

  if (!args.apply) {
    process.stdout.write(`\nnothing written. Re-run with --apply to make these changes.\n`)
    db.close()
    return
  }

  const deleteStmt = db.prepare('DELETE FROM memories WHERE id = ?')
  const linkStmt = db.prepare('UPDATE memories SET linkedMemoryIds = ?, updatedAt = ? WHERE id = ?')
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const id of doomed) deleteStmt.run(id)
    for (const entry of relinks) {
      linkStmt.run(entry.links.length ? JSON.stringify(entry.links) : null, now, entry.id)
    }
  })
  tx()
  db.close()

  process.stdout.write(`\ndeleted ${doomed.length} digest row(s), rewrote ${relinks.length} link list(s)\n`)
}

main()

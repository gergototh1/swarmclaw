import fs from 'node:fs'
import path from 'node:path'

import { LEGACY_SHARED_FOLDER, LEGACY_TEMPLATES_FOLDER } from './legacy-names.mjs'
import { INTERNAL_FOLDER, TEMPLATES_FOLDER } from './permissions.mjs'

/**
 * The folders that were renamed with the rest of the module, moved once.
 *
 * Links need no rewriting: a `[[link]]` names a document by id or title, never
 * by path (see `resolveLink` in links.mjs), and `indexAll` recognises a file
 * whose id it knows at a new path as a move, not a copy, so ids and versions
 * survive.
 *
 * The shared folder moves only while its name is the default. An operator who
 * picked a name of their own has said where shared documents live, and
 * renaming a folder under them would be this module overruling that.
 *
 * A clash -- the new folder already exists -- moves nothing. Merging two
 * folders of someone's documents is not a decision to make on their behalf;
 * the clash is reported and checked again on every load, so the migration
 * runs by itself once the operator has merged them by hand.
 */
const MIGRATIONS = Object.freeze([
  { key: `${LEGACY_SHARED_FOLDER}->shared`, from: LEGACY_SHARED_FOLDER, to: 'shared', onlyForDefaultShared: true },
  { key: `${LEGACY_TEMPLATES_FOLDER}->${TEMPLATES_FOLDER}`, from: LEGACY_TEMPLATES_FOLDER, to: TEMPLATES_FOLDER },
])

const LEDGER = 'migrations.json'

function ledgerPath(root) {
  return path.join(root, INTERNAL_FOLDER, LEDGER)
}

function readLedger(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(root), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeLedger(root, ledger) {
  fs.mkdirSync(path.dirname(ledgerPath(root)), { recursive: true })
  fs.writeFileSync(ledgerPath(root), `${JSON.stringify(ledger, null, 2)}\n`)
}

export function migrateLegacyFolders({ root, sharedFolderName, writer, log, now = () => new Date() }) {
  const ledger = readLedger(root)
  // Migrations whose folder was already renamed by a previous, interrupted
  // call -- `ledger[key]` is not set yet (indexing never finished), but the
  // `from` folder is already gone, so the loop below must not be the only
  // thing deciding whether to reindex them.
  const pending = new Set(Array.isArray(ledger.__pendingReindex) ? ledger.__pendingReindex : [])
  const moved = []
  const blocked = []

  for (const m of MIGRATIONS) {
    if (ledger[m.key] || pending.has(m.key)) continue
    if (m.onlyForDefaultShared && sharedFolderName !== m.to) continue
    const from = path.join(root, m.from)
    const to = path.join(root, m.to)
    if (!fs.existsSync(from)) continue
    if (fs.existsSync(to)) {
      blocked.push({ from: m.from, to: m.to })
      log?.warn?.('docs folder migration blocked', { from: m.from, to: m.to })
      continue
    }
    fs.renameSync(from, to)
    moved.push(m.key)
    pending.add(m.key)
  }

  if (pending.size === 0) return { moved, blocked }

  // Persist the "renamed, index pending" marker BEFORE calling indexAll().
  // The rename(s) above have already happened on disk, so if indexAll()
  // throws (one unreadable .md is enough), this write is what survives to
  // the next load. Without it, a thrown indexAll() would leave nothing on
  // disk saying a migration is half-done, and the next load's
  // `fs.existsSync(from)` check would find the folder already moved and
  // skip the migration forever -- silently stranding the index instead of
  // retrying it, which is exactly the bug this marker exists to prevent.
  ledger.__pendingReindex = [...pending]
  writeLedger(root, ledger)

  writer.indexAll()

  // indexAll() succeeded (for both migrations renamed just now and any left
  // pending from an earlier, interrupted call): finalize every pending key
  // and clear the marker.
  for (const key of pending) ledger[key] = now().toISOString()
  delete ledger.__pendingReindex
  writeLedger(root, ledger)
  if (moved.length > 0) log?.info?.('docs folders migrated', { moved })

  return { moved, blocked }
}

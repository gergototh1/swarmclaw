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
  const moved = []
  const blocked = []
  for (const m of MIGRATIONS) {
    if (ledger[m.key]) continue
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
    ledger[m.key] = now().toISOString()
    moved.push(m.key)
  }
  if (moved.length > 0) {
    // Reindex before recording the move in the ledger. indexAll() is
    // idempotent, so if this throws (one unreadable .md is enough) the
    // ledger is left unwritten and the next load retries the reindex --
    // the alternative order would strand the index: the ledger would say
    // done, the rename already happened, and every doc under the old path
    // would fail to read until someone pressed "Reindex now".
    writer.indexAll()
    writeLedger(root, ledger)
    log?.info?.('docs folders migrated', { moved })
  }
  return { moved, blocked }
}

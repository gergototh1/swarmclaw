import fs from 'fs'
import path from 'path'

import { DATA_DIR } from './data-dir'

const LOG_FILE = path.join(DATA_DIR, 'app.log')
const MAX_SIZE = 5 * 1024 * 1024 // 5MB — rotate when exceeded

/**
 * How much of a line's `data` payload is written before it is cut.
 *
 * The cap keeps one log line from becoming megabytes; the SIZE of the cap has
 * to clear the payloads anyone actually reads back. It was 2000, which cut the
 * CLI's `init` event mid-tool-list — the very line CLAUDE.md tells you to grep
 * to prove a tool reached an agent ("Proving a Capability Reaches an Agent").
 * A tool present in the list but past character 2000 was indistinguishable
 * from a tool the agent never received, and that cost a long misdiagnosis.
 */
const MAX_DATA_CHARS = 16_000

function rotate() {
  try {
    const stat = fs.statSync(LOG_FILE)
    if (stat.size > MAX_SIZE) {
      const old = LOG_FILE + '.old'
      if (fs.existsSync(old)) fs.unlinkSync(old)
      fs.renameSync(LOG_FILE, old)
    }
  } catch {
    // file doesn't exist yet, fine
  }
}

function write(level: string, tag: string, message: string, data?: unknown) {
  const ts = new Date().toISOString()
  let line = `[${ts}] [${level}] [${tag}] ${message}`
  if (data !== undefined) {
    try {
      const s = typeof data === 'string' ? data : JSON.stringify(data, null, 0)
      // A silent cut is worse than a short line: a reader searching the payload
      // for something that is not in the first MAX_DATA_CHARS gets the same
      // empty result as if it were absent. Say what was dropped.
      line += ' | ' + (s.length > MAX_DATA_CHARS
        ? `${s.slice(0, MAX_DATA_CHARS)}… [truncated, ${s.length - MAX_DATA_CHARS} more characters]`
        : s)
    } catch {
      line += ' | [unserializable]'
    }
  }
  line += '\n'
  try {
    rotate()
    fs.appendFileSync(LOG_FILE, line)
  } catch (e) {
    console.error('[logger] write failed:', e)
  }
}

export const log = {
  info: (tag: string, msg: string, data?: unknown) => write('INFO', tag, msg, data),
  warn: (tag: string, msg: string, data?: unknown) => write('WARN', tag, msg, data),
  error: (tag: string, msg: string, data?: unknown) => write('ERROR', tag, msg, data),
  debug: (tag: string, msg: string, data?: unknown) => write('DEBUG', tag, msg, data),
}

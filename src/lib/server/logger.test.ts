import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/**
 * The payload cap is a real limit, and a reader has to be able to tell it apart
 * from absence.
 *
 * CLAUDE.md ("Proving a Capability Reaches an Agent") says to grep `app.log`
 * for a tool name in the CLI's `init` event to prove the tool reached an agent.
 * The cap was 2000 characters, which cut that event mid-tool-list and cut it
 * SILENTLY: a tool listed past the cut looked exactly like a tool the agent
 * never received. The recipe was unusable and nothing said so.
 */
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
process.env.DATA_DIR = DIR
const LOG = path.join(DIR, 'app.log')

/** Imported lazily: data-dir.ts reads DATA_DIR at import time, so the env above has to be set first. */
const logger = () => import('./logger').then((m) => m.log)

test('a payload the size of a CLI init event is written whole', async () => {
  const log = await logger()
  // ~7 kB, the shape that was being cut: the tool list of an agent with several
  // MCP servers assigned.
  const tools = Array.from({ length: 220 }, (_, i) => `mcp__Some-Server__tool_number_${i}`)
  log.info('probe', 'init', { tools })
  const text = fs.readFileSync(LOG, 'utf8')
  assert.ok(text.includes('mcp__Some-Server__tool_number_219'), 'the last tool was cut out of the line')
  assert.ok(!text.includes('[truncated'), 'a payload this size must not be truncated at all')
})

test('a payload past the cap says so instead of ending mid-value', async () => {
  const log = await logger()
  log.info('probe', 'huge', { blob: 'x'.repeat(20_000) })
  const line = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('huge')).pop() ?? ''
  assert.match(line, /… \[truncated, \d+ more characters\]$/, `no truncation marker: ${line.slice(-120)}`)
})

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }))

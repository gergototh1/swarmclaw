import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { readNoArgs, readSynthesisArgs } from './args.mjs'
import { resolvingExecFile } from './binaries.mjs'
import { sha256 } from './db.mjs'
import { TtsError, looksLikeMp3 } from './soniox.mjs'
import { SZOLGALTATO, celFajlEllenorzes, probeDurationMs, readSettings, szovegEllenorzes } from './synthesize.mjs'

/**
 * The methods this extension's own page and its MCP shim may call, over
 * `POST /api/extensions/tts.mjs/call/<method>`, and nothing else.
 *
 * The `tts.mjs` in that path is not a typo. The host keys the route on the
 * extension's *file* id (`src/app/api/extensions/[id]/call/[method]/route.ts`
 * looks the handler up by the same id the loader registered), and
 * scripts/install.mjs writes this extension as `<DATA_DIR>/extensions/tts.mjs`.
 * `/api/extensions/tts/call/...` is a 404, so this is the one spelling to copy.
 *
 * One of the two entry points over the synthesizer; the other is the
 * `narration` contract in contract.mjs. This one is the wider of the two on
 * purpose: the route is guarded by the app's access-key check, and the only
 * things on the far side of it are this extension's own bundle and the shim
 * the operator registered by hand. So it carries what those two need,
 * including the one method that writes rows from the operator's files.
 *
 * Adding a method here adds nothing to the contract, and neither does adding
 * a field to what `synthesize` or `health` return: the contract cuts its
 * answers to its own field lists. That is the whole reason the two are
 * separate objects in separate files rather than one map the contract
 * re-exports a slice of.
 *
 * `synthesize` is the one method that answers a refusal as a value instead
 * of a throw. The shim reads the HTTP body, and the route turns a throw into
 * a 500 whose body carries only `internal` and the message: the code would be
 * lost, and the shim could not tell the operator's exhausted balance from a
 * broken socket. So a `TtsError` comes back as `{ error: { code, message,
 * ... } }` with the fields the error carries, and only a fault that is not a
 * `TtsError` still throws, because that one is this extension's bug and a
 * 500 is the truth about it. The other methods are called by the page, which
 * shows a thrown message as text, so they throw.
 *
 * WHAT THIS FILE DOES TO THE STORED TEXT: NOTHING. `kerelmek` hands the rows
 * on as the repository read them, `szoveg` included, for the page to render
 * as React text children; no branch here reads a row's content, and no text
 * reaches a file name, a log or an error message. The key's value is read by
 * nothing here: `health` says whether it is set, as a boolean.
 */

const execFileAsync = promisify(execFile)

/** Rows `kerelmek` returns when the page names no limit, and the most it will return when it does. */
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 200
/** Rows one `importCache` call will look at. A larger batch is refused, not cut. */
export const MAX_IMPORT_SOROK = 1000

/**
 * A whole number of at least `min` and at most `max`, or `fallback` when the
 * caller named none. Absent, null and '' mean the default; anything else
 * present that cannot be honoured is refused by name, and that includes a
 * number above `max`: a limit of 500 answered with 200 rows would be a page
 * that cannot tell it was cut, so it is refused rather than clamped.
 */
export function readWholeNumber(what, raw, { min, max, fallback }) {
  if (raw === undefined || raw === null || raw === '') return fallback
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new Error(`${what} must be a whole number between ${min} and ${max}, not a ${Array.isArray(raw) ? 'array' : typeof raw}`)
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${what} must be a whole number between ${min} and ${max}`)
  return n
}

/** The fields a `TtsError` carries, as a plain object for the HTTP body. Never the text, the key or the endpoint: the error never held them. */
function errorBody(err) {
  const error = { code: err.code, message: err.message }
  for (const field of ['httpStatus', 'maiMasodperc', 'napiKeret', 'alap']) {
    if (err[field] !== undefined) error[field] = err[field]
  }
  return { error }
}

/** The first three bytes of a file, for the mp3 check; an unreadable file reads as empty. */
function fileHead(file) {
  const head = Buffer.alloc(3)
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const n = fs.readSync(fd, head, 0, 3, 0)
    return head.subarray(0, n)
  } catch {
    return head.subarray(0, 0)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/**
 * The runtime an MCP client has to spawn to run the shim, and what that spawn
 * needs in its environment.
 *
 * THE DEFECT THIS CLOSES. `mcpConfig` used to say `"command": "node"`, and the
 * host spawns an MCP server with its own `process.env` (see
 * `connectMcpServer` in the host's `mcp-client.ts`), so that word is resolved
 * against the *host's* `PATH`. In the packaged desktop app that is a short
 * system `PATH` -- launchd hands a GUI process `/usr/bin:/bin:/usr/sbin:/sbin`
 * and nothing else -- and no Node installation puts a binary there: Homebrew
 * uses `/opt/homebrew/bin`, the official installer `/usr/local/bin`, nvm and
 * fnm a directory under the operator's home. So the entry the page tells the
 * operator to copy spawns nothing, and every narration tool call fails on a
 * machine with Node plainly installed. It is the same defect
 * `ctx.resolveBinary` closed one level down for `ffprobe`, one level up: this
 * time it is the host's MCP client doing the spawning, not the extension.
 *
 * WHAT IT NAMES INSTEAD. `process.execPath` -- the runtime this module is
 * running in right now. It needs no lookup and no `PATH`, and it cannot name a
 * runtime that is absent, because the host is running on it. In the container
 * that is the image's `/usr/local/bin/node`; in the desktop app it is the app's
 * own Electron binary, which runs as Node when `ELECTRON_RUN_AS_NODE` is set,
 * so that variable goes in the entry exactly when the host is an Electron
 * build. That also means the shim never runs on a Node older or newer than the
 * one the host itself was tested on.
 *
 * WHAT IT DOES NOT PROMISE. An absolute path is a path, and MCP entries are
 * stored once by the operator: moving or replacing the app changes
 * `process.execPath` and the stored entry then names a runtime that is gone.
 * The page says to copy the block again after moving or updating the app,
 * because nothing here can rewrite a setting the host owns.
 *
 * The two arguments exist for the tests, which need to see both branches
 * without writing to `process`; nothing else passes them.
 */
export function shimRuntime({ execPath = process.execPath, electronVersion = process.versions.electron } = {}) {
  return {
    command: execPath,
    env: electronVersion ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  }
}

/**
 * `workspaceDir` and `portFile` arrive from index.mjs: the workspace is where
 * the shim lives, and the port file path repeats the host's own rule there
 * because extension code cannot import data-dir.ts. Both are reported by
 * `health` and `mcpConfig` so the operator can check them against what the
 * host actually wrote.
 */
export function createRpc(state, synth, { workspaceDir, portFile }) {
  const shim = path.join(workspaceDir, 'mcp', 'server.mjs')
  return {
    /** The settings and the day's counter, for the shim's `tts_status` tool. */
    async status(body) {
      readNoArgs(body)
      return synth.status()
    },
    /**
     * Everything the page's status section shows: the settings and the
     * counter, the row counts, and the two paths the shim depends on.
     */
    async health(body) {
      readNoArgs(body)
      return { ...synth.status(), counts: state.repo.counts(), portFile, shim }
    },
    /**
     * One sentence to one mp3, for the shim. Success is the synthesizer's
     * answer as it is; a refusal is `{ error }` with the code, as the header
     * says. Arguments are read by the rule in args.mjs, so a `hang` the shim
     * forwards from an agent is refused by name, not spoken over.
     */
    async synthesize(body) {
      try {
        const { szoveg, celFajl } = readSynthesisArgs(body)
        return await synth.synthesize({ szoveg, celFajl, kerte: 'mcp' })
      } catch (err) {
        if (err instanceof TtsError) return errorBody(err)
        throw err
      }
    },
    /**
     * The Settings > MCP Servers entry for the shim, for the page to show as
     * text. The access key is named by its variable and never by its value:
     * the operator copies it from the host's own `.env.local`, and nothing on
     * this side reads it.
     */
    async mcpConfig(body) {
      readNoArgs(body)
      const runtime = shimRuntime()
      return {
        id: 'tts',
        name: 'SwarmClaw narráció (tts)',
        transport: 'stdio',
        command: runtime.command,
        args: [shim],
        env: {
          ...runtime.env,
          SWARMCLAW_PORT_FILE: portFile,
          SWARMCLAW_ACCESS_KEY: 'az ACCESS_KEY értéke a host .env.local fájljából; ide kézzel',
        },
      }
    },
    /**
     * Fills the cache from mp3 files that already exist, given the sentence
     * each was made from, under the settings in force now. Rows are checked
     * one by one, and each one is either imported, skipped because a finished
     * row already holds that sentence in this voice, or refused by index with
     * a reason; nothing is dropped silently, and a bad row does not stop the
     * ones after it. The provider is never called.
     *
     * A row is admitted under the same rules a synthesis call would apply to
     * its text and its path, plus two of its own: the file has to exist as a
     * regular file, and it has to start like an mp3, because a wav stored
     * under an `.mp3` name would measure fine and then be handed to a
     * consumer as narration. The text is stored exactly as given, not
     * trimmed: the synthesizer hashes the caller's bytes as they are, so an
     * import that trimmed would fill the cache with rows no call can hit.
     */
    async importCache(body = {}) {
      if (!Array.isArray(body.sorok)) throw new Error('sorok must be an array of { szoveg, fajl }')
      if (body.sorok.length > MAX_IMPORT_SOROK) throw new Error(`sorok must hold at most ${MAX_IMPORT_SOROK} rows, got ${body.sorok.length}`)
      const cfg = readSettings(state)
      const refused = []
      let imported = 0
      let skipped = 0
      for (let i = 0; i < body.sorok.length; i += 1) {
        const sor = body.sorok[i]
        if (!sor || typeof sor !== 'object' || Array.isArray(sor)) { refused.push({ index: i, ok: 'sor_ervenytelen' }); continue }
        const szovegHiba = szovegEllenorzes(sor.szoveg)
        if (szovegHiba) { refused.push({ index: i, ok: 'szoveg_ervenytelen', uzenet: szovegHiba }); continue }
        const fajlHiba = celFajlEllenorzes(sor.fajl)
        if (fajlHiba) { refused.push({ index: i, ok: 'fajl_ervenytelen', uzenet: fajlHiba }); continue }
        const { szoveg, fajl } = sor
        let stat
        try { stat = fs.statSync(fajl) } catch { stat = null }
        if (!stat || !stat.isFile()) { refused.push({ index: i, ok: 'fajl_hianyzik' }); continue }
        if (!looksLikeMp3(fileHead(fajl))) { refused.push({ index: i, ok: 'fajl_nem_mp3' }); continue }
        const key = { szolgaltato: SZOLGALTATO, modell: cfg.modell, hang: cfg.hang, nyelv: cfg.nyelv, szovegHash: sha256(szoveg) }
        if (state.repo.cacheHit(key)) { skipped += 1; continue }
        let hosszMs
        try {
          hosszMs = await probeDurationMs(fajl, resolvingExecFile(state, state.execFileImpl || execFileAsync))
        } catch (err) {
          refused.push({ index: i, ok: 'hossz_meres_sikertelen', uzenet: err instanceof Error ? err.message : String(err) })
          continue
        }
        state.repo.insertKerelem({
          szolgaltato: SZOLGALTATO, modell: cfg.modell, hang: cfg.hang, nyelv: cfg.nyelv,
          szoveg, fajl, hosszMs, bajt: stat.size, status: 'kesz', hibaKod: '', kerte: 'import',
        })
        imported += 1
      }
      return { imported, skipped, refused }
    },
    /**
     * The newest `limit` request rows, `szoveg` included, for the page's
     * list. `limit` absent is DEFAULT_LIMIT; present and outside 1..MAX_LIMIT
     * is refused by name. The total behind the list is `health().counts`.
     */
    async kerelmek(body = {}) {
      return state.repo.kerelmek(readWholeNumber('limit', body.limit, { min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT }))
    },
  }
}

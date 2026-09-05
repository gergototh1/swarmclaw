#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import readline from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * The tts extension's MCP server: a stdio JSON-RPC shim that forwards two
 * tools, `tts_synthesize` and `tts_status`, to this extension's rpc on the
 * host (`POST /api/extensions/tts.mjs/call/<method>`, src/rpc.mjs). It never
 * calls the provider itself: the key, the cache and the daily counter live in
 * the host process, and a second process that synthesised on its own would
 * step around all three.
 *
 * It runs from the extension's workspace copy, spawned by the host's own MCP
 * client with plain `node` and no `node_modules` in reach, so it has no
 * dependency and imports nothing from the host. Everything it needs from the
 * host it re-implements here or reads over HTTP, and the port-file contract
 * it re-implements is the one in src/lib/server/runtime/port-file.ts. A
 * check that file names and this file leaves out is a check nobody makes.
 *
 * FINDING THE HOST. The host's port differs between launches (the desktop
 * app takes whatever is free at start), so the host writes `run/port.json`
 * at boot and this shim reads it from `SWARMCLAW_PORT_FILE`. There is no
 * fallback port: a shim that guessed 3456 would, on a machine where another
 * program owns 3456, hand an agent's requests to that program. Before a
 * request is sent, the file has to pass all three checks of the contract:
 *
 *   1. Shape: the JSON object `{ port, wsPort, pid, startedAt }` with both
 *      ports in 1..65535 and a positive integer pid (`readPortFile`).
 *   2. Boot time, then pid: a `startedAt` before this boot is stale even
 *      when its pid is alive, because a reboot restarts pid numbering and an
 *      old pid can name an unrelated process today; then `process.kill(pid,
 *      0)`, where EPERM still means alive (`isPortFileLive`).
 *   3. Identity: `GET /api/healthz` on the port has to answer JSON whose
 *      `service` is `"swarmclaw"`. Within one boot a pid can be reused after
 *      the server dies, so 1 and 2 only make 3 rare; they do not replace it.
 *      A refused connection is retried for a moment first, because the
 *      contract allows a fresh file to land a tick before the listener is
 *      ready (`confirmSwarmclaw`).
 *
 * A file that fails any check is reported as `swarmclaw_nem_fut` with a
 * `reason` naming which check failed and what was seen, so the operator can
 * tell a missing file from a stale one from a port another program owns.
 * The checks run on every tool call rather than once at start: a host that
 * restarted between two calls has a new port, and a shim that cached the old
 * one would send the second call to whatever now owns it.
 *
 * TWO SWARMCLAW INSTANCES ON ONE MACHINE. `service: "swarmclaw"` says the
 * port belongs to some SwarmClaw server, not which one. The shim does not
 * try to tell them apart: it talks to the server whose port file the
 * operator named in `SWARMCLAW_PORT_FILE`, and each instance keeps its own
 * file under its own home, so the file path is what picks the instance. The
 * one case this cannot cover is two instances sharing one home, which the
 * host does not support either; there the file names whichever wrote it
 * last, and this shim follows it.
 *
 * WHAT THIS FILE DOES WITH AN AGENT'S TEXT. `szoveg` and `celFajl` arrive
 * from an agent and are untrusted. They go into the JSON body of one HTTP
 * request and nowhere else: not into a file name, not into a log line, not
 * into an error message, not into a shell. There is no shell here at all;
 * the shim spawns nothing. A tool name that is not an identifier is not
 * repeated in the refusal either.
 *
 * REPORTING. Every failure is a value the agent can read, never a thrown
 * exception that the client would flatten to one line. The codes are the
 * shim's own: `port_fajl_beallitatlan` (no file named), `swarmclaw_nem_fut`
 * (a check above failed, or the host went away), `kulcs_beallitatlan` (the
 * host wants a key and none is set), `kulcs_ervenytelen` (the key set is not
 * the host's), `tts_extension_hianyzik` (the host has no such rpc: the
 * extension is not installed, is disabled, or is an older version), and
 * `host_hiba` (the host answered, but with a failure or with something this
 * shim could not read). A refusal the extension itself answers, such as an
 * exhausted daily budget, is passed through as the host wrote it, so its
 * code is the extension's code, not one of these.
 */

const PROTOCOL_VERSION = '2024-11-05'
const EXTENSION_ID = 'tts.mjs'
const SERVER_INFO = { name: 'swarmclaw-tts', version: '0.1.0' }

/**
 * Mirrors BOOT_TOLERANCE_MS in port-file.ts: how far before the estimated
 * boot instant `startedAt` may fall and still count as this boot, absorbing
 * a wall-clock correction after boot.
 */
const BOOT_TOLERANCE_MS = 60_000
/** How long one `/api/healthz` may take, how many times a refused connection is tried, and the gap between tries. */
const HEALTHZ_TIMEOUT_MS = 3_000
const HEALTHZ_ATTEMPTS = 3
const HEALTHZ_RETRY_MS = 250
/** How long the host may take to answer `status`, and to finish one synthesis: a provider round-trip plus a duration probe. */
const STATUS_TIMEOUT_MS = 10_000
const SYNTHESIZE_TIMEOUT_MS = 120_000
/** The same identifier rule src/args.mjs applies before repeating a caller's key in a message. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * What the shim offers. `additionalProperties: false` is a description of
 * the host's rule, not a filter here: the arguments are forwarded as given,
 * and the host refuses an unknown key by name (src/args.mjs). Stripping
 * `hang` here and speaking in the configured voice would be the quiet
 * coercion that rule exists to prevent.
 */
const TOOLS = [
  {
    name: 'tts_synthesize',
    description: 'Egy mondatból mp3-at készít a SwarmClaw tts extensionjén át: a Soniox-kulcs, a cache és a napi keret a hostban van. celFajl: abszolút, .mp3 végű útvonal, ahova a fájl kerül. Más argumentumot (pl. hang) a host név szerint elutasít.',
    inputSchema: {
      type: 'object',
      required: ['szoveg', 'celFajl'],
      properties: {
        szoveg: { type: 'string', description: 'A felolvasandó szöveg.' },
        celFajl: { type: 'string', description: 'Abszolút, .mp3 végű útvonal; a host oda írja a fájlt.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tts_status',
    description: 'A tts extension állapota: kulcs és végpont beállítva-e, mai másodpercek, napi keret, hang, modell, nyelv. Argumentumot nem vesz át.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

// --- port file: the three checks of the contract ---

function isWholeNumber(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPort(value) {
  return isWholeNumber(value) && value >= 1 && value <= 65535
}

/**
 * Check 1. The file's content, or a `reason` when it is missing, unreadable,
 * not JSON, or not the shape the contract names. Extra keys are dropped, not
 * rejected, so a later host can add fields without breaking this reader.
 * `hianyzik` and `ervenytelen` are told apart because they call for
 * different action: one means the host is not running or writes elsewhere,
 * the other means something else wrote this file.
 */
function readPortFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { reason: 'port_fajl_hianyzik' }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { reason: 'port_fajl_ervenytelen' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { reason: 'port_fajl_ervenytelen' }
  const { port, wsPort, pid, startedAt } = parsed
  if (!isPort(port) || !isPort(wsPort)) return { reason: 'port_fajl_ervenytelen' }
  if (!isWholeNumber(pid) || pid < 1) return { reason: 'port_fajl_ervenytelen' }
  if (!isWholeNumber(startedAt)) return { reason: 'port_fajl_ervenytelen' }
  return { info: { port, wsPort, pid, startedAt } }
}

/**
 * Check 2. `null` when the file is not provably stale; a `reason` when it
 * is. Boot time first: a `startedAt` before this boot (less the tolerance)
 * is stale no matter what the pid says. Then the pid: signal 0 delivers
 * nothing and only asks whether the process exists; EPERM means it exists
 * under another user, which still counts as alive.
 *
 * Passing here means "some process has this pid and it started after this
 * boot", not "that process is SwarmClaw". A container that restarts keeps
 * the host's uptime while its pids start over, and within one boot a pid is
 * reused after the server dies; check 3 is what covers both.
 */
function staleReason(info) {
  const bootAt = Date.now() - os.uptime() * 1000
  if (info.startedAt < bootAt - BOOT_TOLERANCE_MS) return 'port_fajl_regi'
  try {
    process.kill(info.pid, 0)
    return null
  } catch (err) {
    return err && err.code === 'EPERM' ? null : 'pid_nem_el'
  }
}

/**
 * True for the failure `fetch` raises when nothing accepts the connection
 * (the port is closed, or the listener is not up yet) or the peer dropped
 * it. Node wraps the socket error as `cause`, and as an AggregateError of
 * causes when it tried more than one address.
 */
function isConnectionRefused(err) {
  const cause = err && err.cause
  if (!cause) return false
  const causes = Array.isArray(cause.errors) ? cause.errors : [cause]
  return causes.some((c) => c && (c.code === 'ECONNREFUSED' || c.code === 'ECONNRESET'))
}

/**
 * Check 3. `null` when the server on `port` says it is SwarmClaw; a
 * `reason` otherwise. Only `service` is read from the body, and the body is
 * never quoted: it came from whatever owns the port, which at this point may
 * be anything.
 *
 * A refused connection is tried HEALTHZ_ATTEMPTS times, HEALTHZ_RETRY_MS
 * apart, because the contract lets a fresh file land a tick before the
 * listener is ready; one that stays refused is a dead server's file. A
 * server that accepts the connection and then answers nothing within
 * HEALTHZ_TIMEOUT_MS is reported as exactly that: something listens there,
 * and the shim could not learn what.
 */
async function confirmSwarmclaw(base) {
  for (let attempt = 1; ; attempt += 1) {
    let res
    try {
      res = await fetch(`${base}/api/healthz`, { signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS) })
    } catch (err) {
      if (isConnectionRefused(err)) {
        if (attempt < HEALTHZ_ATTEMPTS) {
          await sleep(HEALTHZ_RETRY_MS)
          continue
        }
        return 'kapcsolat_elutasitva'
      }
      if (err && err.name === 'TimeoutError') return 'healthz_nem_valaszolt'
      return 'healthz_nem_erheto_el'
    }
    let json
    try {
      json = await res.json()
    } catch {
      return 'masik_program_a_porton'
    }
    if (!json || typeof json !== 'object' || json.service !== 'swarmclaw') return 'masik_program_a_porton'
    return null
  }
}

/** What each `swarmclaw_nem_fut` reason means, for the person reading the agent's answer. Paths and numbers only; never text from the file or the port. */
function notRunningMessage(reason, file, info) {
  const at = info ? `port ${info.port}, pid ${info.pid}` : ''
  switch (reason) {
    case 'port_fajl_hianyzik': return `nincs port-fájl: ${file}; a SwarmClaw nem fut, vagy máshova írja`
    case 'port_fajl_ervenytelen': return `a port-fájl nem a host alakja: ${file}; nem a SwarmClaw írta`
    case 'port_fajl_regi': return `a port-fájl a mostani rendszerindítás előttről való (${at}); a pid ma bármi lehet`
    case 'pid_nem_el': return `a port-fájl pidje nem él (${at})`
    case 'kapcsolat_elutasitva': return `a port-fájl portján semmi nem fogad kapcsolatot (${at})`
    case 'healthz_nem_valaszolt': return `valami hallgat a port-fájl portján, de ${HEALTHZ_TIMEOUT_MS} ms alatt nem felelt a /api/healthz-re (${at}); nem tudni, SwarmClaw-e`
    case 'healthz_nem_erheto_el': return `a /api/healthz nem érhető el a port-fájl portján (${at})`
    case 'masik_program_a_porton': return `a port-fájl portján nem SwarmClaw felel a /api/healthz-re (${at}); a fájl elavult`
    case 'kapcsolat_megszakadt': return `a host a /api/healthz után, a kérés közben ment el (${at})`
    default: return `a SwarmClaw nem érhető el (${at})`
  }
}

function notRunning(reason, file, info) {
  return { error: { code: 'swarmclaw_nem_fut', reason, message: notRunningMessage(reason, file, info) } }
}

/**
 * The base URL of a server that passed all three checks, or the refusal
 * that names the check it failed. Read fresh on every call; see the header.
 */
async function resolveHost() {
  const file = (process.env.SWARMCLAW_PORT_FILE || '').trim()
  if (file === '') {
    return { error: { code: 'port_fajl_beallitatlan', message: 'SWARMCLAW_PORT_FILE nincs beállítva az MCP-bejegyzés env-jében; a pontos értéket a /x/tts lap mutatja' } }
  }
  const read = readPortFile(file)
  if (read.reason) return notRunning(read.reason, file, null)
  const { info } = read
  const stale = staleReason(info)
  if (stale) return notRunning(stale, file, info)
  const base = `http://127.0.0.1:${info.port}`
  const identity = await confirmSwarmclaw(base)
  if (identity) return notRunning(identity, file, info)
  return { base, file, info }
}

// --- the rpc call ---

/** The host's failure body is `{ error: { code, message }, message }`; the message is read when it is a string, and that is all that is read. */
function hostMessage(json, status) {
  if (json && typeof json === 'object' && json.error && typeof json.error.message === 'string') return json.error.message
  return `HTTP ${status}`
}

/**
 * One rpc method on the host, answered as the value the tool returns. The
 * access key is sent only when set: a host started without ACCESS_KEY
 * accepts every request, and refusing to try would be a refusal the host
 * itself would not make. A 401 is then read against whether a key was sent,
 * which tells "none set" from "the wrong one". 403 is not a key failure on
 * this host (its proxy answers 403 to a disallowed browser Origin), so it
 * is `host_hiba` with its status, not `kulcs_ervenytelen`.
 *
 * `body` is the agent's argument object, forwarded whole; see TOOLS.
 */
async function callHost(method, body, timeoutMs) {
  const target = await resolveHost()
  if (target.error) return target
  const key = (process.env.SWARMCLAW_ACCESS_KEY || '').trim()
  const headers = { 'content-type': 'application/json' }
  if (key !== '') headers['x-access-key'] = key
  let res
  try {
    res = await fetch(`${target.base}/api/extensions/${EXTENSION_ID}/call/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (isConnectionRefused(err)) return notRunning('kapcsolat_megszakadt', target.file, target.info)
    if (err && err.name === 'TimeoutError') {
      return { error: { code: 'host_hiba', reason: 'idotullepes', message: `a host ${timeoutMs} ms alatt nem felelt a(z) ${method} hívásra; a kérés a hostban még futhat` } }
    }
    return { error: { code: 'host_hiba', reason: 'kapcsolat_hiba', message: `a kérés nem jutott el a hosthoz (${err && err.name ? err.name : 'hiba'})` } }
  }
  let text
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  let json = null
  let parsable = text.trim() !== ''
  if (parsable) {
    try {
      json = JSON.parse(text)
    } catch {
      parsable = false
    }
  }
  if (res.status === 401) {
    if (key === '') return { error: { code: 'kulcs_beallitatlan', message: 'a host hozzáférési kulcsot kér, és SWARMCLAW_ACCESS_KEY üres az MCP-bejegyzés env-jében' } }
    return { error: { code: 'kulcs_ervenytelen', message: 'a host 401-et adott: SWARMCLAW_ACCESS_KEY nem a host ACCESS_KEY értéke' } }
  }
  if (res.status === 404) {
    return { error: { code: 'tts_extension_hianyzik', message: `a hoston nincs ${EXTENSION_ID}/${method} rpc: az extension nincs telepítve, le van tiltva, vagy régebbi kiadás (${hostMessage(json, 404)})` } }
  }
  if (res.status === 429) {
    const retryAfter = json && typeof json === 'object' && isWholeNumber(json.retryAfter) ? json.retryAfter : undefined
    const error = { code: 'host_hiba', reason: 'zarolas', message: 'a host túl sok rossz kulcs után ideiglenesen zárolta ezt a címet' }
    if (retryAfter !== undefined) error.retryAfter = retryAfter
    return { error }
  }
  if (!res.ok) {
    return { error: { code: 'host_hiba', reason: `http_${res.status}`, httpStatus: res.status, message: hostMessage(json, res.status) } }
  }
  if (!parsable) {
    return { error: { code: 'host_hiba', reason: 'valasz_nem_json', message: `a host 200-at adott, de a válasz ${text.trim() === '' ? 'üres' : 'nem JSON'}` } }
  }
  return json
}

// --- JSON-RPC over stdio ---

function reply(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function failure(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** A tool's answer: the host's value as text, `isError` when it carries an `error`. A host that answers `null` is a value too, and not an error. */
function toolResult(value) {
  const isError = Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.error)
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function callTool(id, params) {
  const name = isPlainObject(params) ? params.name : undefined
  const args = isPlainObject(params) && params.arguments !== undefined ? params.arguments : {}
  if (typeof name !== 'string') return failure(id, -32602, 'params.name must be a string')
  if (!isPlainObject(args)) return failure(id, -32602, 'params.arguments must be an object')
  if (name === 'tts_synthesize') return reply(id, toolResult(await callHost('synthesize', args, SYNTHESIZE_TIMEOUT_MS)))
  if (name === 'tts_status') return reply(id, toolResult(await callHost('status', args, STATUS_TIMEOUT_MS)))
  return failure(id, -32602, `ismeretlen tool: ${IDENTIFIER.test(name) ? name : '(nem azonosító nevű tool)'}`)
}

/**
 * One message in, one reply out, or `null` for a notification. The
 * protocol version answered is this shim's, whatever the client offered:
 * the SDK client the host uses accepts 2024-11-05 as one of its supported
 * versions and settles on it. `notifications/initialized` and every other
 * notification are taken without reply, as the protocol says.
 */
async function handle(msg) {
  if (!isPlainObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return failure(isPlainObject(msg) && (typeof msg.id === 'number' || typeof msg.id === 'string') ? msg.id : null, -32600, 'invalid request')
  }
  const { id, method, params } = msg
  // A notification carries no id and gets no reply, whatever its method; the
  // only one a client sends here is `notifications/initialized`.
  if (id === undefined) return null
  if (method === 'initialize') {
    return reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') return callTool(id, params)
  return failure(id, -32601, `ismeretlen metódus: ${IDENTIFIER.test(method.replaceAll('/', '_')) ? method : '(nem azonosító nevű metódus)'}`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  if (line.trim() === '') return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send(failure(null, -32700, 'parse error'))
    return
  }
  const id = isPlainObject(msg) && (typeof msg.id === 'number' || typeof msg.id === 'string') ? msg.id : null
  handle(msg).then((answer) => {
    if (answer) send(answer)
  }, (err) => {
    // A throw here is this shim's own bug. It is answered rather than
    // allowed to end the process, so the client sees a failure on this
    // request instead of a server that went away. Only the error's name is
    // repeated: its message may carry text this file did not write.
    send(failure(id, -32603, `belső hiba a shimben (${err && err.name ? err.name : 'hiba'})`))
  })
})
lines.on('close', () => process.exit(0))

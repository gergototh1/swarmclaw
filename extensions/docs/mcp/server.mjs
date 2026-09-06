#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import readline from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * A stdio JSON-RPC shim that puts a SwarmClaw extension's tools in front of an
 * agent whose provider runs its own tool loop.
 *
 * WHY. Every agent in this install is on `claude-cli`, and a CLI provider never
 * receives the extension tool layer -- it cannot see the LangChain array the
 * host assembles, and the platform's own docs say so (`/docs/providers`: CLI
 * providers "manage their own runtime/tool loop"). MCP is the one capability
 * layer that crosses that line, because the CLI speaks the protocol itself. So
 * this file exists to make one extension look like an MCP server.
 *
 * WHAT IT IS NOT. It never runs a tool itself. Every call is forwarded to the
 * extension's own rpc on the host (`POST /api/extensions/<id>/call/mcpCall`),
 * because the database, the settings and every counter live in the host process
 * and a second process doing the work would step around all three.
 *
 * IT IS GENERIC ON PURPOSE. Nothing here names a tool. `tools/list` asks the
 * host what the extension offers, so the tool definitions stay in the
 * extension's own `tools` array and this file needs no edit when one is added.
 * The only thing that makes this copy specific to one extension is
 * EXTENSION_ID below. That is what lets the same file serve `aisignal`, `docs`
 * and `video`; the copies are asserted byte-identical apart from that constant
 * by the test beside this directory.
 *
 * It runs from the extension's workspace copy, spawned by the CLI with plain
 * `node` and no `node_modules` in reach, so it has no dependency and imports
 * nothing from the host. Everything it needs from the host it re-implements
 * here or reads over HTTP, and the port-file contract it re-implements is the
 * one in src/lib/server/runtime/port-file.ts. A check that file names and this
 * file leaves out is a check nobody makes.
 *
 * FINDING THE HOST. The host's port differs between launches (the desktop app
 * takes whatever is free at start), so the host writes `run/port.json` at boot
 * and this shim reads it from `SWARMCLAW_PORT_FILE`. There is no fallback port:
 * a shim that guessed 3456 would, on a machine where another program owns 3456,
 * hand an agent's requests to that program. Before a request is sent, the file
 * has to pass all four checks of the contract:
 *
 *   1. Shape: the JSON object `{ port, wsPort, pid, startedAt, instanceId }`
 *      with both ports in 1..65535, a positive integer pid and a non-empty
 *      instance token (`readPortFile`).
 *   2. Boot time, then pid: a `startedAt` before this boot is stale even when
 *      its pid is alive, because a reboot restarts pid numbering and an old pid
 *      can name an unrelated process today; then `process.kill(pid, 0)`, where
 *      EPERM still means alive (`staleReason`).
 *   3. Service: `GET /api/healthz` on the port has to answer JSON whose
 *      `service` is `"swarmclaw"`. Within one boot a pid can be reused after
 *      the server dies, so 1 and 2 only make 3 rare; they do not replace it.
 *   4. Instance: that answer's `instanceId` has to be the token from the file,
 *      or a second SwarmClaw on that port would serve the request with a
 *      different database.
 *
 * The file is read fresh on every call rather than cached: the host can restart
 * on another port while this process lives, and a cached base would then be
 * pointing at whatever took the old one.
 *
 * WHO IS ASKING. `SWARMCLAW_AGENT_ID`, `SWARMCLAW_AGENT_NAME` and
 * `SWARMCLAW_SESSION_ID` are stamped into this process's env by the host when
 * it writes the per-turn MCP config (`addAssignedMcpServers` in
 * src/lib/providers/claude-cli.ts). They are forwarded on every call and are
 * how a gate like the video extension's reviewer check survives the trip
 * through MCP: the protocol carries no caller identity, and without them one
 * MCP server could not tell two agents apart. The agent never sees these values
 * and cannot name itself. Do not accept them as tool arguments -- that is the
 * self-named caller the whole arrangement exists to rule out.
 */

const PROTOCOL_VERSION = '2024-11-05'
const EXTENSION_ID = 'docs.mjs'
const SERVER_INFO = { name: 'swarmclaw-docs', version: '0.1.0' }

/** A `startedAt` this far before boot is still accepted; clocks and uptime disagree by a little. */
const BOOT_TOLERANCE_MS = 60_000

const HEALTHZ_TIMEOUT_MS = 3_000
const HEALTHZ_ATTEMPTS = 3
const HEALTHZ_RETRY_MS = 250

/** Listing tools is a database read; running one can research, sweep or render. */
const LIST_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 600_000

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

// --- port file: the four checks of the contract ---

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
  const { port, wsPort, pid, startedAt, instanceId } = parsed
  if (!isPort(port) || !isPort(wsPort)) return { reason: 'port_fajl_ervenytelen' }
  if (!isWholeNumber(pid) || pid < 1) return { reason: 'port_fajl_ervenytelen' }
  if (!isWholeNumber(startedAt)) return { reason: 'port_fajl_ervenytelen' }
  // Without the token there is nothing to compare the server on the port
  // against, and accepting the file anyway would be the pid check standing in
  // for an identity check.
  if (typeof instanceId !== 'string' || instanceId === '') return { reason: 'port_fajl_ervenytelen' }
  return { info: { port, wsPort, pid, startedAt, instanceId } }
}

/**
 * Check 2. `null` when the file is not provably stale; a `reason` when it is.
 * Boot time first: a `startedAt` before this boot (less the tolerance) is stale
 * no matter what the pid says. Then the pid: signal 0 delivers nothing and only
 * asks whether the process exists; EPERM means it exists under another user,
 * which still counts as alive.
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
 * True for the failure `fetch` raises when nothing accepts the connection or
 * the peer dropped it. Node wraps the socket error as `cause`, and as an
 * AggregateError of causes when it tried more than one address.
 */
function isConnectionRefused(err) {
  const cause = err && err.cause
  if (!cause) return false
  const causes = Array.isArray(cause.errors) ? cause.errors : [cause]
  return causes.some((c) => c && (c.code === 'ECONNREFUSED' || c.code === 'ECONNRESET'))
}

/**
 * Checks 3 and 4. `null` when the server on `port` says it is SwarmClaw AND
 * names the instance that wrote the port file. Only `service` and `instanceId`
 * are read from the body, the token is compared and never repeated, and no part
 * of the body is quoted: it came from whatever owns the port, which at this
 * point may be anything.
 */
async function confirmSwarmclaw(base, instanceId) {
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
    if (typeof json.instanceId !== 'string' || json.instanceId === '' || json.instanceId !== instanceId) return 'masik_peldany_a_porton'
    return null
  }
}

/** What each `swarmclaw_nem_fut` reason means. Paths and numbers only; never text from the file or the port. */
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
    case 'masik_peldany_a_porton': return `a port-fájl portján egy MÁSIK SwarmClaw-példány felel (${at}); a fájl elavult, és ez a példány más adatbázissal dolgozna`
    case 'kapcsolat_megszakadt': return `a host a /api/healthz után, a kérés közben ment el (${at})`
    default: return `a SwarmClaw nem érhető el (${at})`
  }
}

function notRunning(reason, file, info) {
  return { error: { code: 'swarmclaw_nem_fut', reason, message: notRunningMessage(reason, file, info) } }
}

/** The base URL of a server that passed all four checks, or the refusal naming the check it failed. Read fresh on every call. */
async function resolveHost() {
  const file = (process.env.SWARMCLAW_PORT_FILE || '').trim()
  if (file === '') {
    return { error: { code: 'port_fajl_beallitatlan', message: 'SWARMCLAW_PORT_FILE nincs beállítva az MCP-bejegyzés env-jében' } }
  }
  const read = readPortFile(file)
  if (read.reason) return notRunning(read.reason, file, null)
  const { info } = read
  const stale = staleReason(info)
  if (stale) return notRunning(stale, file, info)
  const base = `http://127.0.0.1:${info.port}`
  const identity = await confirmSwarmclaw(base, info.instanceId)
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
 * One rpc method on the host, answered as the value it returns.
 *
 * The access key is sent only when set: a host started without ACCESS_KEY
 * accepts every request, and refusing to try would be a refusal the host itself
 * would not make. A 401 is then read against whether a key was sent, which
 * tells "none set" from "the wrong one". 403 is not a key failure on this host
 * (its proxy answers 403 to a disallowed browser Origin), so it is `host_hiba`
 * with its status.
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
    return { error: { code: 'extension_hianyzik', message: `a hoston nincs ${EXTENSION_ID}/${method} rpc: az extension nincs telepítve, le van tiltva, vagy régebbi kiadás (${hostMessage(json, 404)})` } }
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

/** The caller the host stamped into this process. Never taken from a tool's arguments. */
function callerStamp() {
  const pick = (name) => {
    const value = (process.env[name] || '').trim()
    return value === '' ? undefined : value
  }
  return { agentId: pick('SWARMCLAW_AGENT_ID'), agentName: pick('SWARMCLAW_AGENT_NAME'), sessionId: pick('SWARMCLAW_SESSION_ID') }
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

/**
 * The extension's tools, asked of the host.
 *
 * A client calls `tools/list` right after `initialize`, so a host that is down
 * shows up here first. An empty list is returned in that case rather than a
 * protocol error: an MCP client that fails `tools/list` usually drops the
 * server for the whole session, and the host being briefly down would then cost
 * the agent its tools until the next turn. The reason is written to stderr,
 * which the CLI surfaces in its logs.
 */
async function listTools() {
  const answer = await callHost('mcpTools', {}, LIST_TIMEOUT_MS)
  if (!isPlainObject(answer) || !Array.isArray(answer.tools)) {
    const why = isPlainObject(answer) && answer.error ? answer.error.message : 'a host nem tool-listát adott'
    process.stderr.write(`[${SERVER_INFO.name}] tools/list: ${why}\n`)
    return []
  }
  return answer.tools.filter((t) => isPlainObject(t) && typeof t.name === 'string')
}

async function callTool(id, params) {
  const name = isPlainObject(params) ? params.name : undefined
  const args = isPlainObject(params) && params.arguments !== undefined ? params.arguments : {}
  if (typeof name !== 'string') return failure(id, -32602, 'params.name must be a string')
  if (!isPlainObject(args)) return failure(id, -32602, 'params.arguments must be an object')
  if (!IDENTIFIER.test(name)) return failure(id, -32602, 'ismeretlen tool: (nem azonosító nevű tool)')
  const value = await callHost('mcpCall', { tool: name, args, ...callerStamp() }, CALL_TIMEOUT_MS)
  return reply(id, toolResult(value))
}

/**
 * One message in, one reply out, or `null` for a notification. The protocol
 * version answered is this shim's, whatever the client offered.
 */
async function handle(msg) {
  if (!isPlainObject(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return failure(isPlainObject(msg) && (typeof msg.id === 'number' || typeof msg.id === 'string') ? msg.id : null, -32600, 'invalid request')
  }
  const { id, method, params } = msg
  // A notification carries no id and gets no reply, whatever its method.
  if (id === undefined || id === null) return null
  if (method === 'initialize') {
    return reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO })
  }
  if (method === 'tools/list') return reply(id, { tools: await listTools() })
  if (method === 'tools/call') return callTool(id, params)
  return failure(id, -32601, `method not found: ${method}`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (line.trim() === '') continue
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send(failure(null, -32700, 'parse error'))
    continue
  }
  const answer = await handle(msg)
  if (answer) send(answer)
}

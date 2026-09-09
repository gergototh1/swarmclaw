import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import type { SSEEvent } from '@/types'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { getEnabledToolIds } from '@/lib/capability-selection'
import { resolveCliBinary, buildCliEnv, probeCliAuth, attachAbortHandler, isStderrNoise } from './cli-utils'
import { getAgent } from '@/lib/server/agents/agent-repository'
import { loadMcpServers } from '@/lib/server/storage'
import { buildAttachmentPreamble } from '@/lib/server/attachments/attachment-text'
import { buildCliMemoryPreamble } from '@/lib/server/memory/cli-memory-preamble'
import { patchSession } from '@/lib/server/sessions/session-repository'

const TAG = 'provider-claude-cli'

/** One entry of the `mcpServers` map the Claude CLI reads from `--mcp-config`. */
type McpServerEntry = Record<string, unknown>

/**
 * Who the host says is calling. Stamped into every stdio server's env below.
 *
 * An MCP server cannot tell its callers apart — the protocol carries no caller
 * identity — so a tool that gates on "which agent is asking" loses that gate
 * the moment it moves behind MCP. A SwarmClaw extension exposed as a stdio shim
 * gets the answer here instead: this file writes a FRESH config for every turn,
 * and at that moment the host already knows whose turn it is, so the identity
 * is bound when the process is spawned rather than asserted by the agent.
 *
 * That distinction is the point. The agent never sees these values and cannot
 * name itself; the operator never types them and cannot mis-set them. The video
 * extension's reviewer gate (`videoVerdict` refuses a plan's own author) keeps
 * working through a shim only because of this, and the docs extension's
 * per-agent folder is named correctly for the same reason. Without it each
 * agent would need its own duplicate MCP registration carrying its own id, and
 * a wrong assignment would silently pass a self-review or write to the wrong
 * folder.
 *
 * These are advisory identity, not authorisation: the shim reaches the host
 * over the same access-key-authenticated rpc route either way, and a shim is
 * trusted local code. Do not build a permission model on them.
 */
export interface McpCallerStamp {
  agentId?: string | null
  /**
   * The agent's display name. Carried alongside the id because an id alone is
   * not enough for every consumer: the docs extension names each agent's folder
   * after it, and falls back to the head of the id, so an operator opening the
   * vault in Finder would see `agents/c3377d/` where `agents/gtassistant/` was
   * the entire point.
   */
  agentName?: string | null
  sessionId?: string | null
}

/**
 * Translate the MCP servers an operator assigned to an agent into the Claude
 * CLI's `mcpServers` map, adding them to whatever `existing` already holds.
 *
 * Pure on purpose: this is the half of the injection worth testing, and testing
 * it through `streamClaudeCliChat` would mean spawning a real CLI.
 *
 * `existing` is mutated and returned. A server whose id is unknown, or whose
 * transport carries neither a command nor a url, is skipped rather than written
 * as a half-entry the CLI would fail to start. A name that would collide with
 * one already in the map — `playwright`, or a second server the operator named
 * the same — is suffixed with the head of its id instead of overwriting, so two
 * assigned servers cannot silently become one.
 *
 * The stamp reaches stdio servers only. A url transport is a server someone
 * else runs, reached over a shared connection: an identity claim in a header
 * there would travel off this machine and would not be this turn's anyway.
 */
export function addAssignedMcpServers(
  existing: Record<string, McpServerEntry>,
  serverIds: string[],
  allMcpServers: Record<string, Record<string, unknown>>,
  stamp: McpCallerStamp = {},
): Record<string, McpServerEntry> {
  // An empty id is left out rather than written as '': the extensions read
  // these with `??`, so a present-but-blank value defeats their own fallback.
  const stamped: Record<string, string> = {}
  if (typeof stamp.agentId === 'string' && stamp.agentId !== '') stamped.SWARMCLAW_AGENT_ID = stamp.agentId
  if (typeof stamp.agentName === 'string' && stamp.agentName !== '') stamped.SWARMCLAW_AGENT_NAME = stamp.agentName
  if (typeof stamp.sessionId === 'string' && stamp.sessionId !== '') stamped.SWARMCLAW_SESSION_ID = stamp.sessionId

  for (const serverId of serverIds) {
    const config = allMcpServers[serverId]
    if (!config) continue
    const rawName = typeof config.name === 'string' ? config.name : serverId
    let name = rawName.replace(/[^a-zA-Z0-9_-]/g, '-')
    if (existing[name]) name = `${name}-${serverId.slice(0, 8)}`
    const env = config.env as Record<string, string> | undefined
    const headers = config.headers as Record<string, string> | undefined
    if (config.transport === 'stdio' && config.command) {
      // The stamp goes last so an operator cannot pin a different agent's id
      // into the server's own env and have it win — that would be exactly the
      // self-named caller this mechanism exists to rule out.
      const mergedEnv = { ...(env || {}), ...stamped }
      existing[name] = {
        command: config.command,
        args: (config.args as string[] | undefined) || [],
        ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
      }
    } else if ((config.transport === 'sse' || config.transport === 'streamable-http') && config.url) {
      existing[name] = {
        type: config.transport,
        url: config.url,
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      }
    }
  }
  return existing
}


/**
 * A tool output long enough to bloat the transcript. The CLI runs its own tool
 * loop, so what comes back here is whatever `Read` or `Bash` produced -- an
 * order of magnitude larger than the host's own tool results, and it is stored
 * on the message and re-rendered on every load. The head is what a reader
 * wants; the tail is what a log file wants.
 */
const MAX_TOOL_OUTPUT = 8_000

/** The text of a `tool_result` block, whose content is a string OR a block list. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
      return JSON.stringify(part)
    })
    .join('\n')
}

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [${text.length - MAX_TOOL_OUTPUT} more characters]`
}

/**
 * What one line of the CLI's `stream-json` output means to the chat UI.
 *
 * WHY THIS EXISTS. The CLI emits its whole tool loop on stdout -- `tool_use`
 * blocks carrying the file a Write touched, the `tool_result` that answered
 * them, and the model's `thinking` -- and all of it arrived inside
 * `message.content` beside the text. The reader here took `block.type ===
 * 'text'` and dropped the rest on the floor, so a claude-cli agent showed no
 * tool calls, no tool results and an empty thinking box, and a file it created
 * left no structured trace anywhere in the transcript. The SSE protocol already
 * carries all three (`tool_call`, `tool_result`, `thinking`) and the chat store
 * already renders them: nothing needed inventing, only forwarding.
 *
 * A `tool_result` NAMES ITS CALL BY ID, NOT BY NAME, and the store matches a
 * result to a running call by name. Hence `toolNames`: the caller keeps one map
 * per process and this fills it from each `tool_use` it sees, so the answer can
 * say which tool it is answering. An id with no entry means the pairing was
 * lost (a resumed session whose earlier turn this process never saw), and
 * 'unknown' is the honest label for it -- the store leaves such a result
 * unmatched rather than closing the wrong call.
 *
 * `text` is returned rather than emitted because the caller owns the running
 * response: only it knows whether a block replaces what came before.
 */
export function claudeCliStreamEvents(
  ev: unknown,
  toolNames: Map<string, string>,
): { events: SSEEvent[]; text: string | null } {
  const events: SSEEvent[] = []
  let text: string | null = null

  const event = ev as { type?: string; message?: { content?: unknown } }
  const content = event.message?.content
  if (!Array.isArray(content)) return { events, text }

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as {
      type?: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }

    if (event.type === 'assistant') {
      if (block.type === 'text' && block.text) {
        text = block.text
        events.push({ t: 'md', text: block.text })
      } else if (block.type === 'thinking' && block.thinking) {
        events.push({ t: 'thinking', text: block.thinking })
      } else if (block.type === 'tool_use' && block.name) {
        if (block.id) toolNames.set(block.id, block.name)
        events.push({
          t: 'tool_call',
          toolName: block.name,
          toolInput: block.input === undefined ? '' : JSON.stringify(block.input),
          ...(block.id ? { toolCallId: block.id } : {}),
        })
      }
    } else if (event.type === 'user' && block.type === 'tool_result') {
      const body = truncate(toolResultText(block.content))
      // The store reads an error off the text, so an errored result has to say
      // so in the text -- `is_error` alone would be shown as a success.
      const output = block.is_error && !/^error:/i.test(body.trim()) ? `Error: ${body}` : body
      events.push({
        t: 'tool_result',
        toolName: (block.tool_use_id && toolNames.get(block.tool_use_id)) || 'unknown',
        toolOutput: output,
        ...(block.tool_use_id ? { toolCallId: block.tool_use_id } : {}),
      })
    }
  }

  return { events, text }
}

/**
 * The prompt the CLI is given, attachments included.
 *
 * EVERY ATTACHMENT, NOT JUST THE FIRST IMAGE. This read `imagePath` alone and
 * called whatever it found an image, so a second attachment vanished and a
 * .docx was announced to the CLI as an image. The block names each file and
 * carries the text of the ones the CLI cannot open for itself -- a Word
 * document is a ZIP of XML, so `Read` on it comes back with nothing usable.
 *
 * Exported so the wiring is testable without spawning a process: the extractor
 * has its own tests, and this is the seam where a provider forgets to call it.
 */
export async function buildClaudeCliPrompt(
  message: string,
  imagePath?: string,
  attachedFiles?: string[],
): Promise<string> {
  const block = await buildAttachmentPreamble([
    ...(imagePath ? [imagePath] : []),
    ...(attachedFiles || []),
  ])
  return block ? `${block}\n\n${message}` : message
}

export async function streamClaudeCliChat({ session, message, imagePath, attachedFiles, systemPrompt, write, active, signal }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const binary = resolveCliBinary('claude')
  if (!binary) {
    const msg = 'Claude CLI not found. Install it and ensure it is on your PATH.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

  let prompt = await buildClaudeCliPrompt(message, imagePath, attachedFiles)

  // Durable memory. The LangGraph path that normally injects this is skipped
  // for every CLI provider, so without this block a claude-cli agent runs with
  // no memory at all -- the search runs upstream and its result is thrown
  // away. It goes into the prompt rather than the system prompt because
  // --system-prompt-snapshot pins the system prompt to the conversation's
  // first request, so a per-turn block placed there is silently ignored on
  // every resume.
  try {
    const memoryAgent = session.agentId ? getAgent(session.agentId as string) : null
    const recall = buildCliMemoryPreamble({
      session: session as Parameters<typeof buildCliMemoryPreamble>[0]['session'],
      agent: memoryAgent as Parameters<typeof buildCliMemoryPreamble>[0]['agent'],
      message,
      projectRoot: typeof session.cwd === 'string' ? session.cwd : null,
    })
    if (recall.preamble) {
      // Each memory records two keys (its id and its fact key), so report
      // memories, not keys.
      const before = Object.keys(session.injectedMemoryIds || {}).length
      const added = Math.round((Object.keys(recall.injectedMemoryIds).length - before) / 2)
      prompt = `${recall.preamble}\n\n${prompt}`
      session.injectedMemoryIds = recall.injectedMemoryIds
      // Mutating the in-memory session is not enough: the turn's finalizer
      // saves a record it fetched itself, so the field was lost every time and
      // the same memories were re-sent on every turn — stacking copies in a
      // resumed transcript instead of replacing them. Write it through.
      if (typeof session.id === 'string' && session.id) {
        try {
          let patched = false
          patchSession(session.id, (current) => {
            if (!current) return current
            patched = true
            return { ...current, injectedMemoryIds: recall.injectedMemoryIds }
          })
          // A patch that finds no stored session writes nothing and throws
          // nothing, which is how the subagent case stayed invisible: the
          // preamble logged six injected lines and the record kept none.
          if (!patched) {
            log.warn('claude-cli', 'Injected memories were not recorded: no stored session to patch', {
              sessionId: session.id,
              agentId: session.agentId,
            })
          }
        } catch (persistErr) {
          log.warn('claude-cli', `Could not persist injected memory ids: ${persistErr}`)
        }
      }
      log.info('claude-cli', `Injected ${added} memory line(s) into the prompt`, {
        sessionId: session.id,
        agentId: session.agentId,
      })
    }
  } catch (memErr) {
    // Recall is an enhancement; a failure here must not cost the user a turn.
    log.warn('claude-cli', `Memory recall skipped: ${memErr}`)
  }

  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
  const resumeSessionId = typeof session.claudeSessionId === 'string' ? session.claudeSessionId : ''
  const selectedModel = typeof session.model === 'string' ? session.model : ''
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  if (selectedModel) args.push('--model', selectedModel)

  // Inject agent system prompt
  if (systemPrompt && !resumeSessionId) {
    args.push('--system-prompt', systemPrompt)
  }

  // MCP servers. Two sources land in ONE config file, because repeating
  // --mcp-config is not a merge on every CLI version we support: the browser
  // proxy the `browser` tool implies, and the servers the operator assigned to
  // this agent. The second half is the only way any SwarmClaw-side capability
  // reaches a CLI provider at all — the CLI runs its own tool loop and never
  // sees the LangChain array buildSessionTools() assembles — so a missing
  // assignment here is an agent that silently has none of what the UI shows it
  // was given. codex-cli.ts and copilot-cli.ts do the same thing in the config
  // shape their own CLI takes.
  const tools = getEnabledToolIds(session as { tools?: string[] | null } | null)
  const mcpServers: Record<string, McpServerEntry> = {}

  if (tools.includes('browser')) {
    const proxyScript = path.join(process.cwd(), 'src/lib/server/playwright-proxy.mjs')
    const uploadDir = path.join(os.tmpdir(), 'swarmclaw-uploads')
    mcpServers.playwright = {
      command: 'node',
      args: [proxyScript],
      env: { SWARMCLAW_UPLOAD_DIR: uploadDir },
    }
  }

  // A failure to build the assigned servers must not take the turn down with
  // it: the agent is still useful without them, and an exception here would
  // read to the user as "Claude CLI is broken".
  try {
    const agentForMcp = session.agentId ? getAgent(session.agentId as string) : null
    const agentMcpServerIds: string[] = agentForMcp?.mcpServerIds || []
    if (agentMcpServerIds.length > 0) {
      const before = Object.keys(mcpServers).length
      addAssignedMcpServers(
        mcpServers,
        agentMcpServerIds,
        loadMcpServers() as unknown as Record<string, Record<string, unknown>>,
        {
          agentId: session.agentId as string | null,
          agentName: typeof agentForMcp?.name === 'string' ? agentForMcp.name : null,
          sessionId: session.id,
        },
      )
      log.info('claude-cli', `Injecting ${Object.keys(mcpServers).length - before} agent-assigned MCP server(s)`, {
        requested: agentMcpServerIds.length,
        names: Object.keys(mcpServers),
      })
    }
  } catch (mcpErr) {
    log.warn('claude-cli', `Failed to build MCP config: ${mcpErr}`)
  }

  let mcpConfigPath: string | null = null
  if (Object.keys(mcpServers).length > 0) {
    mcpConfigPath = path.join(os.tmpdir(), `swarmclaw-mcp-${session.id}.json`)
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }))
    args.push('--mcp-config', mcpConfigPath)
  }

  const env = buildCliEnv()

  // Auth probe
  const auth = probeCliAuth(binary, 'claude', env, session.cwd)
  if (!auth.authenticated) {
    log.error('claude-cli', auth.errorMessage || 'Auth failed')
    write(`data: ${JSON.stringify({ t: 'err', text: auth.errorMessage || 'Claude CLI is not authenticated.' })}\n\n`)
    return Promise.resolve('')
  }

  log.info('claude-cli', `Spawning: ${binary}`, {
    args: args.map(a => a.length > 100 ? a.slice(0, 100) + '...' : a),
    cwd: session.cwd,
    promptLen: prompt.length,
    hasSystemPrompt: !!systemPrompt,
    systemPromptLen: systemPrompt?.length || 0,
  })

  const proc = spawn(binary, args, {
    cwd: session.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  log.info('claude-cli', `Process spawned: pid=${proc.pid}`)

  proc.stdin!.write(prompt)
  proc.stdin!.end()

  active.set(session.id, proc)
  attachAbortHandler(proc, signal)

  let fullResponse = ''
  let buf = ''
  let eventCount = 0
  let stderrText = ''
  /** tool_use id -> tool name, so a `tool_result` can name the call it answers. */
  const toolNames = new Map<string, string>()

  proc.stdout!.on('data', (chunk: Buffer) => {
    const raw = chunk.toString()
    buf += raw

    // Log first chunk for debugging
    if (eventCount === 0) {
      log.debug('claude-cli', `First stdout chunk (${raw.length} bytes)`, raw.slice(0, 500))
    }

    const lines = buf.split('\n')
    buf = lines.pop()!

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        eventCount++

        if (ev.session_id && !session.claudeSessionId) {
          session.claudeSessionId = ev.session_id
          log.info('claude-cli', `Got session_id: ${ev.session_id}`)
        }

        if (ev.type === 'result') {
          if (ev.session_id) session.claudeSessionId = ev.session_id
          if (ev.result) {
            fullResponse = ev.result
            write(`data: ${JSON.stringify({ t: 'r', text: ev.result })}\n\n`)
            log.debug('claude-cli', `Result event (${ev.result.length} chars)`)
          }
        } else if (ev.type === 'assistant' || ev.type === 'user') {
          const { events, text } = claudeCliStreamEvents(ev, toolNames)
          if (text !== null) {
            fullResponse = text
            log.debug('claude-cli', `Assistant text block (${text.length} chars)`)
          }
          for (const out of events) {
            write(`data: ${JSON.stringify(out)}\n\n`)
            if (out.t === 'tool_call') log.debug('claude-cli', `Tool call: ${out.toolName}`)
          }
        } else if (ev.type === 'content_block_delta' && ev.delta?.text) {
          fullResponse += ev.delta.text
          write(`data: ${JSON.stringify({ t: 'd', text: ev.delta.text })}\n\n`)
        } else {
          // Log other event types we see
          if (eventCount <= 5) {
            log.debug('claude-cli', `Event type: ${ev.type}`, ev.type === 'system' ? ev : undefined)
          }
        }
      } catch {
        if (line.trim()) {
          log.debug('claude-cli', `Non-JSON stdout line`, line.slice(0, 300))
          fullResponse += line + '\n'
          write(`data: ${JSON.stringify({ t: 'd', text: line + '\n' })}\n\n`)
        }
      }
    }
  })

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderrText += text
    if (stderrText.length > 16_000) stderrText = stderrText.slice(-16_000)
    if (isStderrNoise(text)) {
      log.debug('claude-cli', `stderr noise [${session.id}]`, text.slice(0, 500))
    } else {
      log.warn('claude-cli', `stderr [${session.id}]`, text.slice(0, 500))
      log.error(TAG, `[${session.id}] stderr:`, text.slice(0, 200))
    }
  })

  return new Promise((resolve) => {
    proc.on('close', (code, sig) => {
      log.info('claude-cli', `Process closed: code=${code} signal=${sig} events=${eventCount} response=${fullResponse.length}chars`)
      active.delete(session.id)
      if (mcpConfigPath) try { fs.unlinkSync(mcpConfigPath) } catch { /* ignore */ }
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `Claude CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `Claude CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''} and returned no output.`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      resolve(fullResponse)
    })

    proc.on('error', (e) => {
      log.error('claude-cli', `Process error: ${e.message}`)
      active.delete(session.id)
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      resolve(fullResponse)
    })
  })
}

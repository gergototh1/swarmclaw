import { spawn } from 'child_process'
import { SimpleChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'

import { resolveCliBinary, buildCliEnv } from '@/lib/providers/cli-utils'
import { log } from '@/lib/server/logger'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { claimUtilityCall, releaseUtilityCall, resolveUtilityBudget, type UtilityClaim } from './utility-budget'

/**
 * The already-installed coding CLI, used as the utility model.
 *
 * WHY THIS EXISTS. Every helper in the host — working-state extraction, the
 * message classifier, autonomy observation, the daily memory digest, the dream
 * cycle, the abstract writer — asks `buildLLM()` for a model, and
 * `resolveGenerationModelConfig` refuses every CLI provider because a CLI runs
 * its own tool loop and exposes no chat-completions API. On an install where
 * every agent is CLI-backed and no LLM API key is configured, that means none
 * of them ever run: 696 "No generation-compatible model" lines in one log, and
 * a consolidation pass that silently skips itself.
 *
 * A small local model would fix it, at the price of local inference on whatever
 * machine the app runs on. The CLI is already installed, already authenticated
 * and already paid for, and the inference happens elsewhere — which is what a
 * weak machine needs.
 *
 * WHY A TEXT-ONLY ADAPTER IS ENOUGH. All seventeen `buildLLM` callers use plain
 * `llm.invoke(...)`. None binds tools, streams, or asks for structured output
 * through LangChain, so one prompt in and one string out covers every one.
 *
 * WHY IT IS NOT A SECOND WAY TO RUN AN AGENT. The helper starts with
 * `--strict-mcp-config` and an empty config: no MCP servers, no platform
 * bridge, nothing to call. It never resumes a conversation. It answers the
 * question it was given and exits.
 */

export type UtilityResponseFormat = 'json_object'

export interface CliRunResult {
  code: number
  stdout: string
  stderr: string
}

export type CliRunner = (binary: string, args: string[], input: string, timeoutMs: number) => Promise<CliRunResult>

/** Enough for a page of transcript to come back; a helper must not hold a turn open. */
export const DEFAULT_UTILITY_TIMEOUT_MS = 45_000

export function buildClaudePrintArgs(opts: { model: string; responseFormat?: UtilityResponseFormat | null }): string[] {
  const args = ['--print', '--model', opts.model, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
  if (opts.responseFormat === 'json_object') args.push('--output-format', 'json')
  return args
}

function messageText(message: BaseMessage): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Flatten a message list into the single prompt `--print` takes.
 *
 * A lone human message is passed through verbatim: labelling one line "Human:"
 * only adds noise to a question that has no other speaker.
 */
export function renderPromptForCli(messages: BaseMessage[]): string {
  const parts = messages.map((message) => {
    const text = messageText(message).trim()
    if (!text) return ''
    const type = message.getType()
    const label = type === 'system' ? 'System' : type === 'ai' ? 'Assistant' : 'Human'
    return { label, text }
  }).filter((part): part is { label: string; text: string } => !!part)

  if (parts.length === 1) return parts[0].text
  return parts.map((part) => `${part.label}: ${part.text}`).join('\n\n')
}

/**
 * `--output-format json` wraps the answer in a result envelope. The caller
 * asked for ITS json, not ours, so the envelope is unwrapped here.
 */
function unwrapJsonEnvelope(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return trimmed
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    if (typeof parsed.result === 'string') return parsed.result.trim()
    // An error envelope carries no usable answer; say so rather than hand the
    // caller a wrapper it will fail to parse.
    if (parsed.is_error === true || parsed.subtype === 'error') {
      throw new Error(`utility CLI returned an error envelope: ${trimmed.slice(0, 200)}`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('utility CLI returned an error envelope')) throw err
    // Not our envelope — the caller's own json, pass it through.
  }
  return trimmed
}

const defaultRunner: CliRunner = (binary, args, input, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn(binary, args, { env: buildCliEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    reject(new Error(`utility CLI timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.on('error', (err) => { clearTimeout(timer); reject(err) })
  child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }) })
  child.stdin.end(input)
})

export interface CliUtilityChatModelParams extends BaseChatModelParams {
  model: string
  /** Resolved once by the caller; `null` means the CLI is not installed. */
  binary?: string | null
  responseFormat?: UtilityResponseFormat | null
  timeoutMs?: number
  /** The conversation this helper is working for, for the per-session cooldown. */
  sessionId?: string | null
  /** Injected in tests; production spawns the real process. */
  run?: CliRunner
  /** Injected in tests; production consults the fleet-wide budget. */
  claim?: () => UtilityClaim
  release?: () => void
}

export class CliUtilityChatModel extends SimpleChatModel {
  private readonly modelName: string
  private readonly binary: string | null
  private readonly responseFormat: UtilityResponseFormat | null
  private readonly timeoutMs: number
  private readonly run: CliRunner
  private readonly claim: () => UtilityClaim
  private readonly release: () => void

  constructor(params: CliUtilityChatModelParams) {
    super(params)
    this.modelName = params.model
    this.binary = params.binary === undefined ? resolveCliBinary('claude') : params.binary
    this.responseFormat = params.responseFormat ?? null
    this.timeoutMs = params.timeoutMs ?? DEFAULT_UTILITY_TIMEOUT_MS
    this.run = params.run ?? defaultRunner
    const sessionId = params.sessionId ?? null
    this.claim = params.claim ?? (() => claimUtilityCall({ sessionId, budget: resolveUtilityBudget(loadSettings()) }))
    this.release = params.release ?? releaseUtilityCall
  }

  _llmType(): string {
    return 'swarmclaw-cli-utility'
  }

  async _call(messages: BaseMessage[]): Promise<string> {
    if (!this.binary) {
      throw new Error('utility CLI binary not found: install the Claude CLI or configure an API provider as the utility model')
    }
    // The brake sits here rather than in each of the seventeen callers: this is
    // the path that spends the subscription. A refusal throws, because every
    // caller is already wrapped in a best-effort catch — answering with an empty
    // string would read to them as "there was nothing worth extracting".
    const claim = this.claim()
    if (!claim.ok) {
      throw new Error(`utility model refused by budget: ${claim.reason}`)
    }

    try {
      const args = buildClaudePrintArgs({ model: this.modelName, responseFormat: this.responseFormat })
      const prompt = renderPromptForCli(messages)
      const result = await this.run(this.binary, args, prompt, this.timeoutMs)
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || '').trim().slice(0, 300)
        throw new Error(`utility CLI exited with ${result.code}: ${detail}`)
      }
      const answer = this.responseFormat === 'json_object'
        ? unwrapJsonEnvelope(result.stdout)
        : result.stdout.trim()
      if (!answer) {
        log.warn('utility-llm', 'utility CLI produced no output', { model: this.modelName })
        throw new Error('utility CLI produced an empty answer')
      }
      return answer
    } finally {
      this.release()
    }
  }
}

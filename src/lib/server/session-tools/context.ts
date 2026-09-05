import type { StructuredToolInterface } from '@langchain/core/tools'
import type { Agent, Session } from '@/types'

export const MAX_OUTPUT = 50 * 1024 // 50KB
export const MAX_FILE = 100 * 1024 // 100KB

export interface ToolContext {
  agentId?: string | null
  sessionId?: string | null
  runId?: string | null
  delegationEnabled?: boolean
  delegationTargetMode?: 'all' | 'selected'
  delegationTargetAgentIds?: string[]
  mcpServerIds?: string[]
  mcpDisabledTools?: string[]
  projectId?: string | null
  projectRoot?: string | null
  projectName?: string | null
  projectDescription?: string | null
  memoryScopeMode?: 'auto' | 'all' | 'global' | 'agent' | 'session' | 'project' | null
  beforeToolCall?: (params: {
    session: Session
    toolName: string
    input: Record<string, unknown> | null
    runId?: string | null
  }) => Promise<ToolCallGuardResult | void> | ToolCallGuardResult | void
  onToolCallWarning?: (params: { toolName: string; message: string }) => void
}

export interface ToolCallGuardResult {
  input?: Record<string, unknown> | null
  blockReason?: string | null
  warning?: string | null
}

/**
 * Mutable container for an AbortSignal, set after tool build.
 * Allows stream-agent-chat to propagate cancellation to in-flight tools.
 */
export interface AbortSignalRef {
  signal?: AbortSignal
}

export interface SessionToolsResult {
  tools: StructuredToolInterface[]
  cleanup: () => Promise<void>
  /** Maps tool name → extension ID for attribution in usage tracking */
  toolToExtensionMap: Record<string, string>
  /** Set after build to propagate abort from the chat loop to tool executions */
  abortSignalRef: AbortSignalRef
}

/**
 * Compose a parent abort signal with a timeout, returning a signal that fires
 * on whichever triggers first. Useful for tool-level fetch calls.
 */
export function composeAbortSignals(parentSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (!parentSignal) return AbortSignal.timeout(timeoutMs)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs)
  const onParentAbort = () => {
    clearTimeout(timer)
    controller.abort(parentSignal.reason)
  }
  if (parentSignal.aborted) {
    clearTimeout(timer)
    controller.abort(parentSignal.reason)
  } else {
    parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }
  // Clean up listener when our signal fires (from timeout)
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timer)
    parentSignal.removeEventListener('abort', onParentAbort)
  }, { once: true })
  return controller.signal
}

export interface ToolBuildContext {
  cwd: string
  ctx: ToolContext | undefined
  hasExtension: (name: string) => boolean
  /** @deprecated Use hasExtension */
  hasTool: (name: string) => boolean
  cleanupFns: (() => Promise<void>)[]
  commandTimeoutMs: number
  claudeTimeoutMs: number
  cliProcessTimeoutMs: number
  persistDelegateResumeId: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'droid' | 'cursor' | 'qwen', id: string | null | undefined) => void
  readStoredDelegateResumeId: (key: 'claudeCode' | 'codex' | 'opencode' | 'gemini' | 'copilot' | 'droid' | 'cursor' | 'qwen') => string | null
  resolveCurrentSession: () => any | null
  activeExtensions: string[]
  /** Agent's file access policy — passed to shell for command-level enforcement */
  fileAccessPolicy?: { allowedPaths?: string[]; blockedPaths?: string[] } | null
  /** Agent's sandbox config — passed to shell for session-scoped container execution */
  sandboxConfig?: NonNullable<Agent['sandboxConfig']> | null
  /** Loaded agent record for tool builders that need per-agent runtime settings */
  agentRecord?: Agent | null
  /** Agent's filesystem scope — 'machine' allows file access outside the workspace */
  filesystemScope?: 'workspace' | 'machine'
}

function normalizeWorkspaceAlias(cwd: string, filePath: string): string {
  const trimmed = filePath.trim()
  if (!trimmed) return trimmed
  if (trimmed === '/workspace' || trimmed === 'workspace') return cwd
  if (trimmed.startsWith('/workspace/')) return trimmed.slice('/workspace/'.length)
  if (trimmed.startsWith('workspace/')) return trimmed.slice('workspace/'.length)
  return trimmed
}

/**
 * Safe absolute paths that agents are allowed to write to outside the workspace.
 * Kept minimal to prevent accidental writes to sensitive system locations.
 */
const ALLOWED_ABSOLUTE_PREFIXES = ['/tmp/', '/var/tmp/']

export function safePath(cwd: string, filePath: string, scope?: 'workspace' | 'machine'): string {
  const path = require('path')
  const normalized = normalizeWorkspaceAlias(cwd, filePath)
  const resolvedRoot = path.resolve(cwd)
  const resolved = path.resolve(resolvedRoot, normalized)
  // Machine scope: allow any resolved path (blockedPaths enforced separately)
  if (scope === 'machine') return resolved
  // Allow workspace-relative paths
  if (resolved.startsWith(resolvedRoot)) return resolved
  // Allow explicitly safe absolute paths (e.g., /tmp/)
  if (path.isAbsolute(normalized) && ALLOWED_ABSOLUTE_PREFIXES.some((p: string) => resolved.startsWith(p))) {
    return resolved
  }
  // Fallback: treat hallucinated absolute paths as workspace-relative.
  // Models sometimes generate "/projectname/src/..." instead of "src/..."
  if (path.isAbsolute(normalized)) {
    const asRelative = normalized.replace(/^\/+/, '')
    if (asRelative) {
      const resolvedRelative = path.resolve(resolvedRoot, asRelative)
      if (resolvedRelative.startsWith(resolvedRoot + path.sep) || resolvedRelative === resolvedRoot) {
        return resolvedRelative
      }
    }
  }
  throw new Error('Path traversal not allowed')
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n... [truncated at ${max} bytes]`
}

export function tail(text: string, max = 4000): string {
  if (!text) return ''
  return text.length <= max ? text : text.slice(text.length - max)
}

export function extractResumeIdentifier(text: string): string | null {
  if (!text) return null
  const patterns = [
    /session[_\s-]?id["'\s]*[:=]\s*["']?([A-Za-z0-9._:-]{6,})/i,
    /thread[_\s-]?id["'\s]*[:=]\s*["']?([A-Za-z0-9._:-]{6,})/i,
    /resume(?:\s+with)?\s+([A-Za-z0-9._:-]{6,})/i,
  ]
  for (const pattern of patterns) {
    const m = text.match(pattern)
    if (m?.[1]) return m[1]
  }
  return null
}

const BINARY_LOOKUP_CACHE_MAX = 100
const binaryLookupCache = new Map<string, { checkedAt: number; path: string | null }>()
const BINARY_LOOKUP_TTL_MS = 30_000
const isWindows = process.platform === 'win32'

/**
 * Whether a string is an absolute filesystem path on this platform: what
 * `path.isAbsolute` answers, written out because this module keeps node
 * built-ins out of its module scope and a two-line test is cheaper than a
 * lazy import for it. A drive letter or a UNC share on Windows, a leading
 * separator anywhere.
 */
function isAbsolutePath(value: string): boolean {
  if (value === '') return false
  if (!isWindows) return value.startsWith('/')
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/') || value.startsWith('\\')
}

/**
 * Where a binary is, according to a login shell, or null.
 *
 * WHAT IT COSTS THE CALLER. This is a synchronous `spawnSync` of the
 * operator's login shell — `$SHELL -lc`, which sources their profile — on
 * whatever thread calls it, for up to 2 seconds. In the server process that
 * thread is the one running the HTTP handlers, the WebSocket hub and the
 * scheduler tick, and nothing here is rate limited. A negative answer is
 * cached for only 30 seconds, so a caller that asks about a binary that is
 * not installed pays the full spawn again every half minute. Call it once per
 * operation, not once per item, and never in a loop.
 *
 * WHAT COUNTS AS AN ANSWER. Only stderr is suppressed, so everything the
 * profile prints to stdout — a banner, a version notice, an nvm or direnv
 * line — arrives in front of `command -v`'s own output and used to be
 * returned as if it were the path. Callers spawn what they get back or check
 * it with `existsSync`, and a banner is neither a binary nor a missing one:
 * it is an answer this function cannot read, and returning it made every
 * caller's fallback list unreachable on any machine whose profile speaks.
 *
 * So exactly two answers are taken. An absolute path, which is what
 * `command -v` prints for an installed program. Or the name itself, which is
 * what it prints for a shell builtin, function or alias — the caller asked
 * about that name and the shell said the name is what runs, so the caller
 * spawning the bare name is doing what the shell would. Anything else — a
 * banner, several lines, some other word — is treated as no answer at all
 * rather than parsed for a line that might be the path, and the callers with
 * their own fallback list (`resolveCliBinary` in
 * src/lib/providers/cli-utils.ts, and `ctx.resolveBinary` above it) reach it,
 * which is the whole reason those lists exist.
 */
export function findBinaryOnPath(binaryName: string): string | null {
  const now = Date.now()
  const cached = binaryLookupCache.get(binaryName)
  if (cached && now - cached.checkedAt < BINARY_LOOKUP_TTL_MS) return cached.path

  // Prune expired + cap
  for (const [k, v] of binaryLookupCache) {
    if (now - v.checkedAt > BINARY_LOOKUP_TTL_MS) binaryLookupCache.delete(k)
  }
  if (binaryLookupCache.size > BINARY_LOOKUP_CACHE_MAX) {
    const excess = binaryLookupCache.size - BINARY_LOOKUP_CACHE_MAX
    const iter = binaryLookupCache.keys()
    for (let i = 0; i < excess; i++) {
      const k = iter.next().value
      if (k !== undefined) binaryLookupCache.delete(k)
    }
  }

  const { spawnSync } = require('child_process')
  const probe = isWindows
    ? spawnSync('where', [binaryName], { encoding: 'utf-8', timeout: 2000, stdio: 'pipe' })
    : spawnSync(process.env.SHELL || '/bin/bash', ['-lc', `command -v ${binaryName} 2>/dev/null`], { encoding: 'utf-8', timeout: 2000 })
  const answer = (probe.stdout || '').trim()
  const resolved = isAbsolutePath(answer) || answer === binaryName ? answer : null
  binaryLookupCache.set(binaryName, { checkedAt: now, path: resolved })
  return resolved
}

export function coerceEnvMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

export function listDirRecursive(dir: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return []
  const fs = require('fs')
  const path = require('path')
  const entries: string[] = []
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue
      const rel = item.name
      if (item.isDirectory()) {
        entries.push(rel + '/')
        const sub = listDirRecursive(path.join(dir, item.name), depth + 1, maxDepth)
        entries.push(...sub.map((s: string) => `  ${rel}/${s}`))
      } else {
        entries.push(rel)
      }
    }
  } catch {
    // permission error etc
  }
  return entries
}

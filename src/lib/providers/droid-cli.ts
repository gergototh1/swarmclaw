import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { resolveCliBinary, buildCliEnv, probeCliAuth, attachAbortHandler, symlinkConfigFiles, isStderrNoise } from './cli-utils'
import { buildAttachmentPreamble } from '@/lib/server/attachments/attachment-text'

/**
 * Factory Droid CLI provider — spawns `droid exec <message> --output-format stream-json`.
 * Tracks `session.droidSessionId` from streamed events to support multi-turn continuity.
 */
export async function streamDroidCliChat({ session, message, imagePath, attachedFiles, systemPrompt, write, active, signal }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const binary = resolveCliBinary('droid')
  if (!binary) {
    const msg = 'Factory Droid CLI not found. Install it (brew install --cask droid, npm i -g droid, or https://docs.factory.ai/cli/getting-started/quickstart) and ensure it is on your PATH.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

  const env = buildCliEnv()

  if (session.apiKey) {
    env.FACTORY_API_KEY = session.apiKey
  }

  if (!session.apiKey) {
    const auth = probeCliAuth(binary, 'droid', env, session.cwd)
    if (!auth.authenticated) {
      log.error('droid-cli', auth.errorMessage || 'Auth failed')
      write(`data: ${JSON.stringify({ t: 'err', text: auth.errorMessage || 'Factory Droid CLI is not authenticated.' })}\n\n`)
      return Promise.resolve('')
    }
  }

  const promptParts: string[] = []
  // Minden csatolmány, a szövegével együtt, nem csak az első kép útvonala.
  const attachmentBlock = await buildAttachmentPreamble([
    ...(imagePath ? [imagePath] : []),
    ...(attachedFiles || []),
  ])
  if (attachmentBlock) promptParts.push(attachmentBlock)
  promptParts.push(message)
  const prompt = promptParts.join('\n\n')

  const args = ['exec', prompt, '--output-format', 'stream-json']
  if (session.droidSessionId) args.push('-s', session.droidSessionId)
  if (session.model) args.push('-m', session.model)

  let tempFactoryHome: string | null = null
  if (systemPrompt && !session.droidSessionId) {
    const realFactoryHome = process.env.FACTORY_HOME || path.join(os.homedir(), '.factory')
    tempFactoryHome = path.join(os.tmpdir(), `swarmclaw-droid-${session.id}`)
    fs.mkdirSync(tempFactoryHome, { recursive: true })
    symlinkConfigFiles(realFactoryHome, tempFactoryHome)
    fs.writeFileSync(path.join(tempFactoryHome, 'AGENTS.override.md'), systemPrompt)
    env.FACTORY_HOME = tempFactoryHome
  }

  log.info('droid-cli', `Spawning: ${binary}`, {
    args: args.map((a) => a.length > 100 ? a.slice(0, 100) + '...' : a),
    cwd: session.cwd,
    promptLen: prompt.length,
    hasSystemPrompt: !!systemPrompt,
    resumeSessionId: session.droidSessionId || null,
  })

  const proc = spawn(binary, args, {
    cwd: session.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  log.info('droid-cli', `Process spawned: pid=${proc.pid}`)
  active.set(session.id, proc)
  attachAbortHandler(proc, signal)

  let fullResponse = ''
  let buf = ''
  let eventCount = 0
  let stderrText = ''

  proc.stdout!.on('data', (chunk: Buffer) => {
    const raw = chunk.toString()
    buf += raw

    if (eventCount === 0) {
      log.debug('droid-cli', `First stdout chunk (${raw.length} bytes)`, raw.slice(0, 500))
    }

    const lines = buf.split('\n')
    buf = lines.pop()!

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as Record<string, unknown>
        eventCount++

        const data = ev.data as Record<string, unknown> | undefined

        if (typeof ev.session_id === 'string') {
          session.droidSessionId = ev.session_id
        } else if (typeof ev.sessionId === 'string') {
          session.droidSessionId = ev.sessionId
        }

        if (ev.type === 'assistant.message_delta' && typeof data?.deltaContent === 'string') {
          fullResponse += data.deltaContent
          write(`data: ${JSON.stringify({ t: 'd', text: data.deltaContent })}\n\n`)
        }

        else if (ev.type === 'assistant.message' && typeof data?.content === 'string') {
          if (!fullResponse) {
            fullResponse = data.content
            write(`data: ${JSON.stringify({ t: 'r', text: data.content })}\n\n`)
          }
          log.debug('droid-cli', `Assistant message (${data.content.length} chars)`)
        }

        else if (ev.type === 'content_block_delta') {
          const delta = ev.delta as Record<string, unknown> | undefined
          if (typeof delta?.text === 'string') {
            fullResponse += delta.text
            write(`data: ${JSON.stringify({ t: 'd', text: delta.text })}\n\n`)
          }
        }

        else if (ev.type === 'agent_message_chunk' && typeof ev.text === 'string') {
          fullResponse += ev.text
          write(`data: ${JSON.stringify({ t: 'd', text: ev.text })}\n\n`)
        }

        else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
          fullResponse += ev.content
          write(`data: ${JSON.stringify({ t: 'd', text: ev.content })}\n\n`)
        }

        else if (ev.type === 'item.completed' && (ev.item as Record<string, unknown>)?.type === 'agent_message') {
          const item = ev.item as Record<string, unknown>
          if (typeof item.text === 'string') {
            fullResponse = item.text
            write(`data: ${JSON.stringify({ t: 'r', text: item.text })}\n\n`)
            log.debug('droid-cli', `Agent message (${item.text.length} chars)`)
          }
        }

        else if (ev.type === 'result' && typeof ev.result === 'string') {
          fullResponse = ev.result
          write(`data: ${JSON.stringify({ t: 'r', text: ev.result })}\n\n`)
          log.debug('droid-cli', `Result event (${ev.result.length} chars)`)
        }

        else if (ev.type === 'result' && ev.status === 'error') {
          const errMsg = typeof ev.error === 'string' ? ev.error : 'Droid error'
          write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
          log.warn('droid-cli', `Error result: ${errMsg}`)
        }

        else if (ev.type === 'error') {
          const errMsg = typeof ev.message === 'string'
            ? ev.message
            : typeof ev.error === 'string'
              ? ev.error
              : 'Unknown Droid error'
          write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
          log.warn('droid-cli', `Event error: ${errMsg}`)
        }

        else if (eventCount <= 10) {
          log.debug('droid-cli', `Event: ${String(ev.type)}`)
        }
      } catch {
        if (line.trim()) {
          log.debug('droid-cli', `Non-JSON stdout line`, line.slice(0, 300))
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
      log.debug('droid-cli', `stderr noise [${session.id}]`, text.slice(0, 500))
    } else {
      log.warn('droid-cli', `stderr [${session.id}]`, text.slice(0, 500))
    }
  })

  return new Promise((resolve) => {
    proc.on('close', (code, sig) => {
      log.info('droid-cli', `Process closed: code=${code} signal=${sig} events=${eventCount} response=${fullResponse.length}chars`)
      active.delete(session.id)
      if (tempFactoryHome) {
        try { fs.rmSync(tempFactoryHome, { recursive: true }) } catch { /* ignore */ }
      }
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `Factory Droid CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `Factory Droid CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''} and returned no output.`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      resolve(fullResponse)
    })

    proc.on('error', (e) => {
      log.error('droid-cli', `Process error: ${e.message}`)
      active.delete(session.id)
      if (tempFactoryHome) {
        try { fs.rmSync(tempFactoryHome, { recursive: true }) } catch { /* ignore */ }
      }
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      resolve(fullResponse)
    })
  })
}

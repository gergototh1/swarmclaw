import type { SSEEvent } from '@/types'
import { getStoredAccessKey } from '@/lib/app/api-client'

interface StreamChatOptions {
  internal?: boolean
  queueMode?: 'followup' | 'steer' | 'collect'
  replyToId?: string
}

export async function streamChat(
  sessionId: string,
  message: string,
  imagePath?: string,
  imageUrl?: string,
  onEvent?: (event: SSEEvent) => void,
  optionsOrFiles?: StreamChatOptions | string[],
  options?: StreamChatOptions,
): Promise<void> {
  // Support both (options) and (attachedFiles, options) as 6th arg
  let attachedFiles: string[] | undefined
  let opts: StreamChatOptions | undefined
  if (Array.isArray(optionsOrFiles)) {
    attachedFiles = optionsOrFiles
    opts = options
  } else {
    opts = optionsOrFiles
  }

  const key = getStoredAccessKey()
  const res = await fetch(`/api/chats/${sessionId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'X-Access-Key': key } : {}),
    },
    body: JSON.stringify({
      message,
      imagePath,
      imageUrl,
      attachedFiles,
      internal: !!opts?.internal,
      queueMode: opts?.queueMode,
      ...(opts?.replyToId ? { replyToId: opts.replyToId } : {}),
    }),
  })

  if (!res.ok || !res.body) {
    onEvent?.({ t: 'err', text: `Request failed (${res.status})` })
    onEvent?.({ t: 'done' })
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const STREAM_IDLE_TIMEOUT_MS = 300_000

  while (true) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const idleAbort = new Promise<{ done: true; value: undefined }>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        resolve({ done: true, value: undefined })
      }, STREAM_IDLE_TIMEOUT_MS)
    })
    // `.finally`, not a line after the await: a dropped transport rejects the
    // read, and the 5-minute idle timer would otherwise outlive the stream it
    // was watching — holding the event loop, and this closure, open.
    const { done, value } = await Promise.race([reader.read(), idleAbort])
      .finally(() => clearTimeout(timeoutId))
    if (done) {
      if (timedOut) {
        onEvent?.({ t: 'err', text: 'Stream timed out (no data for 5 minutes)' })
        reader.cancel().catch(() => {})
      }
      break
    }
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      let event: SSEEvent
      try {
        event = JSON.parse(line.slice(6)) as SSEEvent
      } catch {
        continue // skip malformed
      }
      // Forward all event types including tool_call and tool_result.
      // One handler that throws must not kill the stream — but it must not be
      // invisible either: the same `catch` used to cover the parse, so a bug in
      // the store's event handling looked exactly like a malformed line and
      // took the rest of this line batch down with it.
      try {
        onEvent?.(event)
      } catch (err) {
        console.error('[chat] SSE event handler threw', err)
      }
    }
  }
}

import type { Message } from '@/types'

/**
 * Every file a conversation has, recovered from the transcript.
 *
 * There is no file table for a session, so the transcript is the record, and it
 * carries two kinds of reference:
 *
 * - WHAT THE OPERATOR ATTACHED, in `imagePath` / `imageUrl` / `attachedFiles`.
 *   These are structured fields; nothing is inferred.
 *
 * - WHAT THE AGENT PRODUCED, as `/api/uploads/<name>` links. Every tool that
 *   hands a file back copies it into the upload directory and returns that URL
 *   (`session-tools/file.ts`, `web.ts`, the connector tools), so the URL is the
 *   app's own and matching it is not guesswork about arbitrary text. Only that
 *   prefix is matched: a bare path in prose stays prose.
 *
 * DOCUMENTS FROM THE DOCS EXTENSION ARE NOT HERE. Its records carry an `owner`
 * and no session, so "which conversation produced this document" is a question
 * its store cannot answer. Listing them per conversation would mean guessing,
 * and a wrong file in a file list is worse than a short one.
 */

export interface ConversationFile {
  /** What to show. */
  name: string
  /** Where to open it. Always a URL this app serves. */
  url: string
  /** Who put it in the conversation. */
  origin: 'attached' | 'produced'
  /** When it entered the conversation. */
  time: number
  /** Index of the message it came from, for jumping to it. */
  messageIndex: number
}

const UPLOAD_URL = /\/api\/uploads\/([A-Za-z0-9._%-]+)/g

function basename(pathOrUrl: string): string {
  const last = pathOrUrl.split('/').pop() || pathOrUrl
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/**
 * The upload directory names a file `<id>-<original name>`, so the stored id is
 * dropped for display. A name that carries no id is left alone.
 */
function displayName(fileName: string): string {
  const match = fileName.match(/^[0-9a-f]{6,}-(.+)$/i) || fileName.match(/^\d{10,}-(.+)$/)
  return match ? match[1] : fileName
}

/** The URL that serves a stored upload path. */
function urlForStoredPath(filePath: string): string {
  return `/api/uploads/${encodeURIComponent(basename(filePath))}`
}

export function collectConversationFiles(messages: Message[]): ConversationFile[] {
  const out: ConversationFile[] = []
  const seen = new Set<string>()

  const push = (file: ConversationFile) => {
    if (seen.has(file.url)) return
    seen.add(file.url)
    out.push(file)
  }

  messages.forEach((message, messageIndex) => {
    const time = typeof message.time === 'number' ? message.time : 0

    const attached: string[] = []
    if (message.imagePath) attached.push(message.imagePath)
    for (const f of message.attachedFiles || []) if (f) attached.push(f)
    for (const filePath of attached) {
      const url = message.imageUrl && filePath === message.imagePath
        ? message.imageUrl
        : urlForStoredPath(filePath)
      push({ name: displayName(basename(filePath)), url, origin: 'attached', time, messageIndex })
    }

    // Produced files, from the message body and from any tool output beside it.
    const haystacks = [message.text || '']
    for (const event of message.toolEvents || []) {
      if (event.output) haystacks.push(event.output)
    }
    for (const text of haystacks) {
      for (const match of text.matchAll(UPLOAD_URL)) {
        push({
          name: displayName(basename(match[1])),
          url: `/api/uploads/${match[1]}`,
          origin: 'produced',
          time,
          messageIndex,
        })
      }
    }
  })

  // Newest first: a file list is read to find the last thing produced.
  return out.sort((a, b) => b.time - a.time || b.messageIndex - a.messageIndex)
}

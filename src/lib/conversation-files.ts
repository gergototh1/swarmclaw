import type { Message } from '@/types'

/**
 * Every file a conversation has, recovered from the transcript.
 *
 * There is no file table for a session, so the transcript is the record, and it
 * carries these kinds of reference:
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
 * - WHAT A FILE-WRITING TOOL TOUCHED, from the `file_path` a `Write` or `Edit`
 *   call names in its own arguments. A CLI provider runs its tool loop outside
 *   this app and writes where the operator asked -- a project directory, not
 *   the upload store -- so the file stays where it belongs and the list points
 *   at it through `/api/files/serve` rather than at a copy that goes stale.
 *
 * - WHAT THE AGENT WROTE ABOUT, as a path inside a code span. This one is a
 *   READING of the text rather than a record of an action, and it is labelled
 *   `mentioned` for exactly that reason: it exists because a conversation held
 *   before the CLI providers forwarded their tool loop has no other trace of
 *   the files it produced. A path in running prose is still left alone.
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
  /**
   * Who put it in the conversation.
   *
   * `mentioned` is weaker than the other two on purpose: it is a path the agent
   * WROTE ABOUT, not one the transcript records it writing. A file it only read
   * lands here too, and the panel says so rather than calling it produced.
   */
  origin: 'attached' | 'produced' | 'mentioned'
  /** When it entered the conversation. */
  time: number
  /** Index of the message it came from, for jumping to it. */
  messageIndex: number
}

const UPLOAD_URL = /\/api\/uploads\/([A-Za-z0-9._%-]+)/g

/**
 * A path inside a code span, which is the one place a path is not prose.
 *
 * The same shape `FilePathChip` accepts (`file-path-chip.tsx`), and
 * deliberately so: what this lists is exactly what the transcript already
 * renders as a clickable chip, so the panel and the bubble never disagree
 * about what counts as a file.
 */
const BACKTICKED_PATH = /`(\/[\w./-]+\.\w{1,10})`/g

/**
 * The CLI tools that CREATE OR CHANGE a file, as opposed to reading one.
 *
 * `Read` carries a `file_path` too, and listing what an agent read as what it
 * produced is the wrong row this list must not have.
 */
const FILE_WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

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

/** The URL that serves a file from where it actually lives. */
function serveUrl(filePath: string, cwd?: string | null): string {
  const base = `/api/files/serve?path=${encodeURIComponent(filePath)}`
  return cwd ? `${base}&cwd=${encodeURIComponent(cwd)}` : base
}

/** The URL that serves a stored upload path. */
function urlForStoredPath(filePath: string): string {
  return `/api/uploads/${encodeURIComponent(basename(filePath))}`
}

export interface CollectOptions {
  /**
   * The session's working directory, for a path that is workspace-relative.
   * Passed through to the serve route exactly as `FilePathChip` passes it.
   */
  cwd?: string | null
}

export function collectConversationFiles(messages: Message[], options: CollectOptions = {}): ConversationFile[] {
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

    // What a file-writing tool touched. This is the exact source: the tool
    // named the path itself, so nothing here is read out of prose.
    for (const event of message.toolEvents || []) {
      if (!FILE_WRITING_TOOLS.has(event.name)) continue
      let filePath: unknown
      try {
        filePath = (JSON.parse(event.input || '{}') as { file_path?: unknown }).file_path
      } catch {
        continue
      }
      if (typeof filePath !== 'string' || !filePath) continue
      push({
        name: basename(filePath),
        url: serveUrl(filePath, options.cwd),
        origin: 'produced',
        time,
        messageIndex,
      })
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

    // Paths the agent wrote about. Weaker than the two above, and labelled as
    // such, so a conversation that predates tool capture is not empty -- a
    // claude-cli agent hands a file back by naming its path in the reply, and
    // before the provider forwarded its tool loop that sentence was the only
    // record there was. Runs after the tool events of the same message, so a
    // path that both a tool and the reply name is kept as produced.
    if (message.role === 'assistant') {
      for (const match of (message.text || '').matchAll(BACKTICKED_PATH)) {
        push({
          name: basename(match[1]),
          url: serveUrl(match[1], options.cwd),
          origin: 'mentioned',
          time,
          messageIndex,
        })
      }
    }
  })

  // Newest first: a file list is read to find the last thing produced.
  return out.sort((a, b) => b.time - a.time || b.messageIndex - a.messageIndex)
}

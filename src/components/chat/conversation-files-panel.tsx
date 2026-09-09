'use client'

import { useMemo } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'
import { collectConversationFiles, type ConversationFile } from '@/lib/conversation-files'

/**
 * The files this conversation carries, inside the inspector the Settings gear
 * already opens -- one panel, one place, rather than a second overlay with its
 * own shape.
 *
 * It reads the transcript, because that is where a session's files are
 * recorded; see `conversation-files.ts` for what counts and what deliberately
 * does not.
 */

function ext(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const IMAGE = /^(png|jpe?g|gif|webp|bmp|svg|avif|heic)$/

/**
 * `mentioned` says less than the other two, and says it plainly. The path came
 * out of the agent's own sentence, so the file may be one it only read -- the
 * row is honest about that instead of claiming the agent made it.
 */
const ORIGIN_LABEL: Record<ConversationFile['origin'], string> = {
  attached: 'csatolva',
  produced: 'az ügynök készítette',
  mentioned: 'a beszélgetésben említve',
}

function FileRow({ file }: { file: ConversationFile }) {
  const kind = ext(file.name)
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noreferrer"
      data-testid="conversation-file"
      className="flex items-center gap-3 px-3 py-2.5 rounded-md border-none bg-transparent
        hover:bg-layer-1 transition-colors cursor-pointer no-underline"
    >
      {IMAGE.test(kind) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={file.url} alt="" className="w-9 h-9 rounded-sm object-cover border border-line-subtle shrink-0" />
      ) : (
        <div className="w-9 h-9 rounded-sm bg-layer-2 border border-line-subtle flex items-center justify-center shrink-0">
          <span className="text-[9px] font-700 text-text-3 uppercase">{kind || 'file'}</span>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-text truncate">{file.name}</div>
        <div className="text-[10px] text-text-3">
          {ORIGIN_LABEL[file.origin]}
          {file.time ? ` · ${new Date(file.time).toLocaleString('hu-HU', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
        </div>
      </div>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3 shrink-0" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <path d="M15 3h6v6M10 14L21 3" />
      </svg>
    </a>
  )
}

export function ConversationFilesPanel() {
  const messages = useChatStore((s) => s.messages)
  // The session's working directory, so a workspace-relative path resolves.
  const cwd = useAppStore((s) => {
    const id = selectActiveSessionId(s)
    return id ? s.sessions[id]?.cwd ?? null : null
  })
  const files = useMemo(() => collectConversationFiles(messages, { cwd }), [messages, cwd])

  if (files.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-[13px] text-text-2">Ebben a beszélgetésben nincs fájl</p>
        <p className="mt-1.5 text-[11px] text-text-3 leading-relaxed">
          Itt jelenik meg, amit ide csatolsz, és amit az ügynök visszaad fájlként.
        </p>
      </div>
    )
  }

  return (
    <div className="px-2 py-2 flex flex-col gap-0.5">
      {files.map((file) => <FileRow key={file.url} file={file} />)}
    </div>
  )
}

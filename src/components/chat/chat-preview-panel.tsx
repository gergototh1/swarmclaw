'use client'

import { useCallback, useRef, useState } from 'react'
import { CodeBlock } from './code-block'
import { ExtensionToolPanel } from './extension-tool-panel'
import type { ChatPreviewContent } from '@/stores/use-chat-store'

interface Props {
  content: ChatPreviewContent
  onClose: () => void
  fullWidth?: boolean
}

export function ChatPreviewPanel({ content, onClose, fullWidth }: Props) {
  const initialWidth = content.type === 'extension' ? 480 : 400
  const [width, setWidth] = useState(initialWidth)
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(initialWidth)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const diff = startX.current - ev.clientX
      const next = Math.max(300, Math.min(window.innerWidth * 0.5, startWidth.current + diff))
      setWidth(next)
    }

    const handleMouseUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [width])

  return (
    <div
      className="relative flex flex-col border-l border-line-subtle bg-bg shrink-0"
      style={fullWidth ? { width: '100%', animation: 'fade-in 0.25s ease' } : { width, minWidth: 300, maxWidth: '50%', animation: 'fade-in 0.25s ease' }}
    >
      {/* Resize handle */}
      {!fullWidth && (
        <div
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent-bright/20 transition-colors z-10"
          onMouseDown={handleMouseDown}
        />
      )}

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line-subtle shrink-0">
        <span className="text-[12px] font-600 text-text-2 truncate flex-1">
          {content.title || 'Preview'}
        </span>
        {/*
          Where a panel puts its own header controls, so it does not have to
          draw a second full-width bar directly under this one. The node is
          handed to the panel, which portals into it — react-dom is one of the
          modules the host publishes to extension bundles, so a panel loaded
          from an extension bundle can use it too. A ref callback rather than
          an effect: React sets it during commit, so the panel gets the node
          on the render right after mount without a DOM query or a lookup id.
        */}
        <div ref={setHeaderSlot} className="flex items-center gap-1 shrink-0" />
        <button
          onClick={onClose}
          className="p-1 rounded-xs text-text-3 hover:text-text-2 hover:bg-layer-2 cursor-pointer border-none bg-transparent transition-colors"
          aria-label="Close preview"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0">
        {content.type === 'extension' && (
          <ExtensionToolPanel panelRef={content.ref} onClose={onClose} headerSlot={headerSlot} />
        )}
        {content.type !== 'extension' && content.type === 'browser' && content.url && (
          <iframe
            src={content.url}
            className="w-full h-full border-none"
            title={content.title || 'Browser Preview'}
            sandbox="allow-scripts allow-same-origin"
          />
        )}
        {content.type !== 'extension' && content.type === 'html' && content.content && (
          <iframe
            srcDoc={content.content}
            className="w-full h-full border-none"
            title={content.title || 'HTML Preview'}
            sandbox="allow-scripts"
          />
        )}
        {content.type !== 'extension' && content.type === 'image' && content.url && (
          <div className="p-4 flex items-center justify-center h-full">
            <img
              src={content.url}
              alt={content.title || 'Preview'}
              className="max-w-full max-h-full rounded-sm object-contain"
            />
          </div>
        )}
        {content.type !== 'extension' && content.type === 'code' && content.content && (
          <div className="p-2">
            <CodeBlock className={`language-${content.title?.split('.').pop() || 'text'}`}>
              {content.content}
            </CodeBlock>
          </div>
        )}
      </div>
    </div>
  )
}

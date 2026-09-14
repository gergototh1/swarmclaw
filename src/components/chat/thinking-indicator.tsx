'use client'

import { memo, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AiAvatar } from '@/components/shared/avatar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { useChatStore } from '@/stores/use-chat-store'

interface Props {
  assistantName?: string
  agentAvatarSeed?: string
  agentAvatarUrl?: string | null
  agentName?: string
}

// Shared by the elapsed-time label and the "still thinking" dot animation
// below, so a thinking phase has exactly one ticking timer instead of two.
function useElapsedSeconds(startTime: number) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!startTime) return
    // Renders whole seconds, so a 1s tick is enough -- 250ms just burned
    // extra renders for a value that only changes once a second. A new
    // thinking phase gets a fresh `startTime` from the store, which re-runs
    // this effect and starts the count (and the dot-bounce window) over.
    const tick = () => setElapsed(Math.floor((Date.now() - startTime) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [startTime])

  return elapsed
}

function ElapsedTimer({ elapsed }: { elapsed: number }) {
  if (!elapsed) return null
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  return (
    <span className="text-[10px] text-text-3 font-mono tabular-nums">
      {mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
    </span>
  )
}

export const ThinkingIndicator = memo(function ThinkingIndicator({ assistantName, agentAvatarSeed, agentAvatarUrl, agentName }: Props) {
  const { streamPhase, streamToolName, thinkingText, thinkingStartTime, agentStatus } = useChatStore(
    useShallow((s) => ({
      streamPhase: s.streamPhase,
      streamToolName: s.streamToolName,
      thinkingText: s.thinkingText,
      thinkingStartTime: s.thinkingStartTime,
      agentStatus: s.agentStatus,
    })),
  )

  const isQueued = streamPhase === 'queued'
  const statusText = isQueued
    ? 'Queued...'
    : streamPhase === 'tool' && streamToolName
      ? `Using ${streamToolName}...`
      : 'Thinking...'

  const hasThinkingContent = thinkingText.trim().length > 0
  const hasMission = !!agentStatus?.goal

  const elapsed = useElapsedSeconds(thinkingStartTime)
  // A long tool-heavy run can sit in a thinking phase for many minutes --
  // bouncing three dots the entire time is wasted compositing for feedback
  // the user already has from the status text and elapsed timer. Animate
  // only for the first 10s, then hold the dots static.
  const dotsBouncing = elapsed < 10
  const dotAnimation = (delay?: string) =>
    dotsBouncing ? { animation: `dot-bounce 1.2s ease-in-out infinite${delay ? ` ${delay}` : ''}` } : undefined

  return (
    <div className="flex flex-col items-start relative pl-[44px]"
      style={{ animation: 'msg-in-left 0.4s var(--ease-spring) both' }}>
      <div className="absolute left-[4px] top-0">
        {agentName ? <AgentAvatar seed={agentAvatarSeed || null} avatarUrl={agentAvatarUrl} name={agentName} size={28} /> : <AiAvatar size="sm" mood={isQueued ? 'thinking' : streamPhase === 'tool' ? 'tool' : 'thinking'} />}
      </div>
      
      <div className="flex items-center gap-2.5 mb-2 px-1">
        <span className="text-[12px] font-600 text-text-3">{assistantName || 'Claude'}</span>
        {agentStatus?.status && (
          <span className={`px-1.5 py-0.5 rounded-xs text-[9px] font-700 tracking-[0.03em] ${
            agentStatus.status === 'progress' ? 'bg-blue-500/10 text-blue-400' :
            agentStatus.status === 'ok' ? 'bg-emerald-500/10 text-emerald-400' :
            agentStatus.status === 'blocked' ? 'bg-red-500/10 text-red-400' :
            'bg-layer-2 text-text-3'
          }`} style={{ animation: 'spring-in 0.3s var(--ease-spring)' }}>
            {agentStatus.status}
          </span>
        )}
      </div>

      {hasMission && (
        <div className="mb-2 w-full max-w-[85%] md:max-w-[72%] p-3 rounded-lg border border-accent-bright/10 bg-accent-bright/[0.02]"
          style={{ animation: 'fade-up 0.4s var(--ease-spring)' }}>
          <div className="text-[10px] font-700 text-accent-bright/60 tracking-[0.03em] mb-1.5 flex items-center gap-2">
            <span className="w-1 h-1 rounded-full bg-accent-bright/40" />
            Active Mission
          </div>
          <p className="text-[13px] font-600 text-text-2 leading-snug">{agentStatus.goal}</p>
          {agentStatus.nextAction && (
            <div className="mt-2 pt-2 border-t border-line-subtle">
              <span className="text-[10px] font-600 text-text-3 block mb-0.5">Next Action</span>
              <p className="text-[11px] text-text-3 italic">&ldquo;{agentStatus.nextAction}&rdquo;</p>
            </div>
          )}
        </div>
      )}

      {hasThinkingContent ? (
        <details className="group/think w-full max-w-[85%] md:max-w-[72%]">
          <summary className="px-5 py-3.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden relative overflow-hidden border border-transparent hover:border-line-subtle transition-all">
            {/* Thinking pulse background -- only visible on hover, so the
                animation now runs only while it's actually shown instead of
                looping unseen for the whole thinking phase. */}
            <div className="absolute inset-0 bg-accent-bright/5 opacity-0 group-hover/think:opacity-100 transition-opacity group-hover/think:[animation:pulse-subtle_2s_ease-in-out_infinite]" />

            <div className="flex items-center gap-3 relative z-10">
              <div className="flex gap-2">
                <span className={`w-[6px] h-[6px] rounded-full ${isQueued ? 'bg-amber-400/70 ' : 'bg-accent-bright/60 '}`} style={dotAnimation()} />
                <span className={`w-[6px] h-[6px] rounded-full ${isQueued ? 'bg-amber-400/70 ' : 'bg-accent-bright/60 '}`} style={dotAnimation('0.15s')} />
                <span className={`w-[6px] h-[6px] rounded-full ${isQueued ? 'bg-amber-400/70 ' : 'bg-accent-bright/60 '}`} style={dotAnimation('0.3s')} />
              </div>
              <span className={`text-[12px] font-mono ${isQueued ? 'text-amber-300/70' : 'text-text-3/60'}`}>{statusText}</span>
              <ElapsedTimer elapsed={elapsed} />
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                className="shrink-0 text-text-3 transition-transform duration-200 group-open/think:rotate-180 ml-auto"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </summary>
          <div className="px-4 py-3 rounded-md bg-bg border border-line-subtle max-h-[300px] overflow-y-auto">
            <div className="msg-content text-[13px] leading-[1.6] text-text-3">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {thinkingText}
              </ReactMarkdown>
            </div>
          </div>
        </details>
      ) : (
        <div className="border border-line-subtle bg-layer-1 rounded-md px-6 py-5 relative overflow-hidden">
          {/* Thinking glow effect */}
          
          <div className="flex items-center gap-3 relative z-10">
            <div className="flex gap-2">
              <span className={`w-[6px] h-[6px] rounded-full ${isQueued ? 'bg-amber-400/70 ' : 'bg-accent-bright/60 '}`} style={dotAnimation()} />
              <span className={`w-[6px] h-[6px] rounded-full ${isQueued ? 'bg-amber-400/70 ' : 'bg-accent-bright/60 '}`} style={dotAnimation('0.15s')} />
              <span className={`w-[6px] h-[6px] rounded-full ${isQueued ? 'bg-amber-400/70 ' : 'bg-accent-bright/60 '}`} style={dotAnimation('0.3s')} />
            </div>
            <span className={`text-[12px] font-mono ${isQueued ? 'text-amber-300/70' : 'text-text-3/60'}`}>{statusText}</span>
            <ElapsedTimer elapsed={elapsed} />
          </div>
        </div>
      )}
    </div>
  )
})

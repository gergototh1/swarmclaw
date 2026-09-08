'use client'

import { useCallback, useId, useState } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { StepShell } from './shared'

export interface StepProfileProps {
  onContinue: (userName: string, avatarSeed: string) => void
  onSkip: () => void
}

export function StepProfile({ onContinue, onSkip }: StepProfileProps) {
  const [name, setName] = useState('')
  const defaultAvatarSeed = useId().replace(/:/g, '')
  const [avatarSeed, setAvatarSeed] = useState(defaultAvatarSeed)
  const [seedOpen, setSeedOpen] = useState(false)

  const hasName = name.trim().length > 0

  const randomizeSeed = useCallback(() => {
    setAvatarSeed(Math.random().toString(36).slice(2, 10))
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!hasName) return
    onContinue(name.trim().toLowerCase(), avatarSeed.trim() || defaultAvatarSeed)
  }

  return (
    <StepShell>
      {/* Avatar hero */}
      <div className="flex justify-center mb-8">
        <div className="relative group">
          <div
            className="absolute inset-[-12px] rounded-full transition-all duration-700"
            style={{
              background: hasName
                ? 'conic-gradient(from 0deg, rgba(99,102,241,0.15), rgba(236,72,153,0.1), rgba(52,211,153,0.1), rgba(99,102,241,0.15))'
                : 'conic-gradient(from 0deg, rgba(99,102,241,0.06), transparent, rgba(99,102,241,0.06))',
              animation: 'sparkle-spin 8s linear infinite',
              filter: 'blur(8px)',
            }}
          />
          <div
            className="absolute inset-[-4px] rounded-full transition-all duration-500"
            style={{
              border: '1px solid',
              borderColor: hasName ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.06)',
            }}
          />
          <div className="relative">
            <AgentAvatar seed={avatarSeed || null} name={name || '?'} size={96} />
          </div>

          <button
            type="button"
            onClick={randomizeSeed}
            className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-surface border border-line-default
              flex items-center justify-center cursor-pointer
              hover:bg-layer-3 hover:border-accent-bright/30 active:scale-90
              transition-all duration-200 z-10"
            title="Randomize avatar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3">
              <rect x="2" y="2" width="20" height="20" rx="3" />
              <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
              <circle cx="16" cy="8" r="1.5" fill="currentColor" stroke="none" />
              <circle cx="8" cy="16" r="1.5" fill="currentColor" stroke="none" />
              <circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none" />
            </svg>
          </button>
        </div>
      </div>

      <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-2">
        Welcome
      </h1>
      <p className="text-[15px] text-text-2 mb-8">
        What should we call you?
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col items-center gap-5">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoFocus
          className="w-full max-w-[300px] px-6 py-4 rounded-lg border border-line-default bg-surface
            text-text text-[18px] text-center font-display font-600 outline-none
            transition-all duration-200 placeholder:text-text-3
            focus:border-accent-bright/30 focus:shadow-[0_0_0_3px_var(--color-accent-glow)]"
        />

        {!seedOpen ? (
          <button
            type="button"
            onClick={() => setSeedOpen(true)}
            className="bg-transparent border-none text-[12px] text-text-3 cursor-pointer hover:text-text-2 transition-colors"
          >
            Customize avatar seed
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={avatarSeed}
              onChange={(e) => setAvatarSeed(e.target.value)}
              placeholder="Avatar seed"
              className="w-[160px] px-3 py-2 rounded-sm border border-line-default bg-surface
                text-text text-[13px] text-center outline-none transition-all
                focus:border-accent-bright/30"
            />
            <button
              type="button"
              onClick={randomizeSeed}
              className="px-3 py-2 rounded-sm border border-line-default bg-transparent text-text-3 text-[12px] font-600
                cursor-pointer transition-all hover:bg-layer-2 shrink-0"
            >
              Randomize
            </button>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onSkip}
            className="px-6 py-3.5 rounded-md border border-line-default bg-transparent text-text-2 text-[14px]
              font-display font-500 cursor-pointer hover:bg-layer-1 transition-all duration-200"
          >
            Skip for now
          </button>
          <button
            type="submit"
            disabled={!hasName}
            className="px-10 py-3.5 rounded-md border-none bg-accent-bright text-accent-fg text-[15px] font-display font-600
              cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
              disabled:opacity-30"
          >
            Continue
          </button>
        </div>
      </form>
    </StepShell>
  )
}

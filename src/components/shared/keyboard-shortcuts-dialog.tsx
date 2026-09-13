'use client'

import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

interface Shortcut {
  keys: string[]
  description: string
}

interface ShortcutGroup {
  title: string
  shortcuts: Shortcut[]
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)
const MOD = isMac ? '\u2318' : 'Ctrl'
const ALT = isMac ? '\u2325' : 'Alt'

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    shortcuts: [
      { keys: [MOD, 'K'], description: 'Open search' },
      { keys: [MOD, 'Shift', 'A'], description: 'Switch agent' },
      { keys: [MOD, 'N'], description: 'New chat' },
      { keys: [MOD, 'Shift', 'T'], description: 'Jump to tasks (not in the desktop app)' },
    ],
  },
  {
    // The browser keeps Cmd/Ctrl+T, W and Tab for itself, so tabs use Option/Alt there.
    title: 'Tabs (browser)',
    shortcuts: [
      { keys: [ALT, 'T'], description: 'New tab' },
      { keys: [ALT, 'W'], description: 'Close tab' },
      { keys: [ALT, 'Shift', 'T'], description: 'Reopen closed tab' },
      { keys: [ALT, '\u2190'], description: 'Previous tab' },
      { keys: [ALT, '\u2192'], description: 'Next tab' },
      { keys: [ALT, '1\u20139'], description: 'Go to tab (9 is the last)' },
    ],
  },
  {
    // electron/tab-menu.ts and electron/menu.ts.
    title: 'Tabs (desktop app)',
    shortcuts: [
      { keys: [MOD, 'T'], description: 'New tab' },
      { keys: [MOD, 'W'], description: 'Close tab' },
      { keys: [MOD, 'Shift', 'T'], description: 'Reopen closed tab' },
      { keys: ['Ctrl', 'Tab'], description: 'Next tab' },
      { keys: ['Ctrl', 'Shift', 'Tab'], description: 'Previous tab' },
      { keys: [MOD, '1\u20139'], description: 'Go to tab (9 is the last)' },
      { keys: [MOD, 'Shift', 'W'], description: 'Close window' },
    ],
  },
  {
    title: 'Chat',
    shortcuts: [
      { keys: ['Enter'], description: 'Send message' },
      { keys: ['Shift', 'Enter'], description: 'New line' },
      { keys: ['Esc'], description: 'Cancel reply / close' },
    ],
  },
  {
    title: 'General',
    shortcuts: [
      { keys: ['?'], description: 'Show keyboard shortcuts' },
    ],
  },
]

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-xs bg-layer-3 border border-line-default text-[11px] font-mono text-text-2 leading-none">
      {children}
    </kbd>
  )
}

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+/ or Cmd+/
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setOpen((v) => !v)
        return
      }
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if ((e.target as HTMLElement)?.isContentEditable) return
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[420px] p-0 bg-surface/80 backdrop-blur-xl border-line-subtle rounded-lg overflow-hidden gap-0"
      >
        <DialogTitle className="sr-only">Keyboard shortcuts</DialogTitle>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line-subtle">
          <span className="text-[14px] font-600 text-text">Keyboard Shortcuts</span>
          <kbd className="px-1.5 py-0.5 rounded-xs bg-layer-2 border border-line-default text-[10px] font-mono text-text-3">
            ESC
          </kbd>
        </div>
        <div className="py-2 max-h-[400px] overflow-y-auto">
          {GROUPS.map((group) => (
            <div key={group.title} className="px-5 py-2">
              <h3 className="text-[11px] font-700 tracking-[0.03em] text-text-3 mb-2">
                {group.title}
              </h3>
              <div className="flex flex-col gap-1.5">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between py-1"
                  >
                    <span className="text-[13px] text-text-2">{shortcut.description}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, i) => (
                        <Kbd key={i}>{key}</Kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

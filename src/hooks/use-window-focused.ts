'use client'

import { useSyncExternalStore } from 'react'

function subscribe(cb: () => void) {
  window.addEventListener('focus', cb)
  window.addEventListener('blur', cb)
  return () => {
    window.removeEventListener('focus', cb)
    window.removeEventListener('blur', cb)
  }
}

/**
 * A fokusz pillanatkepe. Kulon exportalva, mert ez a resz tesztelheto React es
 * DOM-kornyezet nelkul is.
 *
 * SSR-en `true`: a szerveren nincs ablak, es a `false` azt jelentene, hogy
 * minden chat olvasatlanul renderelodik elso festeskor.
 */
export function focusedSnapshot(): boolean {
  if (typeof document === 'undefined') return true
  return document.hasFocus()
}

function getServerSnapshot(): boolean {
  return true
}

/** `true`, amig ez az ablak a fokuszalt. Nem ugyanaz, mint `usePageActive`. */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, focusedSnapshot, getServerSnapshot)
}

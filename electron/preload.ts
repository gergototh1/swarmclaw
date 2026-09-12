import { contextBridge, ipcRenderer } from 'electron'

/**
 * A single narrow surface. `contextIsolation` stays on, so the renderer has
 * no access to any Node API beyond exactly this.
 *
 * Named `swarmclawDesktop`, deliberately NOT `swarmclaw`: `window.swarmclaw`
 * is already owned by the extension-page API surface built by
 * `getHostRegistry()` in `src/components/layout/extension-host.tsx`. That
 * function does `const existing = window.swarmclaw; if (existing) return
 * existing` -- if this preload claimed the bare `swarmclaw` name, it would run
 * before the extension host in the desktop app, and every extension page
 * would be handed this two-method notification bridge instead of the real
 * registry, then crash calling `host.onPageRegistered(...)`. Do not rename
 * this back to `swarmclaw` to "tidy" it -- see
 * `electron/preload.test.ts` for the regression test that guards this.
 */
contextBridge.exposeInMainWorld('swarmclawDesktop', {
  notify: (payload: { sessionId: string; title: string; body: string; isError: boolean }) => {
    ipcRenderer.send('swarmclaw:notify', payload)
  },
  onOpenChat: (cb: (sessionId: string) => void) => {
    const handler = (_e: unknown, sessionId: string) => cb(sessionId)
    ipcRenderer.on('swarmclaw:open-chat', handler)
    return () => {
      ipcRenderer.off('swarmclaw:open-chat', handler)
    }
  },
  savePdf: (input: { html: string; fileName: string }): Promise<{ saved: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('swarmclaw:save-pdf', input),
})

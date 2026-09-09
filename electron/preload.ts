import { contextBridge, ipcRenderer } from 'electron'

/**
 * A single narrow surface. `contextIsolation` stays on, so the renderer has
 * no access to any Node API beyond exactly this.
 */
contextBridge.exposeInMainWorld('swarmclaw', {
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
})

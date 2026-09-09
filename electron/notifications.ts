import { BrowserWindow, Notification } from 'electron'
import type { NotificationPayload } from './notification-payload'

/**
 * The click handler lives in the main process because `win.show()` /
 * `win.focus()` from the renderer are not reliable for a backgrounded window.
 */
export function showReplyNotification(
  win: BrowserWindow | null,
  sessionId: string,
  payload: NotificationPayload,
): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title: payload.title, body: payload.body })
  notification.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('swarmclaw:open-chat', sessionId)
  })
  notification.show()
}

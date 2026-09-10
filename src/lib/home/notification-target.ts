import type { AppNotification } from '@/types'

/**
 * Where a "Needs you" notification row should send the user.
 *
 * Rows that go nowhere are the reason this exists: a notification the user
 * cannot act on is noise, and the gateway-down notices that dominate this
 * list carried neither `actionUrl` nor `entityId` when the row was first
 * built, so it rendered as a dead `<div>` among clickable siblings.
 *
 * `actionUrl` wins when the producer set one. Otherwise an entity link is
 * reconstructed from `entityType`/`entityId` for the entity kinds that have
 * their own route. Anything else returns null and the caller renders a
 * non-interactive row rather than a button that lies about being clickable.
 */
export function notificationHref(notification: AppNotification): string | null {
  const action = notification.actionUrl?.trim()
  if (action) return action

  const id = notification.entityId?.trim()
  if (!id) return null

  switch (notification.entityType) {
    case 'agent': return `/agents/${encodeURIComponent(id)}`
    case 'session': return `/chat/${encodeURIComponent(id)}`
    case 'chatroom': return `/chatrooms/${encodeURIComponent(id)}`
    default: return null
  }
}

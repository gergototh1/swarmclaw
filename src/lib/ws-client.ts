import { jitteredBackoff, hmrSingleton } from '@/lib/shared-utils'

type WsCallback = () => void

const MAX_RECONNECT_DELAY = 30_000

/**
 * The socket and everything that describes its state.
 *
 * A Next.js hot reload re-executes this module, and bare module-level `let`s
 * would come back at their initial values while the real socket carried on
 * open. `connected` is the one that hurts: `isWsConnected()` would answer false
 * for a live connection, so every subscription would start a fallback poll next
 * to a socket that is already delivering. The reconnect bookkeeping is in here
 * for the same reason — a timer the reloaded module has forgotten about would
 * schedule a second connect on top of the first.
 */
const socket = hmrSingleton('wsClient_socket', () => ({
  ws: null as WebSocket | null,
  enabled: false,
  connected: false,
  reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  reconnectAttempt: 0,
}))
const listeners = hmrSingleton('wsClient_listeners', () => new Map<string, Set<WsCallback>>())
const connectionStateListeners = hmrSingleton('wsClient_connectionStateListeners', () => new Set<() => void>())

function getWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:3457/ws'

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const pagePort = window.location.port
  const buildPort = process.env.NEXT_PUBLIC_WS_PORT || '3457'

  // If the page was loaded on a standard HTTP port (80/443/empty) or a port
  // that doesn't match the expected app port, we're likely behind a reverse
  // proxy. Use the page's host directly so the proxy can route /ws traffic.
  const appPort = String((Number(buildPort) || 3457) - 1) // e.g. 3456
  const behindProxy = !pagePort || pagePort === '80' || pagePort === '443' || pagePort !== appPort
  const wsHost = behindProxy ? window.location.host : `${window.location.hostname}:${buildPort}`

  return `${protocol}://${wsHost}/ws`
}

function handleMessage(event: MessageEvent) {
  try {
    const msg = JSON.parse(event.data)
    const topic = msg.topic as string
    if (!topic) return
    const cbs = listeners.get(topic)
    if (cbs) {
      for (const cb of cbs) cb()
    }
  } catch {
    // ignore malformed
  }
}

function scheduleReconnect() {
  if (socket.reconnectTimer) return
  const delay = jitteredBackoff(1000, socket.reconnectAttempt, MAX_RECONNECT_DELAY)
  socket.reconnectAttempt++
  socket.reconnectTimer = setTimeout(() => {
    socket.reconnectTimer = null
    if (!socket.enabled) return
    connect()
  }, delay)
}

function connect() {
  if (!socket.enabled) return
  if (socket.ws && (socket.ws.readyState === WebSocket.OPEN || socket.ws.readyState === WebSocket.CONNECTING)) return

  let ws: WebSocket
  try {
    ws = new WebSocket(getWsUrl())
  } catch {
    scheduleReconnect()
    return
  }
  socket.ws = ws

  ws.onopen = () => {
    socket.connected = true
    for (const cb of connectionStateListeners) cb()
    socket.reconnectAttempt = 0
    // Subscribe to all currently registered topics
    const topics = Array.from(listeners.keys())
    if (topics.length > 0) {
      ws.send(JSON.stringify({ type: 'subscribe', topics }))
    }
  }

  ws.onmessage = handleMessage

  ws.onclose = () => {
    socket.connected = false
    for (const cb of connectionStateListeners) cb()
    if (socket.ws === ws) socket.ws = null
    if (socket.enabled) scheduleReconnect()
  }

  ws.onerror = () => {
    // onclose will fire after this
  }
}

export function connectWs() {
  socket.enabled = true
  socket.reconnectAttempt = 0
  connect()
}

export function disconnectWs() {
  socket.enabled = false
  if (socket.reconnectTimer) {
    clearTimeout(socket.reconnectTimer)
    socket.reconnectTimer = null
  }
  if (socket.ws) {
    socket.ws.onclose = null
    socket.ws.close()
    socket.ws = null
  }
  socket.connected = false
}

export function subscribeWs(topic: string, callback: WsCallback) {
  let set = listeners.get(topic)
  const isNew = !set
  if (!set) {
    set = new Set()
    listeners.set(topic, set)
  }
  set.add(callback)

  // Tell server about new topic subscription
  if (isNew && socket.ws?.readyState === WebSocket.OPEN) {
    socket.ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }))
  }
}

export function unsubscribeWs(topic: string, callback: WsCallback) {
  const set = listeners.get(topic)
  if (!set) return
  set.delete(callback)
  if (set.size === 0) {
    listeners.delete(topic)
    if (socket.ws?.readyState === WebSocket.OPEN) {
      socket.ws.send(JSON.stringify({ type: 'unsubscribe', topics: [topic] }))
    }
  }
}

export function isWsConnected(): boolean {
  return socket.connected
}

export function onWsStateChange(cb: () => void): void {
  connectionStateListeners.add(cb)
}

export function offWsStateChange(cb: () => void): void {
  connectionStateListeners.delete(cb)
}

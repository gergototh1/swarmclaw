/**
 * Ertesitendo-e egy beerkezett ugynok-valasz.
 *
 * EGY DONTESBOL SZARMAZIK A JELZES ES A PUSH IS. Amit a lista olvasottnak
 * tekint (aktiv chat + fokusz), arrol nem megy ertesites -- kulonben a ketto
 * ellentmondana egymasnak.
 */
export interface NotificationGateInput {
  globalEnabled: boolean
  agentMuted: boolean
  isActiveSession: boolean
  windowFocused: boolean
}

export function shouldNotifyForReply(input: NotificationGateInput): boolean {
  if (!input.globalEnabled) return false
  if (input.agentMuted) return false
  if (input.isActiveSession && input.windowFocused) return false
  return true
}

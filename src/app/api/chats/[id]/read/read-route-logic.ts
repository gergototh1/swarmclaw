import type { Session } from '@/types'

/**
 * A jelolo logika a route-tol kulon, hogy tesztelheto legyen HTTP nelkul.
 * A `patch` seam a `patchSession`; a teszt sajatot ad be.
 */
export interface MarkReadDeps {
  patch: (id: string, updater: (current: Session | null) => Session | null) => Session | null
}

export function markSessionRead(id: string, deps: MarkReadDeps): { ok: true; lastReadAt: number } | null {
  const lastReadAt = Date.now()
  const next = deps.patch(id, (current) => {
    if (!current) return null
    return { ...current, lastReadAt }
  })
  return next ? { ok: true, lastReadAt } : null
}

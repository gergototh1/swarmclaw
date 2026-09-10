'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type { AppView } from '@/types'

const VIEW_TO_PATH: Record<AppView, string> = {
  home: '/home',
  conversations: '/chat',
  agents: '/agents',
  org_chart: '/org-chart',
  inbox: '/inbox',
  chatrooms: '/chatrooms',
  protocols: '/protocols',
  schedules: '/schedules',
  memory: '/memory',

  tasks: '/tasks',
  quality: '/quality',
  missions: '/missions',
  vault: '/vault',
  providers: '/providers',
  skills: '/skills',
  connectors: '/connectors',
  webhooks: '/webhooks',
  mcp_servers: '/mcp-servers',
  knowledge: '/knowledge',
  extensions: '/extensions',
  usage: '/usage',
  stream: '/stream',
  autonomy: '/autonomy',
  settings: '/settings',
  projects: '/projects',
  swarmfeed: '/swarmfeed',
  marketplace: '/marketplace',
}

/** Build a URL path for a given view, optionally with an entity ID. */
export function getViewPath(view: AppView, id?: string | null): string {
  const base = VIEW_TO_PATH[view]
  if (id && (view === 'agents' || view === 'chatrooms' || view === 'conversations')) {
    return `${base}/${encodeURIComponent(id)}`
  }
  return base
}

/** Map a pathname back to an AppView. Returns null for unknown paths. */
export function pathToView(pathname: string): AppView | null {
  for (const [view, path] of Object.entries(VIEW_TO_PATH)) {
    if (pathname === path || pathname.startsWith(path + '/')) {
      return view as AppView
    }
  }
  return null
}

/** Views whose path carries a trailing entity id. Mirrors `getViewPath`. */
const ID_BEARING_VIEWS: ReadonlySet<AppView> = new Set<AppView>(['agents', 'chatrooms', 'conversations'])

/**
 * Split a pathname into the view it renders and the entity id it addresses.
 *
 * The inverse of `getViewPath`, and the reason the path table stays private to
 * this module: a second copy of it elsewhere is a second thing to keep in sync
 * when a route moves.
 */
export function parseViewPath(pathname: string): { view: AppView; id: string | null } | null {
  const view = pathToView(pathname)
  if (!view) return null
  if (!ID_BEARING_VIEWS.has(view)) return { view, id: null }
  const base = VIEW_TO_PATH[view]
  if (!pathname.startsWith(base + '/')) return { view, id: null }
  const raw = pathname.slice(base.length + 1)
  if (!raw) return { view, id: null }
  try {
    return { view, id: decodeURIComponent(raw) }
  } catch {
    return { view, id: raw }
  }
}

/**
 * Resolve which `AppView`, if any, the sidebar rail should render as active
 * for a given pathname. Returns `null` for any path that isn't a registered
 * `AppView` — an extension page under `/x/`, for instance.
 *
 * Nothing highlighted is the correct behavior for those paths. Falling back to
 * `'home'` would light up the wrong rail entry for every unrecognized route,
 * present or future — that regression is exactly what this function, and its
 * test, exist to keep from coming back.
 */
export function resolveSidebarActiveView(pathname: string): AppView | null {
  return pathToView(pathname)
}

/** Hook for navigating between views using Next.js router. */
export function useNavigate() {
  const router = useRouter()

  const navigateTo = useCallback((view: AppView, id?: string | null) => {
    router.push(getViewPath(view, id))
  }, [router])

  return navigateTo
}

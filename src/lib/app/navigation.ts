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

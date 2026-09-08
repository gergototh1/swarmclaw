import type { RouteTab } from '@/components/shared/route-tabs'

/**
 * The launchpad and the social feed, as two views of one landing surface.
 *
 * Both stay real routes rather than one page with local state: FeedPage is
 * large enough that folding it into home/page.tsx would grow an already big
 * file, and /swarmfeed is linkable from agent posts.
 */
export const HOME_TABS: readonly RouteTab[] = [
  { key: 'home', label: 'Overview', href: '/home' },
  { key: 'feed', label: 'Feed', href: '/swarmfeed' },
]

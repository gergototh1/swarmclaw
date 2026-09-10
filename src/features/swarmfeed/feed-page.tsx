'use client'

import { useDeferredValue, useEffect, useState, type ReactNode } from 'react'
import { Activity as ActivityIcon, Bell, Hash, Search, Sparkles, TrendingUp, Users } from 'lucide-react'
import { toast } from 'sonner'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { MainContent } from '@/components/layout/main-content'
import { PageLoader } from '@/components/ui/page-loader'
import { useAppStore } from '@/stores/use-app-store'
import { useNow } from '@/hooks/use-now'
import { timeAgo } from '@/lib/time-format'
import { ComposePost } from './compose-post'
import { PostCard, type PostCardAction } from './post-card'
import { PostThreadSheet } from './post-thread-sheet'
import { SwarmFeedProfileSheet } from './profile-sheet'
import {
  useSwarmFeedActionMutation,
  useSwarmFeedBookmarksQuery,
  useSwarmFeedChannelsQuery,
  useSwarmFeedFeedQuery,
  useSwarmFeedNotificationsQuery,
  useSwarmFeedSearchQuery,
  useSwarmFeedSuggestedQuery,
} from './queries'
import type { Agent, ActivityEntry } from '@/types'
import type {
  FeedType,
  SwarmFeedAgentSummary,
  SwarmFeedNotification,
  SwarmFeedPost,
  SwarmFeedSearchType,
} from '@/types/swarmfeed'

type FeedTab = 'for_you' | 'following' | 'trending' | 'bookmarks' | 'notifications' | 'activity'

const FEED_TABS: Array<{ key: FeedTab; label: string; icon: typeof Sparkles }> = [
  { key: 'for_you', label: 'For You', icon: Sparkles },
  { key: 'following', label: 'Following', icon: Users },
  { key: 'trending', label: 'Trending', icon: TrendingUp },
  { key: 'bookmarks', label: 'Bookmarks', icon: Hash },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'activity', label: 'Activity', icon: ActivityIcon },
]

/**
 * Workspace activity (agents/tasks/connectors CRUD) — moved here from
 * /home, which used to carry its own copy. This is unrelated to SwarmFeed's
 * own agent-to-agent `notifications` tab above; it's the audit-log style
 * feed of what changed across the workspace.
 */
const ACTIVITY_ICONS: Record<ActivityEntry['action'], string> = {
  created: 'M12 5v14m-7-7h14',
  updated: 'M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z',
  deleted: 'M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  archived: 'M3 7h18M6 7v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7m-9 4h6',
  restored: 'M4 12a8 8 0 1 0 2.34-5.66M4 4v6h6',
  started: 'M5 3l14 9-14 9V3z',
  stopped: 'M6 4h4v16H6zm8 0h4v16h-4z',
  queued: 'M12 6v6l4 2',
  completed: 'M20 6L9 17l-5-5',
  failed: 'M18 6L6 18M6 6l12 12',
  approved: 'M22 11.08V12a10 10 0 1 1-5.93-9.14',
  rejected: 'M10 15l5-5m0 5l-5-5',
  delegated: 'M7 17l9.2-9.2M17 17V7H7',
  queried: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  spawned: 'M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-5.07l-2.83 2.83M9.76 14.24l-2.83 2.83m11.14 0l-2.83-2.83M9.76 9.76L6.93 6.93',
  timeout: 'M12 6v6l4 2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',
  cancelled: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m5 5L7 17',
  incident: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4m0 4h.01',
  running: 'M12 2v4m0 12v4m10-10h-4M6 12H2',
  claimed: 'M9 12l2 2 4-4m6 2a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  configured: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  budget_exceeded: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 6v4m0 4h.01',
  budget_warning: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4m0 4h.01',
}

const ACTIVITY_COLORS: Record<string, string> = {
  created: 'text-emerald-400',
  updated: 'text-sky-400',
  deleted: 'text-red-400',
  archived: 'text-amber-300',
  restored: 'text-sky-300',
  started: 'text-emerald-400',
  stopped: 'text-text-3',
  queued: 'text-amber-400',
  completed: 'text-emerald-400',
  failed: 'text-red-400',
  approved: 'text-emerald-400',
  rejected: 'text-red-400',
  delegated: 'text-purple-400',
  queried: 'text-sky-400',
  spawned: 'text-purple-400',
  timeout: 'text-amber-400',
  cancelled: 'text-gray-400',
  incident: 'text-red-400',
  running: 'text-blue-400',
  claimed: 'text-emerald-400',
}

const SEARCH_FILTERS: Array<{ key?: SwarmFeedSearchType; label: string }> = [
  { label: 'All' },
  { key: 'posts', label: 'Posts' },
  { key: 'agents', label: 'Agents' },
  { key: 'channels', label: 'Channels' },
  { key: 'hashtags', label: 'Hashtags' },
]

function isFeedTab(tab: FeedTab): tab is Extract<FeedType, FeedTab> {
  return tab === 'for_you' || tab === 'following' || tab === 'trending'
}

function formatTimestamp(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

/**
 * `topBar` lets the caller slot in navigation (the Home/Feed RouteTabs) above
 * the feed body without FeedPage itself depending on an app-route tab table.
 * It renders inside FeedPage's own MainContent, after the MobileHeader,
 * NetworkBanner and UpdateBanner that MainContent supplies, so a caller can't
 * accidentally push those below it.
 */
export function FeedPage({ topBar }: { topBar?: ReactNode } = {}) {
  const agents = useAppStore((s) => s.agents)
  const activityEntries = useAppStore((s) => s.activityEntries)
  const loadActivity = useAppStore((s) => s.loadActivity)
  const now = useNow()
  const feedAgents = Object.values(agents).filter(
    (agent: Agent) => agent.swarmfeedEnabled && !agent.disabled && !agent.trashedAt,
  )

  useEffect(() => {
    void loadActivity({ limit: 8 })
  }, [loadActivity])

  const [activeTab, setActiveTab] = useState<FeedTab>('for_you')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchType, setSearchType] = useState<SwarmFeedSearchType | undefined>()
  const [threadState, setThreadState] = useState<{ postId: string; mode: 'reply' | 'quote' } | null>(null)
  const [profileAgentId, setProfileAgentId] = useState<string | null>(null)

  const deferredSearchQuery = useDeferredValue(searchQuery.trim())
  const resolvedSelectedAgentId = selectedAgentId && feedAgents.some((agent) => agent.id === selectedAgentId)
    ? selectedAgentId
    : (feedAgents[0]?.id || '')
  const selectedAgent = resolvedSelectedAgentId ? agents[resolvedSelectedAgentId] : null
  const isSearching = deferredSearchQuery.length >= 2
  const currentFeedType = isFeedTab(activeTab) ? activeTab : 'for_you'
  const requiresActor = activeTab === 'following' || activeTab === 'bookmarks' || activeTab === 'notifications'

  const channelsQuery = useSwarmFeedChannelsQuery()
  const feedQuery = useSwarmFeedFeedQuery({
    type: currentFeedType,
    agentId: activeTab === 'following' ? resolvedSelectedAgentId : undefined,
    enabled: !isSearching && isFeedTab(activeTab) && (activeTab !== 'following' || !!resolvedSelectedAgentId),
  })
  const bookmarksQuery = useSwarmFeedBookmarksQuery(resolvedSelectedAgentId, !isSearching && activeTab === 'bookmarks')
  const notificationsQuery = useSwarmFeedNotificationsQuery(resolvedSelectedAgentId, !isSearching && activeTab === 'notifications')
  const suggestedQuery = useSwarmFeedSuggestedQuery(resolvedSelectedAgentId || undefined, true)
  const searchResultsQuery = useSwarmFeedSearchQuery({
    query: deferredSearchQuery,
    type: searchType,
    enabled: isSearching,
  })
  const actionMutation = useSwarmFeedActionMutation()

  const channels = channelsQuery.data || []
  const channelLabels = Object.fromEntries(
    channels.map((channel) => [channel.id, `#${channel.handle}`]),
  )

  async function handlePostAction(action: PostCardAction, post: SwarmFeedPost) {
    if (!resolvedSelectedAgentId) {
      throw new Error('Select an acting agent before interacting with SwarmFeed.')
    }
    try {
      await actionMutation.mutateAsync({
        action,
        agentId: resolvedSelectedAgentId,
        postId: post.id,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to update SwarmFeed action'
      toast.error(message)
      throw err
    }
  }

  async function handleFollow(targetAgentId: string) {
    if (!resolvedSelectedAgentId) {
      toast.error('Select an acting agent before following other agents.')
      return
    }
    try {
      await actionMutation.mutateAsync({
        action: 'follow',
        agentId: resolvedSelectedAgentId,
        targetAgentId,
      })
      toast.success('Agent followed')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to follow agent')
    }
  }

  function renderPosts(posts: SwarmFeedPost[]) {
    if (posts.length === 0) {
      return (
        <EmptyState
          title="Nothing here yet"
          description="The feed is quiet right now. Try another tab, run a search, or direct one of your agents to publish an update."
        />
      )
    }

    return (
      <div className="space-y-4">
        {posts.map((post) => (
          <PostCard
            key={post.id}
            post={post}
            channelLabel={post.channelId ? channelLabels[post.channelId] : null}
            canInteract={!!resolvedSelectedAgentId}
            onAction={handlePostAction}
            onProfileOpen={setProfileAgentId}
            onThreadOpen={(postId, mode = 'reply') => setThreadState({ postId, mode })}
          />
        ))}
      </div>
    )
  }

  function renderMainColumn() {
    if (isSearching) {
      if (searchResultsQuery.isLoading) return <PageLoader />
      if (searchResultsQuery.error) {
        return (
          <ErrorState
            message={searchResultsQuery.error instanceof Error ? searchResultsQuery.error.message : 'Failed to search SwarmFeed'}
            onRetry={() => { void searchResultsQuery.refetch() }}
          />
        )
      }

      const result = searchResultsQuery.data
      return (
        <div className="space-y-5">
          <div className="rounded-lg border border-line-subtle bg-surface p-4">
            <div className="text-[11px] font-700 tracking-[0.03em] text-text-3">Search Results</div>
            <div className="mt-2 text-[14px] text-text">
              {result?.total || 0} result{result?.total === 1 ? '' : 's'} for <span className="font-700 text-accent-bright">{deferredSearchQuery}</span>
            </div>
          </div>

          {result?.posts?.length ? (
            <section className="space-y-4">
              <SectionTitle>Posts</SectionTitle>
              {renderPosts(result.posts)}
            </section>
          ) : null}

          {result?.agents?.length ? (
            <section className="space-y-3">
              <SectionTitle>Agents</SectionTitle>
              <div className="grid gap-3 sm:grid-cols-2">
                {result.agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => setProfileAgentId(agent.id)}
                    className="cursor-pointer rounded-lg border border-line-subtle bg-surface p-4 text-left transition-all hover:bg-surface"
                  >
                    <div className="flex items-start gap-3">
                      <AgentAvatar seed={agent.id} avatarUrl={agent.avatar || null} name={agent.name} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-700 text-text">{agent.name}</div>
                        <div className="mt-1 text-[11px] tracking-[0.03em] text-text-3">
                          {agent.framework || 'unknown'}
                        </div>
                        {agent.bio && (
                          <p className="mt-2 line-clamp-3 text-[12px] leading-[1.6] text-text-3">{agent.bio}</p>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {result?.channels?.length ? (
            <section className="space-y-3">
              <SectionTitle>Channels</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {result.channels.map((channel) => (
                  <div
                    key={channel.id}
                    className="rounded-full border border-line-default bg-surface px-3 py-2 text-[12px] font-700 text-text-2"
                  >
                    #{channel.handle} · {channel.displayName}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {result?.hashtags?.length ? (
            <section className="space-y-3">
              <SectionTitle>Hashtags</SectionTitle>
              <div className="flex flex-wrap gap-2">
                {result.hashtags.map((tag) => (
                  <div
                    key={tag.tag}
                    className="rounded-full border border-line-default bg-surface px-3 py-2 text-[12px] font-700 text-text-2"
                  >
                    #{tag.tag} · {tag.postCount} posts
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {!result?.posts?.length && !result?.agents?.length && !result?.channels?.length && !result?.hashtags?.length ? (
            <EmptyState
              title="No matches"
              description="Try a broader query, or change the search filter to a different result type."
            />
          ) : null}
        </div>
      )
    }

    if (activeTab === 'activity') {
      if (activityEntries.length === 0) {
        return (
          <EmptyState
            title="No activity yet"
            description="Actions across your agents, tasks, and connectors will show up here."
          />
        )
      }
      return (
        <div className="rounded-lg border border-line-subtle bg-surface p-2">
          <div className="flex flex-col gap-0.5">
            {activityEntries.slice(0, 8).map((entry) => (
              <div key={entry.id} className="flex items-center gap-2.5 px-3 py-2 rounded-sm">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                  className={`shrink-0 ${ACTIVITY_COLORS[entry.action] || 'text-text-3'}`}>
                  <path d={ACTIVITY_ICONS[entry.action] || ACTIVITY_ICONS.updated} />
                </svg>
                <span className="text-[12px] text-text-3 flex-1 truncate">{entry.summary}</span>
                <span className="text-[10px] text-text-3 shrink-0">{timeAgo(entry.timestamp, now)}</span>
              </div>
            ))}
          </div>
        </div>
      )
    }

    if (requiresActor && !resolvedSelectedAgentId) {
      return (
        <EmptyState
          title="Choose an acting agent"
          description="Following, bookmarks, and notifications are agent-scoped. Select a SwarmFeed-enabled agent first."
        />
      )
    }

    if (activeTab === 'bookmarks') {
      if (bookmarksQuery.isLoading) return <PageLoader />
      if (bookmarksQuery.error) {
        return (
          <ErrorState
            message={bookmarksQuery.error instanceof Error ? bookmarksQuery.error.message : 'Failed to load bookmarks'}
            onRetry={() => { void bookmarksQuery.refetch() }}
          />
        )
      }
      return renderPosts(bookmarksQuery.data || [])
    }

    if (activeTab === 'notifications') {
      if (notificationsQuery.isLoading) return <PageLoader />
      if (notificationsQuery.error) {
        return (
          <ErrorState
            message={notificationsQuery.error instanceof Error ? notificationsQuery.error.message : 'Failed to load notifications'}
            onRetry={() => { void notificationsQuery.refetch() }}
          />
        )
      }
      return (
        <NotificationsList
          notifications={notificationsQuery.data || []}
          onOpenProfile={setProfileAgentId}
          onOpenThread={(postId) => setThreadState({ postId, mode: 'reply' })}
        />
      )
    }

    if (feedQuery.isLoading) return <PageLoader />
    if (feedQuery.error) {
      return (
        <ErrorState
          message={feedQuery.error instanceof Error ? feedQuery.error.message : 'Failed to load feed'}
          onRetry={() => { void feedQuery.refetch() }}
        />
      )
    }

    return renderPosts(feedQuery.data?.posts || [])
  }

  return (
    <MainContent>
      {topBar}
      <div className="page-shell overscroll-contain">
        <div>
          <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="font-display text-[24px] font-700 tracking-[-0.02em] text-text">SwarmFeed</h1>
              <p className="mt-1 max-w-2xl text-[13px] leading-[1.7] text-text-3">
                A social network for agents. Humans can direct an update, but every post, follow, and reaction is executed as the selected agent identity.
              </p>
            </div>
            <div className="rounded-lg border border-line-subtle bg-surface px-4 py-3">
              <div className="text-[11px] font-700 tracking-[0.03em] text-text-3">Acting As</div>
              {selectedAgent ? (
                <div className="mt-2 flex items-center gap-2">
                  <AgentAvatar
                    seed={selectedAgent.avatarSeed || selectedAgent.id}
                    avatarUrl={selectedAgent.avatarUrl}
                    name={selectedAgent.name}
                    size={28}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-700 text-text">{selectedAgent.name}</div>
                    <div className="text-[11px] tracking-[0.03em] text-text-3">
                      {selectedAgent.model || selectedAgent.provider}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-[12px] text-text-3">No SwarmFeed-enabled agents available yet.</div>
              )}
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_360px]">
            <aside className="order-1 space-y-5 lg:order-2">
              <ComposePost
                selectedAgentId={resolvedSelectedAgentId}
                onSelectAgent={setSelectedAgentId}
              />

              <div className="rounded-lg border border-line-subtle bg-surface p-5">
                <div className="mb-3 flex items-center gap-2">
                  <Search size={14} className="text-text-3" />
                  <div className="text-[13px] font-700 tracking-[0.03em] text-text-3">Search SwarmFeed</div>
                </div>
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Find posts, agents, channels, hashtags…"
                  className="w-full rounded-lg border border-line-subtle bg-surface px-4 py-3 text-[14px] text-text outline-none transition-all placeholder:text-text-3 focus-glow"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  {SEARCH_FILTERS.map((filter) => (
                    <button
                      key={filter.key || 'all'}
                      type="button"
                      onClick={() => setSearchType(filter.key)}
                      className={`cursor-pointer rounded-full border px-3 py-1.5 text-[12px] font-700 transition-all ${
                        searchType === filter.key
                          ? 'border-accent-bright/45 bg-accent-bright/10 text-accent-bright'
                          : 'border-line-default bg-transparent text-text-3 hover:text-text'
                      }`}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
                <div className="mt-3 text-[11px] text-text-3">
                  {searchQuery.trim().length === 1
                    ? 'Type at least 2 characters to search.'
                    : isSearching
                      ? searchResultsQuery.isLoading
                        ? 'Searching…'
                        : `${searchResultsQuery.data?.total || 0} results ready`
                      : 'Search is public. Posting and follow actions still run as the selected agent.'}
                </div>
              </div>

              <div className="rounded-lg border border-line-subtle bg-surface p-5">
                <div className="mb-3 flex items-center gap-2">
                  <Users size={14} className="text-text-3" />
                  <div className="text-[13px] font-700 tracking-[0.03em] text-text-3">Suggested Follows</div>
                </div>

                {suggestedQuery.isLoading ? (
                  <div className="text-[13px] text-text-3">Loading suggestions…</div>
                ) : suggestedQuery.error ? (
                  <div className="text-[13px] text-red-200">
                    {suggestedQuery.error instanceof Error ? suggestedQuery.error.message : 'Failed to load suggestions'}
                  </div>
                ) : suggestedQuery.data?.agents?.length ? (
                  <div className="space-y-3">
                    {suggestedQuery.data.agents.slice(0, 6).map((agent) => (
                      <SuggestedAgentRow
                        key={agent.id}
                        agent={agent}
                        canFollow={!!resolvedSelectedAgentId}
                        busy={actionMutation.isPending}
                        onFollow={handleFollow}
                        onOpenProfile={setProfileAgentId}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="text-[13px] text-text-3">No suggestions available right now.</div>
                )}
              </div>

              {channels.length > 0 ? (
                <div className="rounded-lg border border-line-subtle bg-surface p-5">
                  <div className="mb-3 text-[13px] font-700 tracking-[0.03em] text-text-3">Channels</div>
                  <div className="flex flex-wrap gap-2">
                    {channels.slice(0, 12).map((channel) => (
                      <div
                        key={channel.id}
                        className="rounded-full border border-line-default bg-bg px-3 py-1.5 text-[12px] font-700 text-text-2"
                      >
                        #{channel.handle}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </aside>

            <div className="order-2 space-y-5 lg:order-1">
              <div className="rounded-lg border border-line-subtle bg-surface p-2">
                <div className="flex flex-wrap gap-1">
                  {FEED_TABS.map((tab) => {
                    const Icon = tab.icon
                    return (
                      <button
                        key={tab.key}
                        type="button"
                        onClick={() => setActiveTab(tab.key)}
                        className={`flex cursor-pointer items-center gap-2 rounded-md px-4 py-2.5 text-[13px] font-700 transition-all ${
                          activeTab === tab.key
                            ? 'bg-accent-bright/14 text-accent-bright'
                            : 'bg-transparent text-text-3 hover:bg-layer-2 hover:text-text'
                        }`}
                      >
                        <Icon size={14} />
                        <span>{tab.label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {renderMainColumn()}
            </div>
          </div>
        </div>
      </div>

      <PostThreadSheet
        open={!!threadState}
        postId={threadState?.postId || null}
        actingAgentId={resolvedSelectedAgentId || undefined}
        channelLabels={channelLabels}
        initialMode={threadState?.mode || 'reply'}
        onClose={() => setThreadState(null)}
        onProfileOpen={setProfileAgentId}
      />

      <SwarmFeedProfileSheet
        open={!!profileAgentId}
        agentId={profileAgentId}
        viewerAgentId={resolvedSelectedAgentId || undefined}
        channelLabels={channelLabels}
        onClose={() => setProfileAgentId(null)}
        onOpenThread={(postId, mode = 'reply') => setThreadState({ postId, mode })}
      />
    </MainContent>
  )
}

function SuggestedAgentRow({
  agent,
  canFollow,
  busy,
  onFollow,
  onOpenProfile,
}: {
  agent: SwarmFeedAgentSummary
  canFollow: boolean
  busy: boolean
  onFollow: (agentId: string) => Promise<void>
  onOpenProfile: (agentId: string) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line-subtle bg-surface p-3">
      <button
        type="button"
        onClick={() => onOpenProfile(agent.id)}
        className="cursor-pointer rounded-full border-none bg-transparent p-0"
      >
        <AgentAvatar seed={agent.id} avatarUrl={agent.avatar || null} name={agent.name} size={34} />
      </button>
      <button
        type="button"
        onClick={() => onOpenProfile(agent.id)}
        className="min-w-0 flex-1 cursor-pointer border-none bg-transparent p-0 text-left"
      >
        <div className="truncate text-[13px] font-700 text-text">{agent.name}</div>
        <div className="mt-1 text-[11px] tracking-[0.03em] text-text-3">
          {agent.framework || 'unknown'}{typeof agent.followerCount === 'number' ? ` · ${agent.followerCount} followers` : ''}
        </div>
      </button>
      <button
        type="button"
        onClick={() => { void onFollow(agent.id) }}
        disabled={!canFollow || busy}
        className="cursor-pointer rounded-md border border-accent-bright/35 bg-accent-bright/10 px-3 py-2 text-[12px] font-700 text-accent-bright transition-all hover:bg-accent-bright/15 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Follow
      </button>
    </div>
  )
}

function NotificationsList({
  notifications,
  onOpenProfile,
  onOpenThread,
}: {
  notifications: SwarmFeedNotification[]
  onOpenProfile: (agentId: string) => void
  onOpenThread: (postId: string) => void
}) {
  if (notifications.length === 0) {
    return (
      <EmptyState
        title="No notifications"
        description="When other agents mention, react to, or follow the selected agent, activity will show up here."
      />
    )
  }

  return (
    <div className="space-y-3">
      {notifications.map((notification) => (
        <div key={notification.id} className="rounded-lg border border-line-subtle bg-surface p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => onOpenProfile(notification.actorId)}
                className="cursor-pointer border-none bg-transparent p-0 text-left"
              >
                <div className="text-[14px] font-700 text-text">
                  {notification.actorName || notification.actorId}
                </div>
              </button>
              <div className="mt-1 text-[12px] tracking-[0.03em] text-text-3">
                {notification.type} · {formatTimestamp(notification.createdAt)}
              </div>
              {notification.content ? (
                <p className="mt-3 whitespace-pre-wrap break-words text-[13px] leading-[1.6] text-text-2">
                  {notification.content}
                </p>
              ) : null}
            </div>
            {notification.postId ? (
              <button
                type="button"
                onClick={() => onOpenThread(notification.postId!)}
                className="cursor-pointer rounded-md border border-line-default bg-bg px-3 py-2 text-[12px] font-700 text-text-2 transition-all hover:bg-bg"
              >
                Open
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}

function SectionTitle({ children }: { children: string }) {
  return <div className="text-[11px] font-700 tracking-[0.03em] text-text-3">{children}</div>
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-line-subtle bg-surface p-8 text-center">
      <p className="text-[14px] font-700 text-text">{title}</p>
      <p className="mx-auto mt-2 max-w-xl text-[13px] leading-[1.7] text-text-3">{description}</p>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-8 text-center">
      <p className="text-[14px] text-red-200">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 cursor-pointer rounded-sm border border-line-default bg-layer-2 px-4 py-2 text-[13px] font-700 text-text transition-all hover:bg-layer-3"
      >
        Retry
      </button>
    </div>
  )
}

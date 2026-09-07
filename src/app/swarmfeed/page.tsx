'use client'

import { FeedPage } from '@/features/swarmfeed/feed-page'
import { RouteTabs } from '@/components/shared/route-tabs'
import { HOME_TABS } from '@/app/home/home-tabs'

export default function SwarmFeedPage() {
  return <FeedPage topBar={<RouteTabs tabs={HOME_TABS} active="feed" />} />
}

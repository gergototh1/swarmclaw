'use client'

import { MainContent } from '@/components/layout/main-content'

/** The task board fills the page; there is no list beside it. */
export default function TasksLayout({ children }: { children: React.ReactNode }) {
  return <MainContent>{children}</MainContent>
}

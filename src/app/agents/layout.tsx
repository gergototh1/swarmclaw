'use client'

import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'
import { MainContent } from '@/components/layout/main-content'
import { AgentList } from '@/components/agents/agent-list'
import { useNavigate } from '@/lib/app/navigation'

/** Agent configuration only: the list beside the selected agent's settings. */
export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  const navigateTo = useNavigate()
  return (
    <>
      <SidebarPanelShell title="Agents" createLabel="Agent" onNew={() => navigateTo('agents', 'new')}>
        <AgentList inSidebar />
      </SidebarPanelShell>
      <MainContent>{children}</MainContent>
    </>
  )
}

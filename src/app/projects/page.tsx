'use client'

import { ProjectList } from '@/components/projects/project-list'
import { ProjectDetail } from '@/components/projects/project-detail'
import { useAppStore } from '@/stores/use-app-store'
import { MainContent } from '@/components/layout/main-content'
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'

export default function ProjectsPage() {
  return (
    <MainContent>
      <div className="flex-1 flex h-full min-w-0">
        <SidebarPanelShell
          title="Projects"
          createLabel="Project"
          onNew={() => {
            useAppStore.getState().setEditingProjectId(null)
            useAppStore.getState().setProjectSheetOpen(true)
          }}
        >
          <ProjectList />
        </SidebarPanelShell>
        <ProjectDetail />
      </div>
    </MainContent>
  )
}

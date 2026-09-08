'use client'

import { ProjectList } from '@/components/projects/project-list'
import { ProjectDetail } from '@/components/projects/project-detail'
import { useAppStore } from '@/stores/use-app-store'
import { MainContent } from '@/components/layout/main-content'
import { SidebarPanelShell } from '@/components/layout/sidebar-panel-shell'

export default function ProjectsPage() {
  return (
    <>
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
      <MainContent>
        <ProjectDetail />
      </MainContent>
    </>
  )
}

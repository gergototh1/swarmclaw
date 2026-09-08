'use client'

import { useAppStore } from '@/stores/use-app-store'
import { PageHeader } from '@/components/layout/page-header'
import { ExtensionList } from '@/components/extensions/extension-list'

export default function ExtensionsPage() {
  return (
    <div className="flex-1 flex flex-col h-full">
      <PageHeader
        title="Extensions"
        createLabel="Extension"
        onNew={() => useAppStore.getState().setExtensionSheetOpen(true)}
      />
      <ExtensionList />
    </div>
  )
}

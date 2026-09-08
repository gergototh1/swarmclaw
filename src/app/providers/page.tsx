'use client'

import { useAppStore } from '@/stores/use-app-store'
import { PageHeader } from '@/components/layout/page-header'
import { ProviderList } from '@/components/providers/provider-list'

export default function ProvidersPage() {
  return (
    <div className="flex-1 flex flex-col h-full">
      <PageHeader
        title="Providers"
        createLabel="Provider"
        onNew={() => useAppStore.getState().setProviderSheetOpen(true)}
      />
      <ProviderList />
    </div>
  )
}

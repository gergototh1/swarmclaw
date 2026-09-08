'use client'

import { useAppStore } from '@/stores/use-app-store'
import { PageHeader } from '@/components/layout/page-header'
import { ConnectorList } from '@/components/connectors/connector-list'

export default function ConnectorsPage() {
  return (
    <div className="flex-1 flex flex-col h-full">
      <PageHeader
        title="Connectors"
        createLabel="Connector"
        onNew={() => useAppStore.getState().setConnectorSheetOpen(true)}
      />
      <ConnectorList />
    </div>
  )
}

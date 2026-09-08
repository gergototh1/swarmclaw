'use client'

import { useAppStore } from '@/stores/use-app-store'
import { PageHeader } from '@/components/layout/page-header'
import { WebhookList } from '@/components/webhooks/webhook-list'

export default function WebhooksPage() {
  return (
    <div className="flex-1 flex flex-col h-full">
      <PageHeader
        title="Webhooks"
        createLabel="Webhook"
        onNew={() => useAppStore.getState().setWebhookSheetOpen(true)}
      />
      <WebhookList />
    </div>
  )
}

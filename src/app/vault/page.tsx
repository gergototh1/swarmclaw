'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { RouteTabs } from '@/components/shared/route-tabs'
import { MainContent } from '@/components/layout/main-content'
import { PageLoader } from '@/components/ui/page-loader'
import { SecretsPanel } from '@/components/secrets/secrets-panel'
import { WalletsPanel } from '@/components/wallets/wallets-panel'
import { VAULT_TABS, vaultTabFromSearch } from './vault-tabs'

function VaultBody() {
  const tab = vaultTabFromSearch(useSearchParams().get('tab'))
  return (
    <div className="flex-1 flex flex-col h-full min-h-0">
      <div className="flex items-center px-6 pt-5 pb-3 shrink-0">
        <h2 className="font-display text-[14px] font-600 text-text-2 tracking-[-0.01em] flex-1">Vault</h2>
      </div>
      <RouteTabs tabs={VAULT_TABS} active={tab} />
      {tab === 'secrets' ? <SecretsPanel /> : <WalletsPanel />}
    </div>
  )
}

export default function VaultPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <MainContent>
      <Suspense fallback={<PageLoader />}>
        <VaultBody />
      </Suspense>
    </MainContent>
  )
}

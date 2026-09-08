'use client'

import { useAppStore } from '@/stores/use-app-store'
import { PageHeader } from '@/components/layout/page-header'
import { McpServerList } from '@/components/mcp-servers/mcp-server-list'

export default function McpServersPage() {
  return (
    <div className="flex-1 flex flex-col h-full">
      <PageHeader
        title="MCP Servers"
        createLabel="MCP Server"
        onNew={() => useAppStore.getState().setMcpServerSheetOpen(true)}
      />
      <McpServerList />
    </div>
  )
}

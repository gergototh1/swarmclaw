'use client'

import { useParams } from 'next/navigation'
import { AgentEditor } from '@/components/agents/agent-editor'

/** An agent's settings. Chat with the agent lives under /chat. */
export default function AgentSettingsPage() {
  const { id } = useParams<{ id: string }>()
  const agentId = decodeURIComponent(id)
  return <AgentEditor key={agentId} agentId={agentId} />
}

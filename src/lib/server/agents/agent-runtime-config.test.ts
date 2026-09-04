import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent, GatewayProfile } from '@/types'

/*
 * THIS FILE GETS ITS OWN DATA DIRECTORY
 * =====================================
 * The two Ollama tests below write credentials, and the first of them DELETES
 * every stored `ollama` credential except the one it is about to save, with
 * no restore anywhere in the file. Against the real DATA_DIR -- the
 * developer's own instance, which is where `data-dir.ts` resolves when
 * nothing points it elsewhere -- that is a permanent loss of the operator's
 * Ollama credentials on every run of `test:runtime`. The other in-process
 * writers in the suite at least restore in an `afterEach`; this one did not.
 *
 * The import below is what moves it, and it must stay FIRST among the
 * imports that reach `data-dir.ts`: DATA_DIR is read once, at import time,
 * and ES modules evaluate their dependencies in import order. The assertion
 * under the imports runs at module level, so a wrong directory aborts the
 * file before its first test writes anything.
 */
import { assertIsolatedDataDir } from '@/lib/server/test-support/isolated-data-dir'

import { DATA_DIR, WORKSPACE_DIR } from '@/lib/server/data-dir'
import { normalizeProviderEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import {
  applyResolvedRoute,
  resolveAgentRouteCandidatesWithProfiles,
} from '@/lib/server/agents/agent-runtime-config'

// Outside any test() on purpose: a test that only detects the wrong directory
// runs after the tests before it have already written there.
assertIsolatedDataDir({ DATA_DIR, WORKSPACE_DIR })

function makeGateway(overrides: Partial<GatewayProfile> = {}): GatewayProfile {
  const now = Date.now()
  return {
    id: 'gateway-default',
    name: 'Gateway Default',
    provider: 'openclaw',
    endpoint: 'https://gateway.example.com/v1',
    wsUrl: 'wss://gateway.example.com',
    credentialId: 'cred-gateway',
    status: 'healthy',
    lifecycleState: 'active',
    lastControlAction: null,
    lastControlActionAt: null,
    lastControlReason: null,
    controlRequest: null,
    tags: [],
    isDefault: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const now = Date.now()
  return {
    id: 'agent-1',
    name: 'OpenClaw Ops',
    description: '',
    systemPrompt: '',
    provider: 'openclaw',
    model: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

test('resolveAgentRouteCandidatesWithProfiles applies the default OpenClaw gateway profile to base agents', () => {
  const gateways = [
    makeGateway(),
    makeGateway({
      id: 'gateway-secondary',
      name: 'Gateway Secondary',
      endpoint: 'https://secondary.example.com/v1',
      wsUrl: 'wss://secondary.example.com',
      credentialId: 'cred-secondary',
      isDefault: false,
    }),
  ]

  const [route] = resolveAgentRouteCandidatesWithProfiles(makeAgent(), gateways)
  assert.ok(route)
  assert.equal(route.provider, 'openclaw')
  assert.equal(route.model, 'default')
  assert.equal(route.gatewayProfileId, 'gateway-default')
  assert.equal(route.credentialId, 'cred-gateway')
  assert.equal(route.apiEndpoint, normalizeProviderEndpoint('openclaw', 'https://gateway.example.com/v1'))
})

test('resolveAgentRouteCandidatesWithProfiles routes around draining default gateways', () => {
  const gateways = [
    makeGateway({
      lifecycleState: 'draining',
    }),
    makeGateway({
      id: 'gateway-secondary',
      name: 'Gateway Secondary',
      endpoint: 'https://secondary.example.com/v1',
      wsUrl: 'wss://secondary.example.com',
      credentialId: 'cred-secondary',
      isDefault: false,
    }),
  ]

  const [route] = resolveAgentRouteCandidatesWithProfiles(makeAgent(), gateways)
  assert.ok(route)
  assert.equal(route.gatewayProfileId, 'gateway-secondary')
  assert.equal(route.credentialId, 'cred-secondary')
  assert.equal(route.apiEndpoint, normalizeProviderEndpoint('openclaw', 'https://secondary.example.com/v1'))
})

test('resolveAgentRouteCandidatesWithProfiles ignores cordoned preferred gateways', () => {
  const gateways = [
    makeGateway({
      id: 'gateway-specialized',
      name: 'Specialized Gateway',
      tags: ['browser'],
      lifecycleState: 'cordoned',
    }),
    makeGateway({
      id: 'gateway-active',
      name: 'Active Gateway',
      endpoint: 'https://active.example.com/v1',
      wsUrl: 'wss://active.example.com',
      credentialId: 'cred-active',
      tags: [],
      isDefault: false,
    }),
  ]

  const [route] = resolveAgentRouteCandidatesWithProfiles(makeAgent(), gateways, undefined, undefined, {
    preferredGatewayTags: ['browser'],
  })
  assert.ok(route)
  assert.equal(route.gatewayProfileId, 'gateway-active')
})

test('resolveAgentRouteCandidatesWithProfiles drops OpenClaw routes when every gateway is cordoned', () => {
  const routes = resolveAgentRouteCandidatesWithProfiles(makeAgent({
    gatewayProfileId: 'gateway-default',
  }), [
    makeGateway({
      lifecycleState: 'cordoned',
    }),
  ])

  assert.equal(routes.length, 0)
})

test('resolveAgentRouteCandidatesWithProfiles keeps explicit direct OpenClaw routes while saved gateways are cordoned', () => {
  const [route] = resolveAgentRouteCandidatesWithProfiles(makeAgent({
    gatewayProfileId: null,
    apiEndpoint: 'https://direct.example.com/v1',
  }), [
    makeGateway({
      lifecycleState: 'cordoned',
    }),
  ])

  assert.ok(route)
  assert.equal(route.gatewayProfileId, null)
  assert.equal(route.apiEndpoint, normalizeProviderEndpoint('openclaw', 'https://direct.example.com/v1'))
})

test('resolveAgentRouteCandidatesWithProfiles respects routing strategy but deprioritizes cooling providers', () => {
  const gateways = [
    makeGateway({
      id: 'gateway-economy',
      name: 'Economy Gateway',
      endpoint: 'https://economy.example.com/v1',
      wsUrl: 'wss://economy.example.com',
      credentialId: 'cred-economy',
      isDefault: false,
    }),
  ]

  const agent = makeAgent({
    provider: 'openai',
    model: 'gpt-4o',
    gatewayProfileId: null,
    routingStrategy: 'economy',
    routingTargets: [
      {
        id: 'economy-route',
        label: 'Economy',
        provider: 'openclaw',
        model: 'default',
        gatewayProfileId: 'gateway-economy',
        role: 'economy',
      },
      {
        id: 'premium-route',
        label: 'Premium',
        provider: 'openai',
        model: 'gpt-5',
        role: 'premium',
      },
    ],
  })

  const preferred = resolveAgentRouteCandidatesWithProfiles(agent, gateways)
  assert.equal(preferred[0]?.id, 'economy-route')
  assert.equal(preferred[0]?.apiEndpoint, normalizeProviderEndpoint('openclaw', 'https://economy.example.com/v1'))

  const cooled = resolveAgentRouteCandidatesWithProfiles(agent, gateways, undefined, (providerId) => providerId === 'openclaw')
  assert.equal(cooled[0]?.id, 'base')
  assert.equal(cooled[0]?.provider, 'openai')
})

test('applyResolvedRoute copies gateway, endpoint, and fallback credentials onto a target session-like object', () => {
  const target = {
    provider: 'claude-cli' as const,
    model: 'claude-sonnet-4-5',
    credentialId: null,
    fallbackCredentialIds: [] as string[],
    apiEndpoint: null,
    gatewayProfileId: null,
  }

  const next = applyResolvedRoute(target, {
    id: 'route-1',
    label: 'Gateway route',
    provider: 'openclaw',
    model: 'default',
    credentialId: 'cred-1',
    fallbackCredentialIds: ['cred-2', 'cred-3'],
    apiEndpoint: 'https://gateway.example.com/v1',
    gatewayProfileId: 'gateway-1',
    priority: 0,
    source: 'routing-target',
  })

  assert.deepEqual(next, {
    provider: 'openclaw',
    model: 'default',
    ollamaMode: null,
    credentialId: 'cred-1',
    fallbackCredentialIds: ['cred-2', 'cred-3'],
    apiEndpoint: 'https://gateway.example.com/v1',
    gatewayProfileId: 'gateway-1',
  })
})

test('resolveAgentRouteCandidatesWithProfiles keeps explicit Ollama cloud routes on the cloud path', async () => {
  const storage = await import('@/lib/server/storage')
  const now = Date.now()
  // Remove any pre-existing ollama credentials so the single-match fallback works
  const existing = storage.loadCredentials()
  const staleOllamaIds = Object.entries(existing)
    .filter(([id, cred]) => (cred as Record<string, unknown>)?.provider === 'ollama' && id !== 'cred-ollama-cloud')
    .map(([id]) => id)
  for (const id of staleOllamaIds) {
    storage.deleteCredential(id)
  }
  storage.saveCredentials({
    'cred-ollama-cloud': {
      id: 'cred-ollama-cloud',
      provider: 'ollama',
      name: 'Ollama Cloud',
      encryptedKey: storage.encryptKey('ollama-cloud-key'),
      createdAt: now,
    },
  })

  const [route] = resolveAgentRouteCandidatesWithProfiles(makeAgent({
    provider: 'ollama',
    model: 'glm-5:cloud',
    ollamaMode: 'cloud',
    credentialId: 'stale-ollama-cred',
    apiEndpoint: null,
  }), [])

  assert.ok(route)
  assert.equal(route.provider, 'ollama')
  assert.equal(route.model, 'glm-5:cloud')
  assert.equal(route.ollamaMode, 'cloud')
  assert.equal(route.credentialId, 'cred-ollama-cloud')
  assert.equal(route.apiEndpoint, 'https://ollama.com')
})

test('resolveAgentRouteCandidatesWithProfiles keeps explicit Ollama local routes local even with a credential and :cloud model', async () => {
  const storage = await import('@/lib/server/storage')
  const now = Date.now()
  const existing = storage.loadCredentials()
  storage.saveCredentials({
    ...existing,
    'cred-ollama-cloud': {
      id: 'cred-ollama-cloud',
      provider: 'ollama',
      name: 'Ollama Cloud',
      encryptedKey: storage.encryptKey('ollama-cloud-key'),
      createdAt: now,
    },
  })

  const [route] = resolveAgentRouteCandidatesWithProfiles(makeAgent({
    provider: 'ollama',
    model: 'glm-5:cloud',
    ollamaMode: 'local',
    credentialId: 'cred-ollama-cloud',
    apiEndpoint: null,
  }), [])

  assert.ok(route)
  assert.equal(route.provider, 'ollama')
  assert.equal(route.model, 'glm-5:cloud')
  assert.equal(route.ollamaMode, 'local')
  assert.equal(route.credentialId, 'cred-ollama-cloud')
  assert.equal(route.apiEndpoint, 'http://localhost:11434')
})

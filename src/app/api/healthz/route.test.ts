import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GET } from '@/app/api/healthz/route'

test('GET /api/healthz returns an ok payload', async () => {
  const response = await GET()
  assert.equal(response.status, 200)

  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.service, 'swarmclaw')
  assert.equal(typeof payload.time, 'number')
})

/**
 * `service` says what kind of server this is; only `instanceId` says which
 * one. A port file left behind by a killed server, a pid reused inside the
 * same boot and a second SwarmClaw on that port pass every other check the
 * port-file contract makes, and its reader -- an extension's MCP shim -- then
 * sends a paid request to the wrong instance. The comparison it makes is
 * between the token in the file and the token here, so this route has to
 * answer one, and it has to be the same one for the life of the process.
 */
test('GET /api/healthz names this server instance, stably, and it is the token the port file carries', async () => {
  const { serverInstanceId } = await import('@/lib/server/runtime/instance-id')
  const payload = await (await GET()).json()
  assert.equal(typeof payload.instanceId, 'string')
  assert.ok(payload.instanceId.length >= 16, `too short to tell instances apart: ${payload.instanceId}`)
  assert.equal(payload.instanceId, serverInstanceId(), 'the route and the port file writer must name the same instance')
  const again = await (await GET()).json()
  assert.equal(again.instanceId, payload.instanceId, 'the token changed between two requests to one process')
})

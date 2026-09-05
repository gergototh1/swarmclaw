import { NextResponse } from 'next/server'

import { serverInstanceId } from '@/lib/server/runtime/instance-id'

/**
 * Liveness, and identity.
 *
 * `service` says what kind of server this is; `instanceId` says WHICH one. The
 * second is what the port file's reader compares against the token in the file
 * (src/lib/server/runtime/port-file.ts, check 4): a stale file plus a reused
 * pid plus a second SwarmClaw on that port passes every other check, and an
 * extension's MCP shim would send its request -- a paid one, in the tts
 * extension's case -- to a server with a different key, cache and counter.
 *
 * The token is not a secret and this route is the place it is handed out: a
 * reader that cannot read it cannot make the comparison. It carries no
 * authority of its own.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'swarmclaw',
    instanceId: serverInstanceId(),
    time: Date.now(),
  })
}

import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { getExtensionManager, sanitizeExtensionFilename } from '@/lib/server/extensions'
import { reconcileManagedResourcesForLifecycleChange } from '@/lib/server/extension-managed-resources'
import { logActivity } from '@/lib/server/storage'
import { errorMessage } from '@/lib/shared-utils'
import {
  inferExtensionInstallSourceFromUrl,
  inferExtensionPublisherSourceFromUrl,
  normalizeExtensionInstallSource,
  normalizeExtensionPublisherSource,
} from '@/lib/extension-sources'
import {
  buildExtensionInstallCorsHeaders,
  resolveExtensionInstallCorsOrigin,
} from '@/lib/extension-install-cors'

function json(body: Record<string, unknown>, status: number, origin: string | null) {
  return NextResponse.json(body, {
    status,
    headers: buildExtensionInstallCorsHeaders(origin),
  })
}

export async function OPTIONS(req: Request) {
  const origin = resolveExtensionInstallCorsOrigin(req.headers.get('origin'))
  if (!origin) return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 })
  return new NextResponse(null, {
    status: 204,
    headers: buildExtensionInstallCorsHeaders(origin),
  })
}

export async function POST(req: Request) {
  const origin = resolveExtensionInstallCorsOrigin(req.headers.get('origin'))
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  const url = typeof body?.url === 'string' ? body.url : ''
  const filename = typeof body?.filename === 'string' ? body.filename : ''
  const installMethod = body?.installMethod === 'marketplace' ? 'marketplace' : 'manual'
  const sourceLabel = normalizeExtensionPublisherSource(body?.sourceLabel)
    || inferExtensionPublisherSourceFromUrl(url)
    || 'manual'
  const installSource = normalizeExtensionInstallSource(body?.installSource)
    || inferExtensionInstallSourceFromUrl(url)
    || 'manual'

  if (!url || !url.startsWith('https://')) {
    return json({ error: 'URL must be a valid HTTPS URL' }, 400, origin)
  }

  try {
    const sanitizedFilename = sanitizeExtensionFilename(filename)
    const installed = await getExtensionManager().installExtensionFromUrl(url, sanitizedFilename, {
      source: installMethod,
      sourceLabel,
      installSource,
    })
    logActivity({ entityType: 'extension', entityId: installed.filename, action: 'installed', actor: 'user', summary: `Extension "${installed.filename}" installed from ${installSource}` })
    // A freshly installed extension is enabled and loaded by here
    // (`saveExtensionSource` reloads on the way out), so the agents and
    // routines it declares are created now instead of never. The outcome
    // rides along in the response: the install succeeded whatever the
    // reconcile did, and the caller is the one that has to say both.
    const managedResources = reconcileManagedResourcesForLifecycleChange(installed.filename, 'install')
    return json({ ok: true, filename: installed.filename, hash: installed.sourceHash, managedResources }, 200, origin)
  } catch (err: unknown) {
    const msg = errorMessage(err)
    const isTimeout = /abort|timeout/i.test(msg)
    const status = /valid HTTPS URL|Filename|Invalid filename|HTML page|too large/i.test(msg)
      ? 400
      : isTimeout
        ? 504
        : 500
    return json(
      { error: isTimeout ? 'Download timed out — the extension URL may be unreachable' : msg },
      status,
      origin,
    )
  }
}

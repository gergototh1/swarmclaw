import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { getExtensionManager } from '@/lib/server/extensions'
import { reconcileManagedResourcesForLifecycleChange } from '@/lib/server/extension-managed-resources'
import { logActivity } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import '@/lib/server/builtin-extensions'

export const dynamic = 'force-dynamic'

export async function GET() {
  const manager = getExtensionManager()
  return NextResponse.json(manager.listExtensions())
}

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  const { filename, enabled } = body

  if (!filename || typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'filename and enabled required' }, { status: 400 })
  }

  const manager = getExtensionManager()
  const ext = manager.listExtensions().find((entry) => entry.filename === filename)
  if (!ext) {
    return NextResponse.json({ error: 'Extension not found' }, { status: 404 })
  }
  await manager.setEnabled(filename as string, enabled)
  logActivity({ entityType: 'extension', entityId: filename as string, action: enabled ? 'enabled' : 'disabled', actor: 'user', summary: `Extension "${filename}" ${enabled ? 'enabled' : 'disabled'}` })
  // Switching an extension on is the operator asking for what it declares, so
  // its agents and routines are created here rather than waiting for somebody
  // to find the Reconcile control. Switching one OFF is not the opposite
  // request: it says nothing about the resources, and the schedules it leaves
  // behind are skipped by the scheduler while the extension is off. So the
  // field is null on a disable -- an absent answer, not a reconcile reported
  // as having done nothing.
  const managedResources = enabled
    ? reconcileManagedResourcesForLifecycleChange(filename as string, 'enable')
    : null
  notify('extensions')

  return NextResponse.json({ ok: true, managedResources })
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const filename = searchParams.get('filename')
  if (!filename) {
    return NextResponse.json({ error: 'filename required' }, { status: 400 })
  }
  const manager = getExtensionManager()
  const deleted = await manager.deleteExtension(filename)
  if (!deleted) {
    return NextResponse.json({ error: 'Cannot delete built-in or non-existent extension' }, { status: 400 })
  }
  logActivity({ entityType: 'extension', entityId: filename, action: 'deleted', actor: 'user', summary: `Extension "${filename}" deleted` })
  notify('extensions')
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  const all = searchParams.get('all') === 'true'

  const manager = getExtensionManager()

  if (all) {
    // Reconciled per extension the update actually reached. Reconciling every
    // extension that declares resources would report an upgrade reconcile for
    // one whose download failed, which is a claim this route cannot make.
    const { updated, failed } = await manager.updateAllExtensions()
    const managedResources = updated.map((extensionId) => (
      reconcileManagedResourcesForLifecycleChange(extensionId, 'upgrade')
    ))
    notify('extensions')
    return NextResponse.json({
      ok: failed.length === 0,
      updated,
      failed,
      managedResources,
      message: failed.length === 0
        ? `Updated ${updated.length} extension${updated.length === 1 ? '' : 's'}`
        : `Updated ${updated.length} extension${updated.length === 1 ? '' : 's'}; ${failed.length} failed`,
    })
  }

  if (id) {
    await manager.updateExtension(id)
    const managedResources = reconcileManagedResourcesForLifecycleChange(id, 'upgrade')
    notify('extensions')
    return NextResponse.json({ ok: true, managedResources, message: `Extension ${id} updated` })
  }

  return NextResponse.json({ error: 'id or all=true required' }, { status: 400 })
}

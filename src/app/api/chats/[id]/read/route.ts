import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { patchSession } from '@/lib/server/sessions/session-repository'
import { notify } from '@/lib/server/ws-hub'
import { markSessionRead } from './read-route-logic'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = markSessionRead(id, { patch: patchSession })
  if (!result) return notFound()
  notify('sessions')
  return NextResponse.json(result)
}

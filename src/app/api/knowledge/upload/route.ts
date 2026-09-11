import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { genId } from '@/lib/id'
import { UPLOAD_DIR } from '@/lib/server/storage'
import { deriveKnowledgeTitle, extractKnowledgeTextFromBuffer } from '@/lib/server/knowledge-import'
import { decodeFilenameHeader, safeUploadFilename } from '@/lib/upload-filename'

export async function POST(req: Request) {
  const filename = decodeFilenameHeader(req.headers.get('x-filename'), 'document.txt')
  const buf = Buffer.from(await req.arrayBuffer())

  if (buf.length === 0) {
    return NextResponse.json({ error: 'Empty file.' }, { status: 400 })
  }

  if (buf.length > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'File too large. Maximum 10MB.' }, { status: 400 })
  }

  // Save file to uploads
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  const safeName = genId() + '-' + safeUploadFilename(filename)
  const filePath = path.join(UPLOAD_DIR, safeName)
  fs.writeFileSync(filePath, buf)

  const content = await extractKnowledgeTextFromBuffer(buf, filename, filePath)
  const title = deriveKnowledgeTitle(filename)
  const url = `/api/uploads/${safeName}`

  return NextResponse.json({
    title,
    content,
    filePath,
    url,
    filename,
    size: buf.length,
  })
}

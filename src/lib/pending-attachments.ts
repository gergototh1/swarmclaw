import type { PendingFile } from '@/stores/use-chat-store'

/**
 * How the composer's attachments split into the two fields a turn carries.
 *
 * `imagePath` is the older of the two and every image-capable path still reads
 * it, so it keeps its meaning: THE FIRST IMAGE, and nothing else. It used to be
 * "whatever was attached first", which put a .docx in a field named for an
 * image and had providers announce it to the model as one.
 *
 * `attachedFiles` carries every attachment, the first image included. It used
 * to be set only when there were two or more, so a single non-image attachment
 * travelled solely in `imagePath` -- and a second one travelled twice. Every
 * consumer de-duplicates by path, so listing all of them here is the simple
 * rule and costs nothing.
 */
export function splitPendingAttachments(files: PendingFile[]): {
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
} {
  const firstImage = files.find((f) => f.file.type.startsWith('image/'))
  const paths = files.map((f) => f.path).filter(Boolean)
  return {
    imagePath: firstImage?.path,
    imageUrl: firstImage?.url,
    attachedFiles: paths.length ? paths : undefined,
  }
}

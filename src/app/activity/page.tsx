import { redirect } from 'next/navigation'
import { STREAM_REDIRECTS } from '@/app/stream/stream-tabs'

/** Merged into /stream. Kept so bookmarks and links from older sessions still land. */
export default function ActivityPage() {
  redirect(STREAM_REDIRECTS.activity)
}

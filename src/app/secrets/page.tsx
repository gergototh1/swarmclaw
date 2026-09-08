import { redirect } from 'next/navigation'
import { VAULT_REDIRECTS } from '@/app/vault/vault-tabs'

/** Merged into /vault. Kept so bookmarks and links from older sessions still land. */
export default function SecretsPage() {
  redirect(VAULT_REDIRECTS.secrets)
}

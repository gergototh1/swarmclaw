/** Both credential stores: API keys and tokens, and the on-chain wallets. */
export const VAULT_TABS = [
  { key: 'secrets', label: 'Secrets', href: '/vault?tab=secrets' },
  { key: 'wallets', label: 'Wallets', href: '/vault?tab=wallets' },
] as const

export type VaultTabKey = (typeof VAULT_TABS)[number]['key']

/** Resolve the `?tab=` parameter, defaulting to secrets for anything unrecognised. */
export function vaultTabFromSearch(param: string | null): VaultTabKey {
  const match = VAULT_TABS.find((t) => t.key === param)
  return match ? match.key : 'secrets'
}

/**
 * Where each retired route now sends the reader.
 *
 * The stubs at /secrets and /wallets import from here rather than writing the
 * path out, so renaming a tab cannot leave a bookmark pointing at nothing.
 */
export const VAULT_REDIRECTS: Record<VaultTabKey, string> = {
  secrets: '/vault?tab=secrets',
  wallets: '/vault?tab=wallets',
}

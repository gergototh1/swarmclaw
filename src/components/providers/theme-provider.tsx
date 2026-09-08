'use client'

import { ThemeProvider as NextThemeProvider } from 'next-themes'

/**
 * `nonce` is the per-request CSP nonce the proxy generated, forwarded here by
 * the root layout. next-themes writes an inline anti-flash script into the
 * document head, and that is the one script tag Next does not nonce for us, so
 * without this it is the single thing an enforcing `script-src` would block --
 * costing a theme flash on every page load. It is optional because a request
 * the proxy did not touch has no nonce to pass.
 */
export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemeProvider>
  )
}

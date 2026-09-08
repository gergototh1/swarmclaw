'use client'

import { useEffect } from 'react'

import './globals.css'

import { ErrorFallback } from '@/components/layout/error-fallback'
import { reportClientError } from '@/lib/app/report-client-error'

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    reportClientError({
      source: 'global-error',
      error,
      digest: error.digest,
    })
  }, [error])

  return (
    // This root replaces the document rather than nesting inside RootLayout,
    // so it carries its own class list. It no longer has to carry font
    // variables: globals.css names the macOS system faces literally, so
    // --font-sans resolves the same on every root. See
    // src/app/globals-font-family.test.ts, which is what keeps that true.
    <html lang="en" className="dark">
      <body className="antialiased">
        <ErrorFallback
          message="A fatal application error occurred before the normal shell could recover. Reload the app to continue."
          onPrimaryAction={() => window.location.reload()}
        />
      </body>
    </html>
  )
}

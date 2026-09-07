'use client'

import { useEffect } from 'react'

import './globals.css'

import { fontVariables } from './fonts'
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
    // next/font's three -face variables come from these classes and nowhere
    // else, and this root replaces the document rather than nesting inside
    // RootLayout, so without them globals.css's --font-sans would resolve to
    // an undefined var() and drop body's whole font-family on this route.
    <html lang="en" className={`dark ${fontVariables}`}>
      <body className="antialiased">
        <ErrorFallback
          message="A fatal application error occurred before the normal shell could recover. Reload the app to continue."
          onPrimaryAction={() => window.location.reload()}
        />
      </body>
    </html>
  )
}

import type { Metadata, Viewport } from "next"
import { headers } from "next/headers"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { DashboardShell } from "@/components/layout/dashboard-shell"
import { AppQueryProvider } from "@/components/providers/app-query-provider"
import { ThemeProvider } from "@/components/providers/theme-provider"
import "./globals.css"

export const metadata: Metadata = {
  title: "SwarmClaw",
  description: "Self-hosted AI runtime for OpenClaw, agent swarms, runtime skills, and wallets.",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
}

// Avoid static prerendering for the app shell. This prevents flaky
// Turbopack prerender failures seen in detached fresh-install builds.
export const dynamic = "force-dynamic"

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // The proxy puts the request's CSP nonce here. Next stamps it on the script
  // tags it emits itself; next-themes' inline anti-flash script is ours to pass
  // it to. Absent (undefined) for any request the proxy did not run on.
  const nonce = (await headers()).get("x-nonce") ?? undefined

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased" cz-shortcut-listen="true">
        <ThemeProvider nonce={nonce}>
          <AppQueryProvider>
            <TooltipProvider>
              <DashboardShell>
                {children}
              </DashboardShell>
              <Toaster />
            </TooltipProvider>
          </AppQueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}

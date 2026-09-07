import { DM_Sans, JetBrains_Mono, Sora } from "next/font/google"

// Loaded here rather than declared in CSS: globals.css named these three
// families but nothing ever fetched them, so the display and body stacks
// both resolved to system-ui and `font-display` was a no-op.
// latin-ext is required because the UI carries Hungarian copy (`Doksik`,
// `Videó`) -- without it, ő and ű render in the fallback font.
const sans = DM_Sans({ subsets: ["latin", "latin-ext"], variable: "--font-sans-face", display: "swap" })
const display = Sora({ subsets: ["latin", "latin-ext"], variable: "--font-display-face", display: "swap" })
const mono = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  variable: "--font-mono-face",
  display: "swap",
  preload: false,
})

/**
 * The three class names that put --font-sans-face / --font-display-face /
 * --font-mono-face on an element, for every <html> this app renders.
 *
 * There is more than one. RootLayout owns the normal tree, but app/
 * global-error.tsx replaces the whole document when the root layout itself
 * throws, so it renders its own <html> and has to carry these too. Without
 * them the three -face variables are undefined on that route, `--font-sans`
 * in globals.css resolves to var() with no declaration and no fallback --
 * the guaranteed-invalid value -- and the body font-family is dropped whole,
 * generic tail included. Both roots read this one constant so a font added
 * here cannot reach one root and miss the other.
 */
export const fontVariables = `${sans.variable} ${display.variable} ${mono.variable}`

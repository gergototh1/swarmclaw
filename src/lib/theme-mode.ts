export type ThemeMode = 'light' | 'dark' | 'system'

/**
 * The order the rail's single-button control walks, and the order Settings
 * lists. Light, Dark, System reads as "two choices and then hand it back",
 * which is the order the OS's own control uses.
 */
export const THEME_MODE_ORDER: readonly ThemeMode[] = ['light', 'dark', 'system'] as const

/**
 * The fallback is `system`, not `dark`, and that is the whole reason the app
 * now follows the OS.
 *
 * `defaultTheme` on the next-themes provider cannot do it alone: GET
 * /api/settings runs every stored settings blob through this function before
 * returning it, so `appSettings.themeMode` is never absent, so the effect in
 * dashboard-shell always calls setTheme() with whatever this returns and the
 * provider's own default is overwritten before first paint. A user who has
 * never opened Settings > Theme has no stored value, and this is what decides
 * what that means.
 */
export function normalizeThemeMode(value: unknown): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system'
}

/**
 * The next mode in the cycle. The collapsed 52px rail has room for one 28px
 * control and no labels, so its theme button advances through the three modes
 * rather than presenting them; this is the step it takes.
 */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  const index = THEME_MODE_ORDER.indexOf(mode)
  return THEME_MODE_ORDER[(index + 1) % THEME_MODE_ORDER.length]
}

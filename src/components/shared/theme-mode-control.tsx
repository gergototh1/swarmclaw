'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { RailTooltip } from '@/components/layout/nav-item'
import { nextThemeMode, normalizeThemeMode, THEME_MODE_ORDER, type ThemeMode } from '@/lib/theme-mode'
import { useAppStore } from '@/stores/use-app-store'

const MODE_META: Record<ThemeMode, { label: string; Icon: typeof Sun }> = {
  light: { label: 'Light', Icon: Sun },
  dark: { label: 'Dark', Icon: Moon },
  system: { label: 'System', Icon: Monitor },
}

/**
 * The one place the app sets a theme mode.
 *
 * Setting a mode is two writes that have to happen together — next-themes owns
 * the class on <html> and decides what "system" listens to, and the stored
 * setting is what survives a reload and what dashboard-shell replays on load.
 * Doing one without the other gives a theme that reverts on refresh or a
 * Settings screen that disagrees with the window. Both surfaces below share
 * this, so there is one path rather than two that can drift.
 */
function useThemeModeSetting() {
  const { setTheme } = useTheme()
  const appSettings = useAppStore((s) => s.appSettings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const mode = normalizeThemeMode(appSettings.themeMode)

  const applyMode = (next: ThemeMode) => {
    setTheme(next)
    void updateSettings({ themeMode: next })
    toast.success(`Theme: ${MODE_META[next].label}`)
  }

  return { mode, applyMode }
}

/**
 * The three-up control on Settings > Theme. All three modes visible, the
 * current one filled.
 */
export function ThemeModeSegmented() {
  const { mode, applyMode } = useThemeModeSetting()

  return (
    <div className="inline-grid grid-cols-3 rounded-sm border border-line-default bg-layer-1 p-1">
      {THEME_MODE_ORDER.map((id) => {
        const { label, Icon } = MODE_META[id]
        const isActive = mode === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => applyMode(id)}
            aria-pressed={isActive}
            className={`h-9 px-3 rounded-xs flex items-center justify-center gap-2 text-[12px] font-600 transition-colors ${
              isActive
                ? 'bg-accent text-accent-fg'
                : 'text-text-3 hover:text-text hover:bg-layer-2'
            }`}
            title={label}
          >
            <Icon className="w-4 h-4" aria-hidden="true" />
            <span>{label}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The rail's copy of the same control, and the reason `nextThemeMode` exists.
 *
 * The rail collapses to 52px, which leaves one 28px control and no room for a
 * label, let alone three of them. So the rail does not present the three modes
 * — it advances through them, one tap per step, and shows the icon of the mode
 * that is on. The tooltip names both the current mode and the one the next tap
 * would reach, so the cycle is readable before it is used rather than after.
 * Expanded, the same button gains the mode's name beside the icon and matches
 * the profile row directly beneath it, which does exactly this.
 *
 * A popover listing all three would show the whole choice, but it puts a
 * floating layer inside a 52px column that has to be placed, dismissed on
 * outside-click and Escape, and kept above the rail's own scroll container —
 * new machinery for a choice with three values. The full three-up control is
 * one rail-expand away, and is what Settings shows.
 */
export function ThemeModeRailButton({ expanded }: { expanded: boolean }) {
  const { mode, applyMode } = useThemeModeSetting()
  const { label, Icon } = MODE_META[mode]
  const next = nextThemeMode(mode)
  const ariaLabel = `Theme: ${label}. Switch to ${MODE_META[next].label}`

  if (expanded) {
    return (
      <button
        type="button"
        onClick={() => applyMode(next)}
        aria-label={ariaLabel}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-sm cursor-pointer transition-all
          bg-transparent hover:bg-layer-2 border-none text-text-3 hover:text-text-2"
        style={{ fontFamily: 'inherit' }}
      >
        <Icon size={16} aria-hidden="true" />
        <span className="text-[13px] font-600 truncate">{label}</span>
      </button>
    )
  }

  return (
    <RailTooltip label={`Theme: ${label}`} description={`Switch to ${MODE_META[next].label}`}>
      <button
        type="button"
        onClick={() => applyMode(next)}
        aria-label={ariaLabel}
        className="rail-btn"
      >
        <Icon size={16} aria-hidden="true" />
      </button>
    </RailTooltip>
  )
}

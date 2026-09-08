'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Activity, BookOpen, Briefcase, Home, Link2, MessageSquare, Settings as SettingsIcon } from 'lucide-react'
import { useAppStore } from '@/stores/use-app-store'
import { Avatar } from '@/components/shared/avatar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { DaemonIndicator } from '@/components/layout/daemon-indicator'
import { NotificationCenter } from '@/components/shared/notification-center'
import { RailTooltip } from '@/components/layout/nav-item'
import { NavSectionPanel } from '@/components/layout/nav-section-panel'
import { useExtensionPages } from '@/hooks/use-extension-pages'
import { useWs } from '@/hooks/use-ws'
import { NAV_SECTIONS, type NavSection, type NavSectionId, type NavSectionIconName } from '@/lib/app/nav-sections'
import { FULL_WIDTH_VIEWS, isPanelSidebarView, VIEW_DESCRIPTIONS, VIEW_LABELS } from '@/lib/app/view-constants'
import { getViewPath, resolveSidebarActiveView, useNavigate } from '@/lib/app/navigation'
import {
  PANEL_CLOSED_KEY,
  RAIL_EXPANDED_KEY,
  panelClosedFromStorage,
  railExpandedFromStorage,
  railSectionForPath,
  resolveHighlightedSection,
  resolveOpenSection,
  type RailSectionPick,
} from '@/lib/app/rail-state'
import { safeStorageGet, safeStorageSet } from '@/lib/app/safe-storage'
import type { AppView } from '@/types'

const GITHUB_REPO_URL = 'https://github.com/swarmclawai/swarmclaw'
const DISCORD_URL = 'https://discord.gg/sbEavS8cPV'

/**
 * The components behind the icon names in `NAV_SECTIONS`.
 *
 * Kept here rather than in the table so the table stays importable by server
 * code and tests without pulling a client-only icon module in behind it. Typed
 * by `NavSectionIconName` rather than `Record<string, ...>` so a section
 * naming an icon this map does not carry — or this map missing one of the
 * union's names — is a compile error in both directions, not a section that
 * silently renders the Home icon.
 */
const SECTION_ICONS: Record<NavSectionIconName, React.ComponentType<{ size?: number }>> = {
  Home, MessageSquare, Briefcase, BookOpen, Link2, Activity, Settings: SettingsIcon,
}

/**
 * One of the rail's off-app links (Docs, GitHub, Discord).
 *
 * The three differ only in href, label and glyph, and each needs a labelled row
 * and a 52px icon-with-tooltip form; those three two-form blocks were about
 * 78 of this file's 519 lines (roughly 2.5 KB of 31.6 KB) before this
 * component collapsed them into three short calls.
 */
function RailExternalLink({ href, label, description, expanded, children }: {
  href: string
  label: string
  description: string
  expanded: boolean
  children: React.ReactNode
}) {
  if (!expanded) {
    return (
      <RailTooltip label={label} description={description}>
        <a href={href} target="_blank" rel="noopener noreferrer" className="rail-btn">{children}</a>
      </RailTooltip>
    )
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-sm text-[13px] font-500 cursor-pointer transition-all
        bg-transparent text-text-3 hover:text-text hover:bg-layer-2 no-underline"
      style={{ fontFamily: 'inherit' }}
    >
      <span className="shrink-0 flex items-center">{children}</span>
      <span className="truncate">{label}</span>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="ml-auto opacity-40 shrink-0">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </a>
  )
}

export function SidebarRail({
  onSwitchUser,
  isViewEnabled,
  mobile,
}: {
  onSwitchUser: () => void
  isViewEnabled: (view: AppView) => boolean
  mobile?: boolean
}) {
  const pathname = usePathname()
  const navigateTo = useNavigate()
  const currentUser = useAppStore((s) => s.currentUser)
  const appSettings = useAppStore((s) => s.appSettings)
  const defaultAgent = useAppStore((s) => {
    const defaultId = s.appSettings.defaultAgentId
    if (defaultId && s.agents[defaultId]) return s.agents[defaultId]
    const first = Object.values(s.agents)[0]
    return first || null
  })
  const currentAgentId = useAppStore((s) => s.currentAgentId)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const skillDraftCount = useAppStore((s) => s.skillDraftCount)
  const loadSkillDraftCount = useAppStore((s) => s.loadSkillDraftCount)

  // See `resolveSidebarActiveView` for why this must not fall back to 'home'
  // for a path it doesn't recognize.
  const activeView: AppView | null = resolveSidebarActiveView(pathname)

  const defaultAgentId = defaultAgent?.id || null
  const isDefaultChat = activeView === 'agents' && currentAgentId === defaultAgentId

  const [railExpandedStored, setRailExpandedStored] = useState(() => railExpandedFromStorage(safeStorageGet(RAIL_EXPANDED_KEY)))
  // Mobile always forces expanded
  const railExpanded = mobile || railExpandedStored

  useEffect(() => { void loadSkillDraftCount() }, [loadSkillDraftCount])
  useWs('skills', loadSkillDraftCount)

  // Counts the rail carries on a section, and the panel repeats on the entry
  // they belong to. Without the rail half, collapsing the panel would hide the
  // only signal that skill drafts are waiting.
  const badges: Partial<Record<AppView, number>> = { skills: skillDraftCount }

  // Which section's panel is open.
  //
  // Derived from the route, with the operator's own click layered over it —
  // deliberately not a useState the route writes into from an effect. The panel
  // has to follow the route (open /x/crm from a bookmark and Work must be
  // showing) and it has to obey a click that navigates nowhere (open Knowledge
  // while standing on /tasks), and an effect that pushed one into the other
  // would run a render late, after the wrong panel had already painted.
  //
  // Storing the click next to the route it was made against settles it in one
  // value: the pick holds while the route stays put, and the moment the route
  // lands in a different section that section wins, UNLESS the reader has
  // closed the panel — that preference is persisted (`sc_panel_closed`, the
  // same pattern as `sc_rail_expanded`) so it survives the navigation that a
  // bare `picked` state could not. See `resolveOpenSection` in
  // src/lib/app/rail-state.ts for the full writeup of why the transient pick
  // and the durable close are two different lifetimes, and
  // `resolveHighlightedSection` for how the rail still shows the reader's
  // current section, via its own icon highlight, while the panel stays shut.
  const extensionPages = useExtensionPages()
  const routeSection = railSectionForPath(pathname, activeView, extensionPages)
  const [picked, setPicked] = useState<RailSectionPick | null>(null)
  const [panelClosedStored, setPanelClosedStored] = useState(() => panelClosedFromStorage(safeStorageGet(PANEL_CLOSED_KEY)))
  const openSection = resolveOpenSection(routeSection, picked, panelClosedStored)
  // The section the rail highlights as "you are here." Kept separate from
  // `openSection` so closing the panel (which can now persist indefinitely)
  // never leaves every rail icon dark — see `resolveHighlightedSection`.
  const highlightedSection = resolveHighlightedSection(routeSection, openSection)
  // Always opens (or switches to) a section — used by the "direct" rows
  // (Home, and any section that navigates straight to a view) whose icon
  // highlight should track the active view, not a togglable panel.
  const selectSection = (id: NavSectionId) => setPicked({ section: id, route: routeSection })
  // Used by the panel-opening rows: clicking the section that is already open
  // closes its panel, clicking any other section switches to it (opening one
  // always wins over a persisted close — otherwise the rail buttons would do
  // nothing while closed). Either way the outcome is written back to storage
  // so the preference — open or closed — survives past this render.
  const toggleSection = (id: NavSectionId) => {
    const closing = openSection === id
    setPicked({ section: closing ? null : id, route: routeSection })
    setPanelClosedStored(closing)
    safeStorageSet(PANEL_CLOSED_KEY, String(closing))
  }

  const panelSection = NAV_SECTIONS.find((s) => s.id === openSection && !s.direct) ?? null

  const toggleRail = () => {
    if (mobile) return
    const next = !railExpandedStored
    setRailExpandedStored(next)
    safeStorageSet(RAIL_EXPANDED_KEY, String(next))
  }

  const goToDefaultChat = () => {
    navigateTo('agents', defaultAgentId)
    setSidebarOpen(false)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('swarmclaw:scroll-bottom'))
    }
  }

  const handleNavClick = (view: AppView) => {
    if (!isViewEnabled(view)) return
    if (mobile) {
      // On mobile, close the drawer on every navigation
      setSidebarOpen(false)
      return
    }
    if (isPanelSidebarView(view)) {
      setSidebarOpen(!(activeView === view && sidebarOpen))
    } else if (FULL_WIDTH_VIEWS.has(view)) {
      setSidebarOpen(false)
    } else {
      setSidebarOpen(true)
    }
  }

  // Extension pages render full width and have no panel sidebar of their own, so
  // navigating to one collapses the panel (and closes the drawer on mobile).
  const handleExtensionNavClick = () => setSidebarOpen(false)

  // What the 52px rail says about a section it can only draw as an icon. A
  // section that opens a panel lists what is in it; the one that navigates
  // straight to a view borrows that view's description.
  const sectionHint = (section: NavSection) => section.direct
    ? VIEW_DESCRIPTIONS[section.direct]
    : section.views.filter(isViewEnabled).map((v) => VIEW_LABELS[v]).join(' · ')

  const renderSection = (section: NavSection) => {
    const Icon = SECTION_ICONS[section.icon] ?? Home
    // `highlighted` drives the visual "you are here" cue and stays lit on the
    // current section even while its panel is closed. `expanded` is the
    // truthful aria-expanded value — whether this section's panel is
    // actually rendered right now — and the two intentionally diverge
    // whenever the reader has closed the panel for the section they're on.
    const highlighted = highlightedSection === section.id
    const expanded = openSection === section.id
    const count = section.views.reduce((n, v) => n + (badges[v] ?? 0), 0)

    const inner = (
      <>
        <span className="shrink-0 relative flex items-center">
          <Icon size={17} />
          {!!count && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] rounded-full bg-amber-500 text-black text-[9px] font-700 flex items-center justify-center px-0.5">
              {count}
            </span>
          )}
        </span>
        {railExpanded && <span className="truncate">{section.label}</span>}
      </>
    )

    const className = railExpanded
      ? `w-full flex items-center gap-2.5 px-3 py-2 rounded-sm text-[13px] font-500 cursor-pointer transition-all border-none no-underline text-left
          ${highlighted ? 'bg-accent-soft text-accent-bright' : 'bg-transparent text-text-3 hover:text-text hover:bg-layer-2'}`
      : `rail-btn ${highlighted ? 'active' : ''} relative no-underline`

    // A section that goes straight to a view stays a real link, so it can still
    // be opened in a new tab; one that opens a panel is a button, because it
    // navigates nowhere.
    const direct = section.direct
    const control = direct ? (
      <Link
        key={section.id}
        href={getViewPath(direct)}
        onClick={() => { handleNavClick(direct); selectSection(section.id) }}
        aria-current={activeView === direct ? 'page' : undefined}
        className={className}
        style={{ fontFamily: 'inherit' }}
      >
        {inner}
      </Link>
    ) : (
      <button
        key={section.id}
        onClick={() => toggleSection(section.id)}
        aria-expanded={expanded}
        className={className}
        style={{ fontFamily: 'inherit' }}
      >
        {inner}
      </button>
    )

    if (railExpanded) return control
    return <RailTooltip key={section.id} label={section.label} description={sectionHint(section)}>{control}</RailTooltip>
  }

  return (
    <div className={`flex h-full min-h-0 ${mobile ? 'max-w-[calc(100vw-40px)]' : 'shrink-0'}`}>
      <div
        className={`shrink-0 bg-raised border-r border-line-subtle flex flex-col py-4 min-h-0 overflow-visible
          transition-[width] duration-200 ${railExpanded ? 'w-[152px]' : 'w-[52px]'}`}
        style={{ transitionTimingFunction: 'var(--ease-spring)' }}
      >
        {/* Logo + collapse toggle */}
        <div className={`flex items-center mb-4 shrink-0 ${railExpanded ? 'px-3 gap-2' : 'justify-center'}`}>
          <div className="w-10 h-10 rounded-md bg-gradient-to-br from-[#4338CA] to-[#6366F1] flex items-center justify-center shrink-0
            shadow-[0_2px_12px_rgba(99,102,241,0.2)]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-white">
              <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />
            </svg>
          </div>
          {railExpanded && !mobile && (
            <button
              onClick={toggleRail}
              className="ml-auto w-7 h-7 rounded-sm flex items-center justify-center text-text-3 hover:text-text hover:bg-layer-2 transition-all cursor-pointer bg-transparent border-none"
              title="Collapse sidebar"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="11 17 6 12 11 7" />
                <polyline points="18 17 13 12 18 7" />
              </svg>
            </button>
          )}
        </div>

        {/* Expand button when collapsed */}
        {!railExpanded && !mobile && (
          <div className="flex justify-center mb-2">
            <button onClick={toggleRail} className="rail-btn" title="Expand sidebar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polyline points="13 17 18 12 13 7" />
                <polyline points="6 17 11 12 6 7" />
              </svg>
            </button>
          </div>
        )}

        {/* Default agent shortcut */}
        {railExpanded ? (
          <div className="px-3 mb-2.5">
            <button
              onClick={goToDefaultChat}
              className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[12px] font-600 cursor-pointer transition-all text-left
                ${isDefaultChat
                  ? 'bg-accent-bright/15 border border-[#6366F1]/25 text-accent-bright'
                  : 'bg-accent-bright/10 border border-[#6366F1]/20 text-accent-bright hover:bg-accent-bright/15'}`}
              style={{ fontFamily: 'inherit' }}
            >
              {defaultAgent ? (
                <AgentAvatar seed={defaultAgent.avatarSeed || null} avatarUrl={defaultAgent.avatarUrl} name={defaultAgent.name} size={24} />
              ) : (
                <div className="w-6 h-6 rounded-full bg-accent-bright/15 flex items-center justify-center shrink-0">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
              )}
              <div className="min-w-0">
                <div className="truncate">{defaultAgent?.name || 'Choose Agent'}</div>
                <div className="text-[10px] font-500 text-accent-bright/75 mt-0.5 truncate">
                  {defaultAgent ? 'Default shortcut' : 'Pick an agent'}
                </div>
              </div>
            </button>
          </div>
        ) : (
          <RailTooltip
            label={defaultAgent?.name || 'Choose Agent'}
            description={defaultAgent ? 'Open your default agent shortcut chat' : 'Choose an agent thread'}
          >
            <button onClick={goToDefaultChat} className={`rail-btn self-center mb-2 ${isDefaultChat ? 'active' : ''}`}>
              {defaultAgent ? (
                <AgentAvatar seed={defaultAgent.avatarSeed || null} avatarUrl={defaultAgent.avatarUrl} name={defaultAgent.name} size={20} />
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
            </button>
          </RailTooltip>
        )}

        {/* Search */}
        {railExpanded ? (
          <div className="px-3 mb-2">
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('swarmclaw:open-search'))}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-sm text-[13px] font-500 cursor-pointer transition-all
                bg-transparent text-text-3 hover:text-text hover:bg-layer-2 border-none"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              Search
              <kbd className="ml-auto px-1 py-0.5 rounded-xs bg-layer-2 border border-line-default text-[10px] font-mono text-text-3">
                ⌘K
              </kbd>
            </button>
          </div>
        ) : (
          <RailTooltip label="Search" description="Search across all entities (⌘K)">
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('swarmclaw:open-search'))}
              className="rail-btn self-center mb-2"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
          </RailTooltip>
        )}

        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto overscroll-contain touch-pan-y">
          <nav className={`flex flex-col gap-0.5 ${railExpanded ? 'px-3' : 'items-center'}`}>
            {NAV_SECTIONS.filter((s) => !s.footer).map(renderSection)}
          </nav>

          <div className="flex-1" />

          {/* Bottom: Docs + Daemon + Settings + User */}
          <div className={`flex flex-col gap-1 ${railExpanded ? 'px-3' : 'items-center'}`}>
            <RailExternalLink href="https://swarmclaw.ai/docs" label="Docs" description="Open documentation site" expanded={railExpanded}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
            </RailExternalLink>
            <RailExternalLink href={GITHUB_REPO_URL} label="Star on GitHub" description="Support SwarmClaw with a GitHub star" expanded={railExpanded}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
            </RailExternalLink>
            <RailExternalLink href={DISCORD_URL} label="Join Discord" description="Open the SwarmClaw community" expanded={railExpanded}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                <path d="M8 10h.01M12 10h.01M16 10h.01" />
              </svg>
            </RailExternalLink>
            {railExpanded && <DaemonIndicator />}
            {railExpanded ? (
              <NotificationCenter variant="row" align="left" direction="up" />
            ) : (
              <RailTooltip label="Notifications" description="View system notifications">
                <div className="rail-btn flex items-center justify-center">
                  <NotificationCenter align="left" direction="up" />
                </div>
              </RailTooltip>
            )}

            <nav className={`flex flex-col gap-0.5 ${railExpanded ? '' : 'items-center'}`}>
              {NAV_SECTIONS.filter((s) => s.footer).map(renderSection)}
            </nav>

            {railExpanded ? (
              <button
                onClick={onSwitchUser}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-sm cursor-pointer transition-all
                  bg-transparent hover:bg-layer-2 border-none"
                style={{ fontFamily: 'inherit' }}
              >
                <Avatar user={currentUser!} size="sm" avatarSeed={appSettings.userAvatarSeed} />
                <span className="text-[13px] font-500 text-text-2 capitalize truncate">{currentUser}</span>
              </button>
            ) : (
              <RailTooltip label="Profile" description="Edit your profile">
                <button onClick={onSwitchUser} className="mt-2 bg-transparent border-none cursor-pointer shrink-0">
                  <Avatar user={currentUser!} size="sm" avatarSeed={appSettings.userAvatarSeed} />
                </button>
              </RailTooltip>
            )}
          </div>
        </div>
      </div>

      {panelSection && (
        <NavSectionPanel
          section={panelSection}
          isViewEnabled={isViewEnabled}
          badges={badges}
          onSelectView={handleNavClick}
          onExtensionNavigate={handleExtensionNavClick}
        />
      )}
    </div>
  )
}

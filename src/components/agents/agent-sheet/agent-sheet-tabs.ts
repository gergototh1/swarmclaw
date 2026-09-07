/**
 * The six tabs the old 3065-line single scroll became.
 *
 * `sections` is how many of the original sixteen SectionCards each tab absorbed.
 * It is the record of where each card went, and what the test adds up to make
 * sure the split lost nothing. It is deliberately not shown in the tab strip:
 * a section can be hidden for a given provider, so the number would overstate
 * what the reader is actually looking at.
 */
export const AGENT_SHEET_TABS = [
  { key: 'essentials', label: 'Essentials', sections: 3 }, // Basics, Model & Connection, Instructions
  { key: 'behavior', label: 'Behavior', sections: 4 },     // Role & Autonomy, Behavior, Voice & Autonomy, Safety & Limits
  { key: 'tools', label: 'Tools', sections: 2 },           // Context & Tool Access, Tools & Skills
  { key: 'memory', label: 'Memory', sections: 2 },         // Memory & Intelligence, Continuity
  { key: 'network', label: 'Network', sections: 3 },       // Social Network, Marketplace, Routing & Infrastructure
  { key: 'advanced', label: 'Advanced', sections: 2 },     // Configuration History, Utilities
] as const

export type AgentTabKey = (typeof AGENT_SHEET_TABS)[number]['key']

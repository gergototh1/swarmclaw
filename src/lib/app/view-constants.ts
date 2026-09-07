import type { AppView } from '@/types'

// No live reader today — only its own declaration and the "merged views" test
// in view-constants.test.ts touch this map. It is kept as the exhaustiveness
// anchor over `AppView`: `Record<AppView, string>` forces every view (added or
// retired) to be reflected here, which is exactly the compiler pressure that
// drove this migration's cascade of fixes. Do not delete it, and do not treat
// it as live UI copy.
export const VIEW_LABELS: Record<AppView, string> = {
  home: 'Home',
  agents: 'Agents',
  org_chart: 'Org Chart',
  inbox: 'Inbox',
  chatrooms: 'Chatrooms',
  protocols: 'Sessions',
  schedules: 'Schedules',
  memory: 'Memory',

  tasks: 'Tasks',
  quality: 'Quality',
  missions: 'Missions',
  vault: 'Vault',
  providers: 'Providers',
  skills: 'Skills',
  connectors: 'Connectors',
  webhooks: 'Webhooks',
  mcp_servers: 'MCP Servers',
  knowledge: 'Knowledge',
  extensions: 'Extensions',
  usage: 'Usage',
  stream: 'Stream',
  autonomy: 'Autonomy',
  settings: 'Settings',
  projects: 'Projects',
  swarmfeed: 'Feed',
  marketplace: 'Marketplace',
}

// No live reader today — referenced only by its own declaration. Kept as an
// exhaustiveness anchor alongside VIEW_LABELS and VIEW_EMPTY_STATES so the
// next task can lean on the same type pressure rather than rebuilding it.
// Note: `vault` = 'Secret' is correct for the Secrets tab only. /vault is a
// two-tab page (Secrets, Wallets); a future live consumer will need this
// entry to be tab-aware rather than a single label for the merged view.
export const CREATE_LABELS: Partial<Record<AppView, string>> = {
  agents: 'Agent',
  schedules: 'Schedule',
  tasks: 'Task',
  missions: 'Mission',
  vault: 'Secret',
  providers: 'Provider',
  skills: 'Skill',
  connectors: 'Connector',
  webhooks: 'Webhook',
  mcp_servers: 'MCP Server',
  knowledge: 'Knowledge Entry',
  extensions: 'Extension',
  projects: 'Project',
}

export const VIEW_DESCRIPTIONS: Record<AppView, string> = {
  home: 'SwarmClaw overview',
  agents: 'Chat with & configure your AI agents',
  org_chart: 'Visual agent hierarchy and delegation topology',
  inbox: 'Review external connector conversations by platform and bridge',
  chatrooms: 'Multi-agent collaborative chatrooms',
  protocols: 'Temporary structured sessions and protocol-driven runs',
  schedules: 'Automated task schedules',
  memory: 'Long-term agent memory store',

  tasks: 'Task board for agent work and queued runs',
  quality: 'Operator quality center for evals, approvals, run review, and release readiness',
  missions: 'Autonomous goal-driven agent runs with budgets and morning reports',
  vault: 'API keys, tokens, and the wallets agents sign with',
  providers: 'LLM providers & custom endpoints',
  skills: 'Reusable instruction sets for agents',
  connectors: 'Chat platform bridges (Discord, Slack, etc.)',
  webhooks: 'Inbound HTTP triggers for event-driven workflows',
  mcp_servers: 'Connect agents to external MCP tool servers',
  knowledge: 'Shared knowledge base accessible by all agents',
  extensions: 'Manage external extensions and marketplace installs',
  usage: 'Usage metrics, cost tracking & agent performance',
  stream: 'Run history, entity audit trail, and application logs',
  autonomy: 'Estops, incidents, and runtime autonomy controls',
  settings: 'Manage defaults, providers, secrets, and automation settings',
  projects: 'Group agents, tasks & schedules into projects',
  swarmfeed: 'Social feed for AI agents to post, follow, and engage',
  marketplace: 'AI agent marketplace — browse tasks, agents, and skills on SwarmDock',
}

// No live reader today — referenced only by its own declaration. Kept as an
// exhaustiveness anchor: `Record<Exclude<AppView, 'agents' | 'home'>, ...>`
// forces every non-excluded view to carry an entry here, which is the same
// compiler pressure VIEW_LABELS and CREATE_LABELS anchor. Do not delete it,
// and do not treat it as live UI copy.
export const VIEW_EMPTY_STATES: Record<Exclude<AppView, 'agents' | 'home'>, { icon: string; title: string; description: string; features: string[] }> = {
  org_chart: {
    icon: 'git-branch',
    title: 'Org Chart',
    description: 'Visualize your agent hierarchy and delegation topology. Drag agents to rewire coordinator-worker relationships.',
    features: ['See who delegates to whom at a glance', 'Drag-and-drop to reparent agents under coordinators', 'Auto-wire delegationTargetAgentIds when you drop', 'Group agents into color-coded teams'],
  },
  chatrooms: {
    icon: 'message-square',
    title: 'Chatrooms',
    description: 'Multi-agent chatrooms for collaborative conversations. Add agents and use @mentions to trigger responses.',
    features: ['Create chatrooms with multiple AI agents', 'Use @AgentName to trigger specific agents', '@all mentions trigger all agents sequentially', 'Agents can chain by mentioning each other'],
  },
  protocols: {
    icon: 'list',
    title: 'Structured Sessions',
    description: 'Run temporary bounded sessions from chats, chatrooms, tasks, or schedules without turning every surface into a workflow engine.',
    features: ['Start one-agent or multi-agent structured sessions from context', 'Use neutral built-in templates like review, discussion, and decision rounds', 'Keep a hidden transcript plus durable run events', 'Archive the outcome and post a compact summary back when needed'],
  },
  schedules: {
    icon: 'clock',
    title: 'Schedules',
    description: 'Automate recurring work with cron, interval, or one-time schedules that launch agent tasks.',
    features: ['Set up cron expressions for precise timing', 'Run agents automatically on intervals', 'Schedule one-time future tasks', 'View execution history and results'],
  },
  memory: {
    icon: 'database',
    title: 'Memory',
    description: 'Long-term memory store for AI agents so they can retain useful context across conversations.',
    features: ['Agents store findings and learnings automatically', 'Full-text search across all stored memories', 'Organized by categories and agents', 'Persists across conversations for continuity'],
  },

  tasks: {
    icon: 'clipboard',
    title: 'Task Board',
    description: 'A kanban board for managing agent work. Create tasks, assign them to agents, and track progress.',
    features: ['Kanban columns: Backlog, Queued, Running, Completed, Failed', 'Assign tasks to specific agents', 'Track retries, results, and logs', 'Review status without leaving the board'],
  },
  quality: {
    icon: 'badge-check',
    title: 'Quality',
    description: 'Operator center for trusting autonomous agents before, during, and after a release.',
    features: ['Review run health, failed work, and pending approvals', 'Run scenario and suite evals against selected agents', 'Approve or reject human-loop, tool, connector, and skill requests', 'Inspect replay evidence from recent agent runs'],
  },
  missions: {
    icon: 'target',
    title: 'Missions',
    description: 'Hand your agent team a goal and let them run overnight. Budgets, periodic reports, and a full timeline you can review in the morning.',
    features: ['Set USD, token, turn, and wallclock caps enforced at the session level', 'Periodic markdown reports delivered as in-app notifications', 'Full milestone timeline with evidence and end reasons', 'Start, pause, resume, and cancel from the dashboard or CLI'],
  },
  vault: {
    icon: 'lock',
    title: 'Vault',
    description: 'Manage API keys, encrypted secrets, and the crypto wallets agents sign transactions with.',
    features: ['Store keys for external services (Gmail, APIs, etc.), encrypted at rest with AES-256-GCM', 'Generate wallets with encrypted private keys and daily USDC spending limits', 'Scope secrets and wallets globally or to specific agents', 'Require human approval for on-chain transactions'],
  },
  providers: {
    icon: 'zap',
    title: 'Providers',
    description: 'Manage LLM providers including built-in and custom OpenAI-compatible endpoints.',
    features: ['Built-in support for OpenAI, OpenRouter, Anthropic, Ollama, Hermes Agent, and CLI runtimes', 'Add custom OpenAI-compatible providers for local or internal gateways', 'Configure base URLs, models, and API keys per provider', 'Built-in and custom providers work seamlessly with all features'],
  },
  skills: {
    icon: 'book',
    title: 'Skills',
    description: 'Manage reusable instruction sets, runtime skill selection, and reviewed skill drafts generated from real conversations.',
    features: ['Upload markdown files with specialized instructions', 'Approve reviewed skill drafts from conversations', 'Assign skills to specific agents', 'Use runtime skill recommendations during execution'],
  },
  connectors: {
    icon: 'link',
    title: 'Connectors',
    description: 'Bridge chat platforms to your AI agents. Receive messages from Discord, Telegram, Slack, or WhatsApp and route them to agents.',
    features: ['Connect Discord, Telegram, Slack, or WhatsApp bots', 'Route incoming messages to any agent', 'Each platform channel gets its own chat thread', 'Start and stop connectors from the UI'],
  },
  inbox: {
    icon: 'inbox',
    title: 'Inbox',
    description: 'Inspect external connector conversations in a dedicated inbox, separated from the main agent chats.',
    features: ['Filter by connector platform', 'Switch between connector instances', 'Review isolated sender transcripts', 'Keep the main chat focused on your own thread'],
  },
  webhooks: {
    icon: 'webhook',
    title: 'Webhooks',
    description: 'Receive external events over HTTP and route them into agent-driven workflows automatically.',
    features: ['Create secure inbound webhook endpoints', 'Filter events by type or source', 'Route each webhook to a specific agent', 'Use x-webhook-secret for request authentication'],
  },
  mcp_servers: {
    icon: 'server',
    title: 'MCP Servers',
    description: 'Connect agents to external MCP (Model Context Protocol) servers, injecting their tools into agent chats.',
    features: ['Configure stdio, SSE, or streamable HTTP transports', 'Test connections and discover available tools', 'Assign MCP servers to specific agents', 'Tools appear alongside built-in tools in chat'],
  },
  knowledge: {
    icon: 'globe',
    title: 'Knowledge Base',
    description: 'A shared knowledge graph accessible by all agents for cross-workspace information sharing.',
    features: ['Create tagged knowledge entries', 'Agents can store and search knowledge via tools', 'Full-text and vector search', 'Provenance tracking per entry'],
  },
  extensions: {
    icon: 'puzzle',
    title: 'Extensions',
    description: 'Install external extensions from the marketplace, a URL, or local extension files.',
    features: ['Install extensions from the marketplace or a URL', 'Toggle extensions on/off', 'External hooks, tools, and UI modules', 'Compatible with OpenClaw extension format'],
  },
  usage: {
    icon: 'bar-chart',
    title: 'Usage',
    description: 'Track token usage and costs across all providers and agents.',
    features: ['Per-provider cost breakdown', 'Token usage over time', 'Per-agent cost tracking', 'Export usage data'],
  },
  stream: {
    icon: 'activity',
    title: 'Stream',
    description: 'Run history, the entity audit trail, and application logs in one place.',
    features: ['Monitor queued and running tasks, view run results and errors', 'Audit trail of all entity mutations, filterable by type and action', 'Application logs and errors with live auto-refresh', 'Cancel pending runs and track automatic retries'],
  },
  autonomy: {
    icon: 'shield',
    title: 'Autonomy',
    description: 'Control runtime autonomy, estops, and recent incident history.',
    features: ['Engage autonomy-only or full estops', 'Review incident families and remediation guidance', 'Request approval-backed resume flows', 'Inspect the current runtime safety state'],
  },
  settings: {
    icon: 'settings',
    title: 'Settings',
    description: 'Manage app defaults, providers, encrypted secrets, and automation settings.',
    features: ['Choose your default agent shortcut', 'Configure LLM providers and credentials', 'Tune heartbeat and autonomy settings', 'Set up voice, embeddings, and search'],
  },
  projects: {
    icon: 'folder',
    title: 'Projects',
    description: 'Organize your work into projects. Group agents, tasks, and schedules under a common scope.',
    features: ['Create named projects with color badges', 'Assign agents and tasks to projects', 'Filter sidebar views by project', 'Global view when no filter is active'],
  },
  swarmfeed: {
    icon: 'rss',
    title: 'Feed',
    description: 'A social feed where your AI agents post updates, follow each other, and engage with content.',
    features: ['Agents post status updates and insights', 'Follow agents and browse trending content', 'Channel-based topic organization', 'Like, repost, and reply interactions'],
  },
  marketplace: {
    icon: 'store',
    title: 'Marketplace',
    description: 'Browse the SwarmDock agent marketplace — discover tasks, agents, and skills.',
    features: ['Browse available tasks and bid on work', 'View registered agents and their skills', 'Track task status and completions', 'USDC-based payments on Base L2'],
  },
}

export const FULL_WIDTH_VIEWS = new Set<AppView>([
  'home', 'org_chart', 'inbox', 'chatrooms', 'protocols', 'schedules', 'vault', 'providers', 'skills',
  'connectors', 'webhooks', 'mcp_servers', 'knowledge', 'extensions',
  'usage', 'stream', 'quality', 'autonomy', 'settings', 'projects', 'swarmfeed', 'marketplace', 'missions',
])

// `stream` and `vault` are deliberately absent: the route layouts that used to
// render a SidebarPanelShell next to `runs`, `logs`, `secrets` and `wallets`
// were dropped when those routes became plain redirects into /stream and
// /vault. Keeping either merged view here would set `sidebarOpen` true with no
// panel behind it, and that flag would then leak into the next panel-backed
// view the user opens.
export const PANEL_SIDEBAR_VIEWS = new Set<AppView>([
  'agents',
  'connectors',
  'extensions',
  'knowledge',
  'mcp_servers',
  'memory',
  'providers',
  'schedules',
  'skills',
  'tasks',
  'webhooks',
])

export function isPanelSidebarView(view: AppView | null | undefined): boolean {
  return Boolean(view && PANEL_SIDEBAR_VIEWS.has(view))
}

export function shouldAutoOpenPanelSidebar(view: AppView | null | undefined, isDesktop: boolean): boolean {
  return isDesktop && isPanelSidebarView(view)
}

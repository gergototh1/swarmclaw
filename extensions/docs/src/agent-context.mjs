import { homeFolderOf } from './permissions.mjs'
import { actorOf } from './tools.mjs'

/**
 * Telling the agent what it already has.
 *
 * This is the cheapest part of the module and probably the most valuable. An
 * agent that does not know documents exist never calls the search tool, so
 * every other thing here would sit unused. A short table of contents in front
 * of the turn is what turns the tools from available into used.
 *
 * Three rules it keeps:
 *
 * It never throws. A root that is missing or unreadable must not stop an agent
 * from holding a conversation, so a failure logs and contributes nothing.
 *
 * It adds nothing when there is nothing. An empty "Docs:" heading over no
 * items is noise in every prompt for no benefit, so an empty listing returns
 * null instead.
 *
 * It shortens rather than truncates. Over budget, whole lines come off the end;
 * a line cut in half would leave a partial path that looks like a real one.
 */

const OWN_LIMIT = 30
const SHARED_LIMIT = 10
/** 1500 tokens, measured as characters at the usual four-per-token rule. */
const CHAR_BUDGET = 6000

function line(doc) {
  return `- ${doc.title} — ${doc.path}`
}

/** Joins lines under a heading, dropping lines from the end to fit. */
function fit(sections, budget) {
  const flat = []
  for (const section of sections) {
    if (section.lines.length === 0) continue
    flat.push({ text: section.heading, droppable: false })
    for (const l of section.lines) flat.push({ text: l, droppable: true })
  }
  if (flat.length === 0) return null

  let text = flat.map((f) => f.text).join('\n')
  while (text.length > budget) {
    const lastDroppable = flat.map((f) => f.droppable).lastIndexOf(true)
    if (lastDroppable === -1) break
    flat.splice(lastDroppable, 1)
    text = flat.map((f) => f.text).join('\n')
  }
  return text
}

export function createAgentContext(state, { serviceOf, sharedFolder, logOf }) {
  function getAgentContext(ctx) {
    try {
      const actor = actorOf(ctx)
      const service = serviceOf()
      const home = homeFolderOf(actor)

      const own = home ? service.list(actor, { folder: home, limit: OWN_LIMIT }) : []
      const shared = service.list(actor, { folder: sharedFolder(), limit: SHARED_LIMIT })

      return fit([
        { heading: `## Your docs (${home ?? sharedFolder()})`, lines: own.map(line) },
        { heading: `## Shared docs (${sharedFolder()})`, lines: shared.map(line) },
      ], CHAR_BUDGET)
    } catch (err) {
      logOf()?.warn?.('docs agent context skipped', { error: err?.message })
      return null
    }
  }

  function getCapabilityDescription() {
    return 'I can read, search and write durable markdown docs; I have a folder of my own and can reach the shared folder.'
  }

  function getOperatingGuidance() {
    return [
      'Anything you write for the user or another agent to read — a report, summary, plan, estimate, research note — goes into Docs with docs_write, not into a file in your working directory (Write, Bash, `cat >`). Working files (code, config, temporary files, video assets) stay in your working directory. Once a doc is written, naming its title in your reply is enough: the user opens it from the chat.',
      'Before changing a doc, always read it with docs_read and pass back the version you got as baseVersion. Without it docs_write refuses the change.',
      'If you get a conflict, someone else changed the doc meanwhile: read it again, merge your change into the fresh content, and write again with the new version. Never blindly overwrite the other version.',
      "You cannot write into another agent's folder, but you can read from it. Put shared material into the shared folder.",
    ]
  }

  /**
   * What an agent on a CLI provider is told up front, through MCP.
   *
   * Short on purpose: it lands in every system prompt of every agent the
   * server is assigned to. The details stay in the tool descriptions, which
   * the agent reads once it has decided to use a tool -- this only has to make
   * it decide.
   */
  function getMcpInstructions() {
    return [
      'Docs is the shared home for durable markdown documents: every agent has its own folder, and everyone can write into the shared folder.',
      'Anything you write for the user or another agent to read — a report, summary, plan, estimate, research note — goes into Docs with docs_write, never into a file in your working directory. Working files (code, config, temporary files, assets) stay where they are.',
      'To change a doc, read it with docs_read first and pass its version back as baseVersion.',
      `The shared folder is "${sharedFolder()}".`,
      'After writing a doc, name its title in your reply; the user opens it from the chat.',
    ].join('\n')
  }

  return { getAgentContext, getCapabilityDescription, getOperatingGuidance, getMcpInstructions }
}

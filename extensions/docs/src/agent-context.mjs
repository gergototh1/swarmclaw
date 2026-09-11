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
 * It adds nothing when there is nothing. An empty "Doksik:" heading over no
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
    return 'I can read, search and write durable markdown docs; I have my own folder, and I can reach the shared folder too.'
  }

  function getOperatingGuidance() {
    return [
      'Write a doc when the result stays valuable after the conversation ends — a research summary, a customer profile, the reasoning behind a decision. Do not write a passing train of thought into one.',
      'Before changing a doc, always read it first with docs_read, and pass back the version number you got as baseVersion. Without it docs_write refuses the change.',
      'If you get a conflict, someone else wrote to the doc meanwhile: read it again, merge your change into the fresh content, and write it back with the new version number. Do not blindly overwrite the other version.',
      'You cannot write into another agent\'s folder, but you can read from it. If you are producing shared material, put it in the shared folder.',
    ]
  }

  return { getAgentContext, getCapabilityDescription, getOperatingGuidance }
}

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

      const own = home ? service.list(actor, { mappa: home, limit: OWN_LIMIT }) : []
      const shared = service.list(actor, { mappa: sharedFolder(), limit: SHARED_LIMIT })

      return fit([
        { heading: `## A te doksijaid (${home ?? sharedFolder()})`, lines: own.map(line) },
        { heading: `## Közös doksik (${sharedFolder()})`, lines: shared.map(line) },
      ], CHAR_BUDGET)
    } catch (err) {
      logOf()?.warn?.('docs agent context skipped', { error: err?.message })
      return null
    }
  }

  function getCapabilityDescription() {
    return 'Tartós markdown-doksikat tudok olvasni, keresni és írni; van saját mappám, és a közös mappát is elérem.'
  }

  function getOperatingGuidance() {
    return [
      'Írj doksit, ha az eredmény a beszélgetés után is értékes marad — kutatási összefoglaló, ügyfélprofil, döntés indoklása. Átmeneti gondolatmenetet ne írj bele.',
      'Módosítás előtt mindig olvasd be a doksit a doksi_olvas hívással, és add vissza a kapott verziószámot baseVersion néven. Enélkül a doksi_ir elutasítja a módosítást.',
      'Ha ütközést kapsz, a doksit közben más írta át: olvasd újra, fésüld össze a változtatásodat a friss tartalommal, és írd újra az új verziószámmal. Ne írd felül a másik változatot vakon.',
      'Más ügynök mappájába nem tudsz írni, de olvasni onnan is tudsz. Ha közös anyagot készítesz, a közös mappába tedd.',
    ]
  }

  return { getAgentContext, getCapabilityDescription, getOperatingGuidance }
}

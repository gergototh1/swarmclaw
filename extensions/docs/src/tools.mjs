import { DocsError, HIBA, hiba } from './errors.mjs'
import { agentSlug } from './permissions.mjs'

/**
 * The six tools an agent uses, as a thin skin over `service.mjs`.
 *
 * Two rules hold for every one of them.
 *
 * NONE OF THEM THROWS. An agent acts on the text it reads back, and a thrown
 * exception reaches it as a harness error with no instructions in it. So every
 * handler catches, and a failure comes back as `{ hiba, uzenet }` where the
 * message says what to do next.
 *
 * NONE OF THEM TAKES THE CALLER'S IDENTITY AS AN ARGUMENT. Who is calling comes
 * from the session the host attached to the call. If a tool argument could name
 * the actor, a model could name somebody else and write into their folder.
 */

/**
 * Who is calling, from what the host said rather than what was asked for.
 *
 * The host builds this object as `{ ...ctx, ...buildContext }`
 * (src/lib/server/session-tools/index.ts), so the agent arrives in more than
 * one shape: `agentId` is on the outer context, and `agentRecord` is the whole
 * Agent, name included. The name matters, because it is what the folder is
 * called: without it the slug falls back to the first characters of the id and
 * an operator opening the vault in Finder sees `agents/c3377d/` where
 * `agents/gtassistant/` was the entire point.
 */
export function actorOf(ctx) {
  const session = ctx?.session ?? {}
  const record = session.agentRecord ?? session.agent ?? null
  const id = session.agentId ?? record?.id ?? ''
  const name = record?.name ?? session.agentName ?? ''
  if (!id && !name) return { kind: 'user' }
  return { kind: 'agent', slug: agentSlug(name, id) }
}

/** Runs a handler, turning any DocsError into the response shape. */
async function guard(log, fn) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof DocsError) {
      return err.details ? { ...hiba(err.code, err.message), ...err.details } : hiba(err.code, err.message)
    }
    log?.error?.('docs tool failed', { error: err?.message })
    return hiba(HIBA.rossz_parameter, `A művelet nem sikerült: ${err?.message ?? 'ismeretlen hiba'}`)
  }
}

const STR = { type: 'string' }
const NUM = { type: 'integer' }

export function createTools(state, { serviceOf, logOf }) {
  const run = (fn) => guard(logOf(), fn)

  return [
    {
      name: 'doksi_lista',
      description: 'Kilistázza a doksikat. Szűrés nélkül a saját mappádat és a közös mappát adja. Add meg a "mappa" mezőt, ha máshova akarsz nézni — olvasni mindenhonnan tudsz.',
      parameters: {
        type: 'object',
        properties: {
          mappa: { ...STR, description: 'Mappa útvonala, pl. "agents/kutato" vagy "kozos".' },
          tag: { ...STR, description: 'Csak az ezzel a taggel ellátott doksik.' },
          limit: { ...NUM, description: 'Legfeljebb ennyi találat (alap: 100).' },
        },
      },
      execute: (args, ctx) => run(() => {
        const docs = serviceOf().list(actorOf(ctx), { mappa: args.mappa, tag: args.tag, limit: args.limit ?? 100 })
        return {
          doksik: docs.map((d) => ({
            id: d.id, cim: d.title, utvonal: d.path, tulajdonos: d.owner, frissitve: d.updated, tagek: d.tags,
          })),
        }
      }),
    },
    {
      name: 'doksi_olvas',
      description: 'Beolvas egy doksit id vagy útvonal alapján. A válaszban kapott "verzio" számot őrizd meg: a doksi_ir ezt kéri baseVersion néven.',
      parameters: {
        type: 'object',
        properties: { id: { ...STR, description: 'A doksi id-je vagy útvonala.' } },
        required: ['id'],
      },
      execute: (args) => run(() => serviceOf().read(args.id)),
    },
    {
      name: 'doksi_keres',
      description: 'Teljes szöveges keresés a doksik között. Ékezetre és kis-nagybetűre érzéketlen.',
      parameters: {
        type: 'object',
        properties: {
          q: { ...STR, description: 'A keresett kifejezés.' },
          mappa: { ...STR, description: 'Csak ebben a mappában keressen.' },
          limit: { ...NUM, description: 'Legfeljebb ennyi találat (alap: 20).' },
        },
        required: ['q'],
      },
      execute: (args) => run(() => ({
        talalatok: serviceOf().search(args.q, { mappa: args.mappa, limit: args.limit ?? 20 }),
      })),
    },
    {
      name: 'doksi_ir',
      description: 'Létrehoz vagy módosít egy doksit. Új doksinál a "cim" kötelező, és mappa megadása nélkül a saját mappádba kerül. Módosításnál az "id" és a "baseVersion" is kötelező — előbb olvasd be a doksit, és add vissza a kapott verziószámot. Ha közben más írt bele, ütközést kapsz vissza, és a doksi változatlan marad.',
      parameters: {
        type: 'object',
        properties: {
          id: { ...STR, description: 'Módosításnál a doksi id-je. Új doksinál hagyd üresen.' },
          baseVersion: { ...NUM, description: 'Módosításnál kötelező: a doksi_olvas által adott verziószám.' },
          cim: { ...STR, description: 'A doksi címe. Új doksinál kötelező.' },
          tartalom: { ...STR, description: 'A doksi törzse markdownban.' },
          mappa: { ...STR, description: 'Új doksinál a célmappa. Alapból a saját mappád.' },
          tagek: { type: 'array', items: STR, description: 'Címkék.' },
          sablon: { ...STR, description: 'Új doksinál egy sablon neve a "_sablonok" mappából.' },
        },
      },
      execute: (args, ctx) => run(() => {
        const actor = actorOf(ctx)
        const service = serviceOf()
        return args.id
          ? service.update(actor, args)
          : service.create(actor, args)
      }),
    },
    {
      name: 'doksi_mozgat',
      description: 'Áthelyez egy doksit másik mappába vagy útvonalra. A rá mutató hivatkozásokat nem érinti — átnevezéshez a doksi_ir "cim" mezőjét használd.',
      parameters: {
        type: 'object',
        properties: {
          id: { ...STR, description: 'A doksi id-je.' },
          ujMappa: { ...STR, description: 'A célmappa.' },
          ujUtvonal: { ...STR, description: 'Teljes új útvonal, ha a fájlnevet is cserélnéd.' },
        },
        required: ['id'],
      },
      execute: (args, ctx) => run(() => serviceOf().move(actorOf(ctx), args)),
    },
    {
      name: 'doksi_torol',
      description: 'A kukába teszi a doksit. Nem végleges: az operátor vissza tudja állítani a Doksik lapról.',
      parameters: {
        type: 'object',
        properties: { id: { ...STR, description: 'A doksi id-je.' } },
        required: ['id'],
      },
      execute: (args, ctx) => run(() => serviceOf().remove(actorOf(ctx), args)),
    },
  ]
}

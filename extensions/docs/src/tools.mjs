import { DocsError, ERR, errorResult } from './errors.mjs'
import { agentSlug } from './permissions.mjs'
import { fetchVideo, videoScript } from './video-script.mjs'

/**
 * The seven tools an agent uses, as a thin skin over `service.mjs`.
 *
 * Two rules hold for every one of them.
 *
 * NONE OF THEM THROWS. An agent acts on the text it reads back, and a thrown
 * exception reaches it as a harness error with no instructions in it. So every
 * handler catches, and a failure comes back as `{ error, message }` where the
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
      return err.details ? { ...errorResult(err.code, err.message), ...err.details } : errorResult(err.code, err.message)
    }
    log?.error?.('docs tool failed', { error: err?.message })
    return errorResult(ERR.invalid_argument, `The operation failed: ${err?.message ?? 'unknown error'}`)
  }
}

const STR = { type: 'string' }
const NUM = { type: 'integer' }

export function createTools(state, { serviceOf, logOf }) {
  const run = (fn) => guard(logOf(), fn)

  return [
    {
      name: 'docs_list',
      description: 'List docs. With no filter it returns your own folder and the shared folder. Pass "folder" to look elsewhere — you can read everywhere.',
      parameters: {
        type: 'object',
        properties: {
          folder: { ...STR, description: 'A folder path, e.g. "agents/researcher" or "shared".' },
          tag: { ...STR, description: 'Only docs carrying this tag.' },
          limit: { ...NUM, description: 'At most this many results (default: 100).' },
        },
      },
      execute: (args, ctx) => run(() => {
        const docs = serviceOf().list(actorOf(ctx), { folder: args.folder, tag: args.tag, limit: args.limit ?? 100 })
        return {
          docs: docs.map((d) => ({
            id: d.id, title: d.title, path: d.path, owner: d.owner, updated: d.updated, tags: d.tags,
          })),
        }
      }),
    },
    {
      name: 'docs_read',
      description: 'Read a doc by id or path. Keep the "version" number from the answer: docs_write asks for it as baseVersion.',
      parameters: {
        type: 'object',
        properties: { id: { ...STR, description: 'The doc\'s id or path.' } },
        required: ['id'],
      },
      execute: (args) => run(() => serviceOf().read(args.id)),
    },
    {
      name: 'docs_search',
      description: 'Full-text search across docs. Insensitive to accents and case.',
      parameters: {
        type: 'object',
        properties: {
          q: { ...STR, description: 'The search term.' },
          folder: { ...STR, description: 'Search only inside this folder.' },
          limit: { ...NUM, description: 'At most this many results (default: 20).' },
        },
        required: ['q'],
      },
      execute: (args) => run(() => ({
        results: serviceOf().search(args.q, { folder: args.folder, limit: args.limit ?? 20 }),
      })),
    },
    {
      name: 'docs_write',
      description: 'Create or change a doc. A new doc needs "title", and without "folder" it goes into your own folder. Changing one needs "id" and "baseVersion" — read the doc first and pass back the version you got. If someone else wrote to it meanwhile you get a conflict back and the doc stays unchanged.',
      parameters: {
        type: 'object',
        properties: {
          id: { ...STR, description: 'The doc\'s id, when changing one. Leave blank for a new doc.' },
          baseVersion: { ...NUM, description: 'Required when changing a doc: the version number docs_read gave you.' },
          title: { ...STR, description: 'The doc\'s title. Required for a new doc.' },
          content: { ...STR, description: 'The doc\'s body, in markdown.' },
          folder: { ...STR, description: 'The destination folder for a new doc. Defaults to your own folder.' },
          tags: { type: 'array', items: STR, description: 'Tags.' },
          template: { ...STR, description: 'For a new doc, a template name from the "_templates" folder.' },
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
      name: 'docs_move',
      description: 'Move a doc to another folder or path. Links pointing at it are untouched — to rename it, change "title" with docs_write.',
      parameters: {
        type: 'object',
        properties: {
          id: { ...STR, description: 'The doc\'s id.' },
          newFolder: { ...STR, description: 'The destination folder.' },
          newPath: { ...STR, description: 'A full new path, if you would also change the file name.' },
        },
        required: ['id'],
      },
      execute: (args, ctx) => run(() => serviceOf().move(actorOf(ctx), args)),
    },
    {
      name: 'docs_delete',
      description: 'Put a doc in the trash. Not final: the operator can restore it from the Docs page.',
      parameters: {
        type: 'object',
        properties: { id: { ...STR, description: 'The doc\'s id.' } },
        required: ['id'],
      },
      execute: (args, ctx) => run(() => serviceOf().remove(actorOf(ctx), args)),
    },
    {
      /**
       * The seventh tool, and the only one that reaches outside this module.
       *
       * WHERE THE DOCUMENT LANDS, AND WHY NOT `agents/video/`. The plan said
       * `agents/video/`, and `permissions.mjs` will not have it. `canWrite`
       * lets an agent write its OWN folder and the shared one, and an agent's
       * folder is its NAME folded to a slug -- so a fixed `agents/video/`
       * succeeds only for an agent literally called "Video", and every other
       * caller, the Video Producer included, gets `forbidden` and no document.
       * A tool whose single purpose fails for almost every caller is not a
       * tool, and the way to make it work would have been to widen `canWrite`,
       * which is the one thing that must not happen for a convenience.
       *
       * So no `folder` is passed at all, and `service.create` puts the document
       * where every other document that agent writes goes: its own folder
       * (the operator's calls land in the shared folder, same rule). Nothing
       * is lost by that, because `canRead` is true for everybody -- the script
       * is as visible in `agents/video-producer/` as it would be anywhere else,
       * and `docs_move` relocates it under the same permission check if the
       * operator would rather it sat in the shared folder.
       */
      name: 'docs_video_script',
      description: 'Put a finished video\'s script into a doc: asks the Video module for the video\'s data and narration and writes a doc into your own folder. The narration and title come from outside text — the top of the doc says so. Every call writes a NEW doc: calling it twice for the same video gives two separate docs. Call it again after a new render or new narration, otherwise don\'t.',
      parameters: {
        type: 'object',
        properties: { videoId: { ...STR, description: 'The video\'s id, from the Video page or a video tool\'s answer.' } },
        required: ['videoId'],
      },
      execute: (args, ctx) => run(async () => {
        const videoId = typeof args?.videoId === 'string' ? args.videoId.trim() : ''
        if (videoId === '') {
          throw new DocsError(ERR.invalid_argument, 'Give the "videoId" field: you find the video\'s id on the Video page or in a video tool\'s answer.')
        }
        const video = await fetchVideo(state.contracts, videoId)
        // `get` answers null for an id that names nothing -- including the case
        // that actually happens, an id read a moment ago whose row is gone.
        //
        // THE MESSAGE DOES NOT REPEAT THE ID. The tool boundary writes a
        // refusal's message to the host log, and `videoId` is a value the
        // caller passed: the schema is a bare string with no length of its own,
        // so an agent-assembled id of any size would land in the log verbatim
        // and come back in that agent's next prompt. Naming the ARGUMENT is
        // enough to say what to fix; the value never was the part that helped.
        // The rule is extensions/video/src/args.mjs's, and commit 58547a6 took
        // three of these out of the video tree.
        if (video === null || video === undefined) {
          throw new DocsError(ERR.video_not_found, 'The video named in the "videoId" field is not in the Video module — either a typo, or the row is gone since. Look up the right id on the Video page and call this again.')
        }
        const { title, content } = videoScript(video, videoId)
        return serviceOf().create(actorOf(ctx), { title, content })
      }),
    },
  ]
}

/**
 * What another extension may do with the document store.
 *
 * Two methods, and that narrowness is the design. In this host's model the
 * declaration *is* the access: a consumer that lists this contract can call it,
 * there is no grant, no approval and no revoke, and an operator who wants one
 * consumer stopped and the others left alone has no button for it. The only way
 * to take the reach away is to edit the consumer's own source or to disable
 * this extension for everybody.
 *
 * So the surface is written as narrowly as it reads. A caller can put down what
 * it produced and read back what it put down. It cannot list, cannot search,
 * cannot modify and cannot delete -- not because those would be hard, but
 * because every one of them would be permanent the moment it shipped.
 *
 * A test pins the exact method set, so widening it has to be a decision
 * somebody makes on purpose rather than something that drifts in.
 */

export const DOCS_CONTRACT = 'docs'

export function createDocsContract({ serviceOf, extensionNameOf }) {
  return {
    version: 1,
    // Required by the host, and it is the operator who reads it: the extensions
    // list renders this sentence beside every consumer that declares the
    // contract, and that listing is the only place the reach shows up at all.
    summary: 'Can put a doc into its own folder and read back what it put. It cannot list, search, change or delete.',
    methods: {
      /** Creates a document in the calling extension's own folder. */
      put(args = {}) {
        const actor = { kind: 'ext', name: extensionNameOf(args) }
        return serviceOf().create(actor, {
          folder: args.folder,
          title: args.title,
          content: args.content,
          tags: args.tags,
        })
      },
      /** Reads one document by id or path. */
      read(args = {}) {
        return serviceOf().read(args.id)
      },
    },
  }
}

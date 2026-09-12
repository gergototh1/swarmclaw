/**
 * Every failure this module can name, in one table.
 *
 * The value equals the key on purpose. A caller may write `ERR.conflict` or the
 * literal `'conflict'` and get the same string either way, and a test pins that
 * so the two spellings cannot drift apart. These codes reach the agent in a
 * tool response and the page switches on them, which makes a code part of the
 * contract rather than a log line: renaming one is a breaking change, and
 * adding one is a decision.
 */
export const ERR = Object.freeze({
  /** The configured root is unset, missing, or not writable. */
  root_not_writable: 'root_not_writable',
  /** A path that would leave the root, or a symlink inside it pointing out. */
  path_forbidden: 'path_forbidden',
  /** No document at that id or path. */
  doc_not_found: 'doc_not_found',
  /** The actor may read this path but not write it. */
  forbidden: 'forbidden',
  /** `baseVersion` did not match the document's current version. */
  conflict: 'conflict',
  /** Something already occupies the target path. */
  already_exists: 'already_exists',
  /** A required argument was missing, or had the wrong shape. */
  invalid_argument: 'invalid_argument',
  /**
   * A contract this module `consumes` did not resolve to a handle.
   *
   * The eighth code, and it was not free. The alternative was
   * `invalid_argument`, and it is wrong here in the direction that costs the
   * most: nothing about the call was wrong, so an agent reading it would fix
   * its arguments forever and never get anywhere. The move is the operator's --
   * install the provider, switch it back on, or update one of the two modules
   * -- and none of the seven existing sentences says any of that. The message
   * this code carries names the host's own reason word, because those four
   * reasons are four different operator actions.
   */
  contract_missing: 'contract_missing',
  /**
   * The contract answered, and there is no video at that id.
   *
   * The ninth code, and it is here for the reason the eighth is. It used to
   * share `invalid_argument` with the refusal one line above it -- "you sent no
   * videoId" -- and those are two different facts about the same argument. The
   * first is the call's shape and the agent fixes it by filling the field in;
   * the second is the world, and the agent fixes it by looking the id up again
   * or accepting that the row is gone. One code for both leaves an agent
   * re-checking its arguments over a row that no longer exists.
   *
   * `doc_not_found` was not reused: that one is about this vault's own
   * documents, and the page switches on it. This is about another module's
   * row.
   */
  video_not_found: 'video_not_found',
})

/**
 * An error carrying one of the codes above.
 *
 * Thrown inside `src/`, caught at the tool and rpc boundary and turned into the
 * `errorResult()` shape there. Nothing outside this module throws or catches it,
 * which is what lets every tool promise never to throw.
 */
export class DocsError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DocsError'
    this.code = code
  }
}

/**
 * The response shape every tool and rpc handler returns on failure.
 *
 * `message` is written for whoever reads it next -- usually an agent deciding
 * what to do about it -- so it says what to do rather than what happened:
 * "Read it again and write it back with the new version number", not "version
 * mismatch".
 */
export function errorResult(code, message) {
  return { error: code, message }
}

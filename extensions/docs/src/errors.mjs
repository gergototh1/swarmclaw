/**
 * Every failure this module can name, in one table.
 *
 * The value equals the key on purpose. A caller may write `HIBA.utkozes` or the
 * literal `'utkozes'` and get the same string either way, and a test pins that
 * so the two spellings cannot drift apart. These codes reach the agent in a
 * tool response and the page switches on them, which makes a code part of the
 * contract rather than a log line: renaming one is a breaking change, and
 * adding one is a decision.
 */
export const HIBA = Object.freeze({
  /** The configured root is unset, missing, or not writable. */
  gyoker_nem_irhato: 'gyoker_nem_irhato',
  /** A path that would leave the root, or a symlink inside it pointing out. */
  utvonal_tiltott: 'utvonal_tiltott',
  /** No document at that id or path. */
  nincs_ilyen_doksi: 'nincs_ilyen_doksi',
  /** The actor may read this path but not write it. */
  nincs_jog: 'nincs_jog',
  /** `baseVersion` did not match the document's current version. */
  utkozes: 'utkozes',
  /** Something already occupies the target path. */
  mar_letezik: 'mar_letezik',
  /** A required argument was missing, or had the wrong shape. */
  rossz_parameter: 'rossz_parameter',
  /**
   * A contract this module `consumes` did not resolve to a handle.
   *
   * The eighth code, and it was not free. The alternative was
   * `rossz_parameter`, and it is wrong here in the direction that costs the
   * most: nothing about the call was wrong, so an agent reading it would fix
   * its arguments forever and never get anywhere. The move is the operator's --
   * install the provider, switch it back on, or update one of the two modules
   * -- and none of the seven existing sentences says any of that. The message
   * this code carries names the host's own reason word, because those four
   * reasons are four different operator actions.
   */
  szerzodes_hianyzik: 'szerzodes_hianyzik',
})

/**
 * An error carrying one of the codes above.
 *
 * Thrown inside `src/`, caught at the tool and rpc boundary and turned into the
 * `hiba()` shape there. Nothing outside this module throws or catches it, which
 * is what lets every tool promise never to throw.
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
 * `uzenet` is written for whoever reads it next -- usually an agent deciding
 * what to do about it -- so it says what to do rather than what happened:
 * "Olvasd újra és írd újra az új verziószámmal", not "version mismatch".
 */
export function hiba(code, uzenet) {
  return { hiba: code, uzenet }
}

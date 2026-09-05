import { readNoArgs, readSynthesisArgs } from './args.mjs'

/**
 * What another extension may ask this one for: a sentence as an mp3 at a
 * path the caller names, and the current settings.
 *
 * This is a `provides` declaration, the host-mediated way one extension
 * reaches another's code (`src/lib/server/extensions/extension-contracts.ts`).
 * A consumer reaches these two methods only after naming this extension, this
 * contract and this version in its own `consumes`, with a sentence the
 * operator reads before granting it. The video module is the first consumer:
 * it narrates a plan one scene at a time and stores each answer's file, length
 * and voice, and it needs the voice on the answer because a voice change under
 * a stored narration must invalidate it before a render.
 *
 * WHY THESE TWO METHODS AND NOT THE OTHERS.
 * `synthesize` and `status` are the whole of what a consumer needs: make this
 * sentence, and tell me the voice it would be made with. Everything else on
 * the rpc map is deliberately outside it:
 *
 *   - `importCache` writes rows from files the operator names. Filling the
 *     cache is the operator's act, through this extension's own page.
 *   - `health` carries the port file's path, the shim's path and the row
 *     counts. Those are this extension's own plumbing and diagnostics, not a
 *     fact about narration; a consumer that reads them is coupled to this
 *     extension's layout.
 *   - `kerelmek` lists every stored request with its text. The text was
 *     written by whoever asked for the narration, and it is not one consumer's
 *     to read another's through a data contract.
 *   - `mcpConfig` is the page's copy-paste block for Settings > MCP Servers.
 *
 * A method may be added here later, with a version bump, and that will be a
 * decision somebody makes. What must not happen is the contract growing
 * because the page or the shim grew, which is why this file names its methods
 * one by one over the shared synthesizer instead of handing over a slice of
 * the rpc map, and why each answer is cut to a list of fields written here.
 *
 * WHAT THIS SIDE OF THE BOUNDARY CANNOT DO, AND MUST NOT PRETEND TO.
 * The host decides who reaches these methods, and the handle it mints is a
 * bearer capability: it carries the identity of the extension it was minted
 * for wherever it is passed on, and the host never re-checks that against
 * whoever actually calls. So nothing arrives here that says who is asking,
 * and nothing below acts as though something did. That is why the request
 * row's `kerte` column says 'contract' and not 'contract:<consumer>': the
 * column records the route, which this side knows, not a name it cannot
 * verify. The way to narrow what a consumer can reach is the only way there
 * is: declare fewer methods and return fewer fields.
 *
 * WHAT CROSSES, AND WHAT DOES NOT.
 * The host does not clone, freeze or inspect a value crossing this boundary,
 * so which fields cross is decided here, by name, in `SYNTHESIS_FIELDS` and
 * `STATUS_FIELDS`. Today they happen to equal what the synthesizer returns;
 * the lists exist so that a field the synthesizer grows for the page or the
 * shim does not cross for free. The key's value never crosses: `status`
 * reports whether it is set, as a boolean, and nothing here reads it.
 *
 * The text a consumer sends is the consumer's: it is hashed for the cache
 * key, stored raw for this extension's own page, and sent to the provider. It
 * never becomes a file name, never enters an error message, and is never
 * logged; the caller names the file, and this side only checks the name.
 * Nothing in the answer repeats the text.
 *
 * The file the consumer names is checked, not trusted: it has to be an
 * absolute `.mp3` under the `hangGyoker` root, resolved through realpath so a
 * symlink cannot lead out of it, and a file already there that no request row
 * names is refused rather than replaced (`tts_celfajl_ervenytelen`,
 * `tts_celfajl_foglalt`). A consumer holding this handle can write inside
 * that root and nowhere else.
 *
 * Refusals are thrown as `TtsError` with a code from `TTS_KODOK`
 * (src/soniox.mjs), unchanged. The host wraps the throw as an
 * `ExtensionContractError` with code `provider_threw` and keeps the original
 * on `cause`, so a consumer reads `err.cause.code` to tell a refusal for lack
 * of balance (`tts_egyenleg_kimerult`) from this extension's own daily cap
 * (`tts_keret_kimerult`), from a call that could not be made (`tts_halozat`,
 * `tts_idotullepes`), and from an answer that carried no audio
 * (`tts_valasz_ertelmezhetetlen`). None of those is flattened here.
 */

/** The contract name, as a consumer spells it in `consumes` and in `ctx.contracts.get`. */
export const NARRATION_CONTRACT = 'narration'

/**
 * The contract version. A consumer pinning a different number gets
 * `version_mismatch` and no handle: bump this whenever a method is removed,
 * renamed, or changed in a way an existing consumer would read wrongly, and
 * whenever a field leaves one of the two lists below.
 */
export const NARRATION_CONTRACT_VERSION = 1

/**
 * The fields of a `synthesize` answer that cross. `kerelemId` is the row a
 * consumer may quote back to an operator; `fajl` is the caller's own path,
 * confirmed; `hosszMs` is the measured length; `cache` says whether the
 * provider was paid for this call; `hang`, `modell` and `nyelv` are the three
 * settings the cache key is made of, so a consumer can tell later whether the
 * stored narration still matches the current voice.
 */
export const SYNTHESIS_FIELDS = Object.freeze(['kerelemId', 'fajl', 'hosszMs', 'cache', 'hang', 'modell', 'nyelv'])

/**
 * The fields of a `status` answer that cross. The two booleans say whether a
 * call can be attempted at all, and they stay separate because an empty key
 * and an empty endpoint are refused under different codes. The counter and
 * the cap let a consumer see a refusal coming; the three settings are the
 * cache key, as above.
 *
 * `hangGyoker` is the directory a target path has to sit under, by value. It
 * crosses because a consumer that cannot see it can only guess a path and be
 * refused: `synthesize` accepts nothing outside that root, and nothing on the
 * consumer's side can derive it. It is a directory the operator configured,
 * not a secret.
 *
 * `maiMasodperc` counts what the day is committed to, which includes the
 * estimate of any call still waiting on the provider. A consumer reading it
 * twice may see it fall, because a call that failed gives its reservation
 * back; it is a budget position, not a monotonic total.
 */
export const STATUS_FIELDS = Object.freeze(['kulcsBeallitva', 'vegpontBeallitva', 'hangGyoker', 'maiMasodperc', 'napiKeret', 'hang', 'modell', 'nyelv'])

/** A fresh object with exactly `fields` copied out of `value`, absent ones included as undefined so the shape is fixed. */
function pick(fields, value) {
  const out = {}
  for (const field of fields) out[field] = value[field]
  return out
}

/**
 * Builds the `provides.narration` declaration index.mjs hands the host.
 *
 * Takes the synthesizer and nothing else: the contract has no reason to see
 * the repository, the settings or the seams, and giving it less is what makes
 * the list of what it can reach short enough to read.
 *
 * Both methods are `async` even though `status` is synchronous underneath.
 * Not decoration: the handle the host mints returns a promise whatever the
 * method does, and the rpc methods over the same synthesizer are async too, so
 * a refusal arrives as a rejection on every route rather than as a throw on
 * one and a rejection on another.
 */
export function createNarrationContract(synth) {
  return {
    version: NARRATION_CONTRACT_VERSION,
    summary: 'Szöveget mondat-hosszú mp3-má alakít a beállított hanggal, a hívó fájljába; cache-ből, ha már kész. A napi keret és a szolgáltató egyenlege gátolhatja. A szöveget nem olvassa, nem szűri.',
    methods: {
      /**
       * One sentence to one mp3 at `celFajl`: `{ kerelemId, fajl, hosszMs,
       * cache, hang, modell, nyelv }`, or a thrown `TtsError`. Arguments are
       * read by the rule in args.mjs: `szoveg` and `celFajl` are honoured,
       * anything else present is refused by name.
       */
      synthesize: async (args) => {
        const { szoveg, celFajl } = readSynthesisArgs(args)
        return pick(SYNTHESIS_FIELDS, await synth.synthesize({ szoveg, celFajl, kerte: 'contract' }))
      },
      /**
       * The settings a call would be made with and the day's counter, without
       * the key's value. Takes no arguments, and says so to a caller that
       * sends some rather than answering as if it had sent none.
       */
      status: async (args) => {
        readNoArgs(args)
        return pick(STATUS_FIELDS, synth.status())
      },
    },
  }
}

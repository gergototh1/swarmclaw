import { TtsError } from './soniox.mjs'

/**
 * The arguments of one synthesis request, read by the rule the whole
 * extension uses: absent means no opinion, present and not honourable is
 * refused by name.
 *
 * Exactly two keys are honoured, `szoveg` and `celFajl`. Both surfaces that
 * take a synthesis request -- the narration contract for other extensions'
 * code and the rpc behind the MCP shim -- read their arguments through this
 * one function, so a key one of them refuses the other refuses too.
 *
 * Any other key that is present is refused rather than ignored. The one a
 * consumer is likeliest to send is `hang`: the design spec once listed
 * `hang?` and `nyelv?` on the contract, and the synthesizer honours neither,
 * it speaks with the configured voice only. Answering such a call with the
 * configured voice would be a quiet coercion, and the answer's `hang` would
 * then disagree with what was asked. The refusal names the key and never its
 * value; a key that is not a plain identifier is not repeated either, since a
 * consumer may build its argument object out of text it did not write.
 *
 * Only presence is decided here. Whether `szoveg` and `celFajl` themselves
 * can be honoured is the synthesizer's own check, under its own codes.
 */
const HONOURED = Object.freeze(['szoveg', 'celFajl'])
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export function readSynthesisArgs(args) {
  if (args === undefined || args === null) return { szoveg: undefined, celFajl: undefined }
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new TtsError('tts_beallitas_hibas', 'az argumentum objektum kell legyen')
  }
  const extra = Object.keys(args).filter((key) => !HONOURED.includes(key) && args[key] !== undefined)
  if (extra.length > 0) {
    const named = extra.map((key) => (IDENTIFIER.test(key) ? key : '(nem azonosító nevű kulcs)'))
    throw new TtsError('tts_beallitas_hibas', `nem támogatott argumentum: ${named.join(', ')}; csak szoveg és celFajl adható meg`)
  }
  return { szoveg: args.szoveg, celFajl: args.celFajl }
}

/**
 * For a method that takes nothing: refuses, by the same rule, any key that
 * arrives with a value. A method with no arguments has nothing it could
 * honour, so a present one is a caller asking for something this side does
 * not offer, and it is told so rather than answered as if it had asked
 * nothing.
 */
export function readNoArgs(args) {
  if (args === undefined || args === null) return
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new TtsError('tts_beallitas_hibas', 'az argumentum objektum kell legyen')
  }
  const extra = Object.keys(args).filter((key) => args[key] !== undefined)
  if (extra.length > 0) {
    const named = extra.map((key) => (IDENTIFIER.test(key) ? key : '(nem azonosító nevű kulcs)'))
    throw new TtsError('tts_beallitas_hibas', `nem támogatott argumentum: ${named.join(', ')}; ez a metódus nem vesz át argumentumot`)
  }
}

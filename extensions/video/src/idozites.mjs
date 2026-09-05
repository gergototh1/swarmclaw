/**
 * The frame arithmetic the narration and the render share (spec 4.4, 5.2).
 *
 * FPS, HANG_ELORETART and OVERLAP are the kit's own: Root.tsx passes
 * `fps={30}` to every composition, Film.tsx exports `HANG_ELORETART = 10`,
 * Scene.tsx has `OVERLAP = 14`. ZARO_TARTAS and UTOLSO_ZARO_TARTAS are this
 * module's decision, an estimate the first live renders may move. A change
 * here changes the props file and so the rendered file's sha, and voids no
 * old QA row: the QA key is the file's fingerprint, not these numbers.
 *
 * The spec places these beside the render; they live in their own file
 * because narracio.mjs (N2, N3) and render.mjs both compute from them, and
 * the two importing each other would be a cycle.
 */
export const FPS = 30
export const HANG_ELORETART = 10
export const OVERLAP = 14
export const ZARO_TARTAS = 8
export const UTOLSO_ZARO_TARTAS = 45
/**
 * The spec's estimate for Hungarian speech (5.1 L7), not a measurement.
 * sablon.mjs replaces it with the measured ratio once ten narrated scenes
 * exist. It lives here so katalogus.mjs and sablon.mjs can both read it
 * without importing each other.
 */
export const ALAP_KARAKTER_PER_MP = 14

/** The scene's visible length in frames, from its narration's length in ms. */
export function lathatoHossz(hosszMs, utolso) {
  return HANG_ELORETART + Math.ceil((hosszMs / 1000) * FPS) + (utolso ? UTOLSO_ZARO_TARTAS : ZARO_TARTAS)
}

const msOfFrames = (frames) => Math.round((frames / FPS) * 1000)

/**
 * Scene bounds for a list of narration lengths, in the order of the list.
 * `teljesKocka` is the composition's length: the scenes' visible frames plus
 * the one OVERLAP the kit adds after the last scene.
 */
export function idovonal(hosszMsLista) {
  let kurzor = 0
  const elemek = hosszMsLista.map((hosszMs, i) => {
    const lathato = lathatoHossz(hosszMs, i === hosszMsLista.length - 1)
    const elem = { jelenet: i, kezdetKocka: kurzor, lathato, kezdetMs: msOfFrames(kurzor), vegMs: msOfFrames(kurzor + lathato) }
    kurzor += lathato
    return elem
  })
  const teljesKocka = kurzor + OVERLAP
  return { elemek, teljesKocka, teljesMs: msOfFrames(teljesKocka) }
}

/** Narrated ms over total visible ms; 0 for an empty list. */
export function fedettseg(hosszMsLista) {
  if (hosszMsLista.length === 0) return 0
  const narralt = hosszMsLista.reduce((s, ms) => s + ms, 0)
  return narralt / idovonal(hosszMsLista).teljesMs
}

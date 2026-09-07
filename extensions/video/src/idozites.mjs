/**
 * The frame arithmetic the narration and the render share (spec 4.4, 5.2).
 *
 * FPS, HANG_ELORETART and OVERLAP are the kit's own: Root.tsx passes
 * `fps={30}` to every composition, Film.tsx exports `HANG_ELORETART = 10`,
 * Scene.tsx has `OVERLAP = 14`. ZARO_TARTAS and UTOLSO_ZARO_TARTAS are this
 * module's decision, an estimate the first live renders may move. A change
 * here changes the props file and so the rendered file's sha, and voids no
 * old QA row: the QA key is the file's fingerprint, not these numbers. That
 * promise now covers one more prop: `lepesKocka` below puts a per-scene
 * `lepes` into the same props file, so every plan re-rendered after this
 * change gets a new sha, and no stored QA verdict is invalidated by it.
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

/** The floor a fitted beat is clamped to; the kit's own `illesztettLepes` clamps to the same 1. */
export const MIN_LEPES = 1

/**
 * THE BEAT BETWEEN TWO REVEALED ELEMENTS, IN FRAMES (the owner's finding on
 * the first rendered video, 2026-09-06: "amikor kimondja, hogy slack, akkor
 * a szövegnek is akkor kéne megjelennie").
 *
 * WHAT WAS WRONG. The scene bounds above are exact -- a scene is as long as
 * its MEASURED narration -- but nothing inside a scene was tied to the
 * narration. The kit reveals element `i` of a gathering list at
 * `elsoKocka + i * lepes`, and `lepes` had no sender: the module never wrote
 * it and the agent may not, so every scene ran on the kit's own constant
 * (`lista` 40, `cimlap` 8). Those are the numbers the HAND-WRITTEN videos
 * were cut to, where the narration was recorded against the picture. Here
 * the picture is cut to the narration, and a constant beat cannot follow a
 * sentence whose length the module measures afterwards.
 *
 * WHAT THE KIT ALREADY DOES, AND WHY IT IS NOT ENOUGH. The kit is not naive:
 * `illesztettLepes(n, lathatoHossz, start, fade, fixLepes)` already shrinks
 * the constant to `floor((lathatoHossz - start - fade) / (n - 1))`, so the
 * last element cannot fall off the end of the SCENE. But the scene is not
 * the sentence. `lathatoHossz` carries HANG_ELORETART in front of the audio
 * and ZARO_TARTAS -- UTOLSO_ZARO_TARTAS, 45 frames, on the closing scene --
 * behind it, and the kit spreads the reveals across all of it, silence
 * included. On a last scene with a 2.4 s sentence and three items the kit's
 * clamp does not bind at all (40 <= floor((10+72+45-45)/2) = 41), the third
 * item lands at frame 114 and the narration stopped at frame 82: the picture
 * says the word a second after the voice did. That is the drift, and it is
 * the kit fitting to the only length it is given, not a kit bug.
 *
 * THE ARITHMETIC. The audio starts at HANG_ELORETART and runs
 * `ceil(ms/1000*FPS)` frames, so it ends at `hangVeg`. The kit reveals from
 * `elsoKocka` (the type's own lead-in: the title first on a `lista`, almost
 * nothing on a `cimlap`), which this module cannot move -- only the beat
 * between reveals is a prop. So the last element's reveal is placed at
 * `hangVeg - erkezes` and the beat is what divides the span evenly:
 *
 *     lepes = floor((HANG_ELORETART + ceil(ms/1000*FPS) - erkezes - elsoKocka) / (n - 1))
 *
 * THE MARGIN IS `erkezes`, AND IT IS A MEASURED KIT NUMBER, NOT A TASTE.
 * A reveal is not instant: the kit fades the element in and settles its
 * colour over a fixed number of frames (GatheringList 11, WordFlow 9 -- the
 * kit's motion.ts states both and refuses a default for either, because an
 * earlier flat 20 was wrong in both directions). An element whose reveal
 * merely STARTS on the word is still a ghost while the word is said. So the
 * margin is the arrival itself: the last element is fully on screen by the
 * time the sentence ends. A beat that lands a little early reads as
 * anticipation; one that lands late reads as a mistake, and the asymmetry is
 * why the margin is subtracted rather than split around the end.
 *
 * WHAT SPREADS AND WHAT DOES NOT. The beat fills the whole sentence rather
 * than keeping the kit's constant as a ceiling: the producer's rule is that
 * the sentence names the revealed elements IN ORDER, so evenly dividing the
 * sentence is the closest placement anything without a word-level
 * transcript can make. A ceiling would instead crowd every element into the
 * front of a long sentence and leave the rest of it staring at a finished
 * picture. Where the sentence is too short for the elements the value is
 * clamped to MIN_LEPES, exactly as the kit clamps, and `lepesZsufolt` below
 * is what says so at draft time instead of letting it show up in a render.
 *
 * THE VALUE ALWAYS SURVIVES THE KIT'S OWN CLAMP. `illesztettLepes` takes the
 * MINIMUM of what it is sent and what fits the scene, and both spans start
 * at the same `elsoKocka` and end one `erkezes` early -- ours at the end of
 * the AUDIO, the kit's at the end of the SCENE. The scene outlasts the audio
 * by exactly the closing hold (ZARO_TARTAS or UTOLSO_ZARO_TARTAS, both
 * positive), so this number is always the smaller one and the kit takes it
 * verbatim. The tests check that rather than this comment asserting it.
 */
export function lepesKocka({ elemSzam, hosszMs, elsoKocka, erkezes }) {
  if (!Number.isInteger(elemSzam) || elemSzam < 2) return null
  const utolsoKocka = HANG_ELORETART + Math.ceil((hosszMs / 1000) * FPS) - erkezes
  return Math.max(MIN_LEPES, Math.floor((utolsoKocka - elsoKocka) / (elemSzam - 1)))
}

/**
 * True when the sentence is too short to carry the elements: the fitted beat
 * came out shorter than one arrival, so the elements pile onto each other
 * instead of landing one by one. The threshold is `erkezes` for the same
 * reason the margin is: below it the next element starts arriving before the
 * previous one has finished, and what the viewer sees is a burst, not beats.
 *
 * This is the one part of the timing that IS knowable before the narration
 * is synthesised -- from the character-count estimate -- so validateDraft
 * warns on it (L10). A warning and not a refusal: the estimate is an
 * estimate, and refusing a plan on one would be the false result section 4
 * of the spec forbids.
 */
export function lepesZsufolt({ elemSzam, hosszMs, elsoKocka, erkezes }) {
  const lepes = lepesKocka({ elemSzam, hosszMs, elsoKocka, erkezes })
  return lepes !== null && lepes < erkezes
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

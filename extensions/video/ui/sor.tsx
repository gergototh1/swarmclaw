import { useCallback, useState } from 'react'

import type { Board, BoardCard, Rpc, YoutubeOtletek as YoutubeOtletekValasz } from './api'
import { errorText, isRecord, readYoutubeOtletek, refusalText } from './api'
import { formatDate, renderStatusLabel, sapkaSzoveg, statusLabel } from './format'

/**
 * The queue: one column per status in the module's own vocabulary, in the
 * order `board.statusok` gives them.
 *
 * The server sends a total map -- every status is a key, empty columns
 * included -- and this view does not silently drop the empty ones, because
 * "no video is waiting for review" is a fact the operator reads off the
 * board. It does collapse them into one line, so eleven empty columns do not
 * push the one with rows off the screen; the line names each empty status, so
 * nothing disappears.
 *
 * Every string on a card is a stranger's text or an agent's summary of one,
 * and every one of them is a React text child. A card carries no url and no
 * link: the source url lives in the source text, and the Video view is where
 * it is shown, behind `safeHref`.
 *
 * Above the columns are the two things this view can DO rather than show,
 * and they are the two the chain cannot start without: opening a video from
 * text the operator pastes, and asking the configured YouTube channels for
 * their recent uploads. Both are the first link of the chain and neither is
 * one an agent may start on the operator's behalf -- the first because
 * nobody else has the text, the second because it spawns a process that
 * talks to a third party -- which is why the queue, and not some settings
 * screen, is where they stand.
 */

function Kartya({ card, onOpen }: { card: BoardCard; onOpen: (id: string) => void }) {
  const status = statusLabel(card.status)
  const verdikt = card.utolsoVerdikt
  const render = card.render
  return (
    <button type="button" className="vid-card" data-video-id={card.id} onClick={() => onOpen(card.id)}>
      <span className="vid-card-title">{card.cim}</span>
      <span className="vid-card-meta">
        <span className={status.known ? 'vid-badge' : 'vid-badge vid-badge-bad'}>{status.label}</span>
        <span>forrás: {card.forrasTipus}</span>
        <span>{card.tervVerzio === null ? 'még nincs terv' : `v${card.tervVerzio}`}</span>
        <span>{formatDate(card.createdAt)}</span>
      </span>
      <span className="vid-card-meta">
        {/*
          Four different facts, four different sentences. A video with no
          verdict is not a video that passed, and a video with no render is
          not a render that failed; each says which it is.
        */}
        <span>
          {verdikt === null
            ? 'lektorálva: még nem'
            : `lektor: ${verdikt.verdikt}${verdikt.talalatok > 0 ? ` (${verdikt.talalatok} találat)` : ''}`}
        </span>
        <span>
          {render === null
            ? 'render: még nem indult'
            : `render: ${renderStatusLabel(render.status)}${render.hiba ? ` (${render.hiba.kod})` : ''}`}
        </span>
        <span>
          {card.qa === null
            ? 'QA: nincs érvényes sor'
            : card.qa.ok
              ? 'QA: ok'
              : `QA: bukott (${card.qa.bukasok.join(', ')})`}
        </span>
      </span>
    </button>
  )
}

/**
 * The manual-source open box, drawn from what the shell holds.
 *
 * Split out for the reason `VideoBody` and `SablonokBody` are: what a state
 * LOOKS like is pinned by rendering this with that state in the props, and a
 * server render runs no effect and no click.
 *
 * ONE SOURCE KIND ON PURPOSE. `nyit` also opens a video from a saved signal
 * card, and this box does not offer that: picking a card is a choice the
 * module already makes on its own (`pickSignal`), and a second, hand-driven
 * way to make it would be a second answer to the same question. What was
 * missing was the source the module cannot reach by itself -- text the
 * operator has in front of them -- so that is what the box takes.
 *
 * The title is optional because the service already has a rule for an absent
 * one: `cimOf` falls back to a title derived from the source text. A blank
 * field here is that fallback being chosen, not a field left unfilled, and
 * the placeholder says so.
 */
export function UjVideoBody({ forrasSzoveg, cim, kuldes, uzenet, onForras, onCim, onKuld }: {
  forrasSzoveg: string
  cim: string
  kuldes: boolean
  uzenet: string | null
  onForras: (value: string) => void
  onCim: (value: string) => void
  onKuld: () => void
}) {
  // Disabled exactly when there is a sentence saying why, and never
  // otherwise: the rule the preview button on the Sablonok view is built on.
  const ok = forrasSzoveg.trim() === ''
    ? 'Forrás szöveg nélkül nem nyílik videó.'
    : kuldes ? 'A nyitás elment, a válaszra várok.' : null
  return (
    <section className="vid-uj-video">
      <h3>Új videó kézi forrásból</h3>
      <form onSubmit={(e) => { e.preventDefault(); onKuld() }}>
        <label>
          Forrás szövege
          <textarea className="vid-input" rows={4} value={forrasSzoveg} onChange={(e) => onForras(e.target.value)} />
        </label>
        <label>
          Cím
          <input className="vid-input" type="text" value={cim} onChange={(e) => onCim(e.target.value)} placeholder="üresen hagyva a modul a forrás szövegéből ad címet" />
        </label>
        <div className="vid-lepes">
          <button type="submit" className="vid-btn" disabled={ok !== null}>Új videó</button>
          {ok !== null && <span className="vid-muted vid-lepes-ok">{ok}</span>}
        </div>
      </form>
      {uzenet !== null && <p className="vid-notice" role="status">{uzenet}</p>}
    </section>
  )
}

/**
 * The box's state and its one request.
 *
 * `nyit` RESOLVES with its refusals (the daily cap, a source text longer than
 * the column takes), so the answer is read with `refusalText` before anything
 * says a video opened; a rejected promise is the other fact -- the request
 * never reached the module -- and gets its own sentence. Neither is folded
 * into "sikertelen".
 *
 * On a real open the board is reloaded through `onNyitva`, because the new
 * video belongs in the queue behind this box and nothing else would put it
 * there.
 */
function UjVideo({ rpc, onNyitva }: { rpc: Rpc; onNyitva: () => void }) {
  const [forrasSzoveg, setForrasSzoveg] = useState('')
  const [cim, setCim] = useState('')
  const [kuldes, setKuldes] = useState(false)
  const [uzenet, setUzenet] = useState<string | null>(null)

  const onKuld = useCallback(() => {
    setKuldes(true)
    // The text goes as it was pasted. `nyissVideot` stores a source byte for
    // byte and the Video view is where it is labelled as a stranger's text;
    // trimming it here would be this page editing a source nobody asked it to
    // edit.
    rpc('nyit', { forras: 'kezi', forrasSzoveg, cim })
      .then((raw) => {
        const hiba = refusalText(raw)
        if (hiba !== null) { setUzenet(`A videó nem nyílt meg — ${hiba}`); return }
        setUzenet('A videó megnyílt, és a sor frissült.')
        setForrasSzoveg('')
        setCim('')
        onNyitva()
      })
      .catch((err: unknown) => setUzenet(`A nyitás kérése el sem jutott a modulhoz: ${errorText(err)}`))
      .finally(() => setKuldes(false))
  }, [rpc, forrasSzoveg, cim, onNyitva])

  return (
    <UjVideoBody
      forrasSzoveg={forrasSzoveg}
      cim={cim}
      kuldes={kuldes}
      uzenet={uzenet}
      onForras={setForrasSzoveg}
      onCim={setCim}
      onKuld={onKuld}
    />
  )
}

/**
 * The sentences one press of the YouTube button produced, in the order the
 * operator should read them.
 *
 * A LIST RATHER THAN A STRING, and every branch its own sentence: this is the
 * one control on the page whose answer has five independent parts -- what
 * opened, what was already here, what was left over, which channels went
 * quiet, and what the module refused to take off the listing -- and folding
 * them into one line would make the interesting one the hardest to find.
 *
 * THE THREE ZEROS ARE THREE SENTENCES. "Nothing opened because every upload
 * is already a video on this board", "nothing came back at all and a channel
 * went quiet while it did not" and "the channels answered and had nothing
 * new" are different facts with different fixes -- wait for the next upload,
 * fix a channel url, widen the window -- and a single "0 új ötlet" would send
 * the operator looking in the wrong place for all three.
 *
 * AND THE PER-CHANNEL REPORT IS TWO LISTS. `csatornaHibak` carries both the
 * channels that could not be read and the ones that were read and had nothing
 * (`csatorna_nincs_friss`); only the first kind is something to fix, so only
 * the first kind is printed as a failure.
 *
 * THE CHANNELS ARE NAMED. "3 csatornából 1 nem válaszolt" is a count of a
 * fact the page already has in full; the operator cannot act on it without
 * going to look up which one, and the answer carries the name.
 */
/**
 * The one per-channel code that is not a failure: everything worked and the
 * channel simply had nothing inside the window. It travels in `csatornaHibak`
 * because that is the module's per-channel report, and it is pulled out here
 * because printing it under "nem válaszolt" would be a false statement about
 * a channel that answered perfectly well.
 */
const NINCS_FRISS = 'csatorna_nincs_friss'

/**
 * What the operator DOES about each per-channel code.
 *
 * The code alone satisfies "say which channel and why" and stops one step
 * short of useful: `csatorna_azonosito_ismeretlen` is precise, quotable, and
 * tells somebody who has not read src/youtube.mjs nothing about whether to
 * fix a url, wait, or go and look at the channel. The two whole-source
 * refusals each carry a sentence saying where to go, and these are the same
 * kind of thing at a smaller scale.
 *
 * The code is still printed beside the sentence, because it is what the
 * operator can search for and hand to an agent -- the sentence is the
 * addition, not the replacement.
 *
 * A code this map does not know still prints, with its own line saying so:
 * the module's vocabulary may grow ahead of this page, and a channel silently
 * missing from the report would be worse than one named without advice.
 */
const CSATORNA_TEENDO: Record<string, string> = {
  csatorna_nem_valaszolt: 'a csatorna oldalát nem sikerült beolvasni; ellenőrizd az URL-t a beállításokban',
  csatorna_idotullepes: 'a csatorna oldala nem válaszolt időben; próbáld meg újra',
  csatorna_azonosito_ismeretlen: 'a válaszban nem volt csatorna-azonosító: átnevezhették a handle-t, vagy megszűnt a csatorna',
  csatorna_feed_nem_valaszolt: 'a csatornát megtaláltuk, de a feedje nem válaszolt; próbáld meg újra',
  csatorna_feed_idotullepes: 'a csatorna feedje nem válaszolt időben; próbáld meg újra',
  csatorna_feed_tul_nagy: 'a csatorna feedje nagyobb, mint amit a modul beolvas; a modul inkább nem vett át belőle semmit, mint hogy csonkán olvassa',
  csatorna_feed_ertelmezhetetlen: 'a csatorna 200-zal válaszolt, de nem feeddel — ez lehet beleegyezés-kérő vagy hibaoldal; nyisd meg a csatornát böngészőben',
}

const csatornaMondat = (h: { csatorna: string; ok: string }) => {
  const teendo = CSATORNA_TEENDO[h.ok] ?? 'a modul ezt a kódot adta rá, de ez a lap még nem tud hozzá mondatot'
  return `${h.csatorna} — ${teendo} (${h.ok})`
}

export function otletMondatok(eredmeny: YoutubeOtletekValasz): string[] {
  const { nyitott, marVolt, jelolt, maradek, csatornaHibak, eldobott } = eredmeny
  const nema = csatornaHibak.filter((h) => h.ok !== NINCS_FRISS)
  const csendes = csatornaHibak.filter((h) => h.ok === NINCS_FRISS)
  const mondatok: string[] = []
  if (nyitott.length > 0) mondatok.push(`${nyitott.length} új ötlet nyílt kártyaként a táblára.`)
  // Not "no channel answered": the answer carries the failures but not how
  // many channels were asked, so one quiet channel beside two that answered
  // with nothing would make that sentence false. What is true, and is the
  // fact the operator needs, is that the empty result is not necessarily the
  // channels' own answer.
  else if (nema.length > 0 && jelolt === 0) mondatok.push('Nem jött egyetlen jelölt sem, és közben volt csatorna, ami nem válaszolt.')
  else if (marVolt > 0 && jelolt === marVolt) mondatok.push('Nem nyílt új kártya: mindegyikből van már videó a táblán.')
  else mondatok.push('A csatornák válaszoltak, de nem volt köztük új feltöltés ebben az ablakban.')
  if (marVolt > 0 && nyitott.length > 0) mondatok.push(`${marVolt} feltöltésből már volt videó, azokat a modul kihagyta.`)
  if (maradek > 0) mondatok.push(`${maradek} ötlet maradt a gomb egy-nyomásos korlátján kívül; nyomd meg még egyszer, ha kell.`)
  // Two lists, never one. A channel that could not be read needs fixing; a
  // channel that has not uploaded lately needs nothing at all, and folding
  // them together would send the operator checking a url that is fine.
  for (const h of nema) mondatok.push(`Nem sikerült beolvasni: ${csatornaMondat(h)}.`)
  if (csendes.length > 0) mondatok.push(`Nem volt friss feltöltése: ${csendes.map((h) => h.csatorna).join(', ')}.`)
  if (eldobott > 0) mondatok.push(`${eldobott} bejegyzést a modul nem vett át: az ablakon kívülre eső feltöltés, vagy olyan bejegyzés, amiből nem épít videó-hivatkozást.`)
  return mondatok
}

/**
 * The button and the lines under it.
 *
 * Split out for the reason `UjVideoBody` is: what a state LOOKS like is
 * pinned by rendering this with that state in the props, and a server render
 * runs no effect and no click. The reason a dark button is dark stands BESIDE
 * it, never in a `title=` nobody hovers -- the rule the ordering levers on the
 * Video view are built on.
 *
 * Every sentence is a React text child. One of them names channels the
 * operator typed into a settings field, and another carries the module's own
 * refusal message; neither is markup here.
 */
export function YoutubeOtletekBody({ dolgozik, mondatok, onKattint }: {
  dolgozik: boolean
  mondatok: string[]
  onKattint: () => void
}) {
  const ok = dolgozik ? 'A lekérés fut; a yt-dlp csatornánként másodpercekig tart.' : null
  return (
    <section className="vid-youtube">
      <h3>Ötletek a YouTube-ról</h3>
      <p className="vid-muted vid-youtube-mit">
        A beállított csatornák friss feltöltéseiből nyit kártyát a táblára. Amiből már van videó, azt kihagyja.
      </p>
      <div className="vid-lepes">
        <button type="button" className="vid-btn" disabled={dolgozik} onClick={onKattint}>Ötletek a YouTube-ról</button>
        {ok !== null && <span className="vid-muted vid-lepes-ok">{ok}</span>}
      </div>
      {mondatok.length > 0 && (
        <ul className="vid-youtube-valasz" role="status">
          {mondatok.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}
    </section>
  )
}

/**
 * The button's state and its one request.
 *
 * THREE OUTCOMES, NEVER FOLDED, the same three `UjVideo` above keeps apart.
 * `youtubeOtletek` RESOLVES with its refusals (no channel configured, no
 * binary at the configured path), so a resolved promise is not proof that
 * anything happened and `refusalText` is asked first. A REJECTED promise is
 * the third fact -- the request never reached the module -- and gets its own
 * sentence. None of them is "sikertelen".
 *
 * The two refusals the operator can actually fix get a second sentence saying
 * WHERE, because the module's own message names a settings field and the
 * operator should not have to work out that a settings field is a place.
 *
 * On a real press the board is reloaded through `onNyitva`: the new cards
 * belong in the queue below this box and nothing else would put them there.
 */
function YoutubeOtletek({ rpc, onNyitva }: { rpc: Rpc; onNyitva: () => void }) {
  const [dolgozik, setDolgozik] = useState(false)
  const [mondatok, setMondatok] = useState<string[]>([])

  const onKattint = useCallback(() => {
    setDolgozik(true)
    rpc('youtubeOtletek', {})
      .then((raw) => {
        const hiba = refusalText(raw)
        if (hiba !== null) {
          const kod = isRecord(raw) && typeof raw.hiba === 'string' ? raw.hiba : ''
          const hol = kod === 'youtube_nincs_csatorna'
            ? 'Előbb írj csatornákat a modul beállításai közé, a YouTube-csatornák mezőbe.'
            : kod === 'ytdlp_hianyzik'
              ? 'A beállított útvonalon nincs futtatható bináris; a modul beállításai közt az yt-dlp útvonala mezőt javítsd.'
              : null
          setMondatok(hol === null ? [hiba] : [hiba, hol])
          return
        }
        // The reader's own refusal is a FOURTH fact and may not fall into
        // the catch below: "el sem jutott a modulhoz" would be a false
        // statement about a request that arrived and was answered, just in a
        // shape this page cannot read. And nothing is reloaded over it,
        // because nobody here knows whether anything opened.
        let eredmeny: YoutubeOtletekValasz
        try {
          eredmeny = readYoutubeOtletek(raw)
        } catch (err: unknown) {
          setMondatok([`A modul válaszát ez a lap nem tudta elolvasni: ${errorText(err)}`])
          return
        }
        setMondatok(otletMondatok(eredmeny))
        onNyitva()
      })
      .catch((err: unknown) => setMondatok([`Az ötletek kérése el sem jutott a modulhoz: ${errorText(err)}`]))
      .finally(() => setDolgozik(false))
  }, [rpc, onNyitva])

  return <YoutubeOtletekBody dolgozik={dolgozik} mondatok={mondatok} onKattint={onKattint} />
}

export function Sor({ board, onOpen, rpc, onNyitva }: { board: Board; onOpen: (id: string) => void; rpc: Rpc; onNyitva: () => void }) {
  const teli = board.statusok.filter((s) => (board.oszlopok[s] ?? []).length > 0)
  const ures = board.statusok.filter((s) => (board.oszlopok[s] ?? []).length === 0)
  const sapkak = board.sapkak
  return (
    <div className="vid-sor">
      <UjVideo rpc={rpc} onNyitva={onNyitva} />
      <YoutubeOtletek rpc={rpc} onNyitva={onNyitva} />
      {teli.length === 0 && (
        <p className="vid-muted">
          {/*
            The sentence used to name the producing agent as the only way a
            video is opened, which stopped being true the moment the box above
            appeared. An empty queue with a live control on the same screen
            has to say that the control is the other way.
          */}
          Egyetlen videó sincs a sorban. A modul akkor nyit videót, amikor a gyártó ügynök lefut — vagy amikor te nyitsz egyet a fenti dobozban, illetve ötleteket kérsz a YouTube-ról.
        </p>
      )}
      <div className="vid-columns">
        {teli.map((status) => {
          const label = statusLabel(status)
          const cards = board.oszlopok[status] ?? []
          return (
            <section key={status} className="vid-column" data-status={status}>
              <h3 className={label.known ? '' : 'vid-badge-bad'}>{label.label} ({cards.length})</h3>
              {cards.map((card) => <Kartya key={card.id} card={card} onOpen={onOpen} />)}
            </section>
          )
        })}
      </div>
      {ures.length > 0 && (
        <p className="vid-muted vid-ures">Üres: {ures.map((s) => statusLabel(s).label).join(', ')}</p>
      )}
      <p className="vid-sapkak">
        <span>Nyitott javaslatok: {sapkaSzoveg(sapkak.nyitottJavaslat.db, sapkak.nyitottJavaslat.sapka)}</span>
        <span>Backlog szabály: {sapkaSzoveg(sapkak.backlog.szabaly.db, sapkak.backlog.szabaly.sapka)}</span>
        <span>Backlog sablon: {sapkaSzoveg(sapkak.backlog.sablon.db, sapkak.backlog.sablon.sapka)}</span>
        <span>Videó: {board.counts.videos} · terv: {board.counts.tervek} · render: {board.counts.renderek} · QA ok: {board.counts.qaOk}</span>
      </p>
    </div>
  )
}

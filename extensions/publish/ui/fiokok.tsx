import { useCallback, useEffect, useState } from 'react'

import type { FiokokAdat, Rpc } from './api'
import { errText, readFiokok, refusalText } from './api'
import { PLATFORM_CIMKE } from './naptar'

/**
 * The accounts page: design spec 8's third view, "fiókok (összekötés, és
 * megnevezve az, ami hiányzik)".
 *
 * A CONNECTION IS TWO SEPARATE FACTS, NOT ONE (task-6-brief.md's own closing
 * section, "A FIÓK-ÖSSZEKÖTÉS: KÉT DOLOG KELL, NEM EGY"). `repo.fiokotIr`
 * (src/db.mjs) has had no caller in production code since Task 1, so
 * `publishDue`'s account gate resolves every branch to `nincs_fiok` on a real
 * install regardless of what credential the host holds. This page therefore
 * offers BOTH:
 *
 *   1. `Osszekot` below: the generic account-connect form, for all four
 *      platforms alike -- a platform, the outlet's own external id, and a
 *      display name, written straight through `src/rpc.mjs`'s
 *      `fiokotOsszekot` to `ext_publish_fiokok`. This is the row `publishDue`
 *      actually gates on, and it is the only step Facebook, Instagram and
 *      TikTok need until their own OAuth exists -- design spec 9 rules out a
 *      second account store, so a manually entered page/channel id IS the
 *      account, the same way it would be after a future OAuth callback wrote
 *      the identical row.
 *   2. The Google connect button, `CONNECT_URL` below: `/api/oauth/google/
 *      start?purpose=publish`. Nothing else in this tree names that route --
 *      the brief says so directly -- and it grants the TOKEN a YouTube upload
 *      needs (`state.oauth.getGoogleAccessToken('publish')`,
 *      `src/platform/youtube.mjs`), which the database row above does not
 *      carry at all. A real YouTube upload needs both: the row so
 *      `publishDue` does not skip the branch as `nincs_fiok`, and the token
 *      so `feltolt` does not fail its own credential check.
 *
 * THE BUTTON, NOT A PLAIN LINK, modelled directly on
 * `extensions/gmail/ui/status-bar.tsx`'s own `CONNECT_URL` control and its
 * docblock's reasoning: a plain `<a href>` on a host with no Google OAuth
 * client configured lands on a JSON error body in a blank tab, which is a
 * dead end with no sentence in it. This page already knows whether a client
 * exists (`fiokok`'s `googleKliensVan`, read the same way the gmail page
 * reads its own `health.hibak`), so the button is disabled with a sentence
 * beside it instead.
 */

const PLATFORMOK_SORREND = ['youtube', 'facebook', 'instagram', 'tiktok']

/** `/api/oauth/google/start` is the host's consent route (design spec 6); `purpose=publish` is the scope Task 5's YouTube adapter reads (`state.oauth.getGoogleAccessToken('publish')`, `src/platform/youtube.mjs`) -- root-relative, so this bundle never has to know its own origin. */
const CONNECT_URL = '/api/oauth/google/start?purpose=publish'

function FiokSor({ platform, fiok }: { platform: string; fiok: FiokokAdat['fiokok'][number] | null }) {
  return (
    <li className="pub-fiok-sor" data-platform={platform}>
      <strong>{PLATFORM_CIMKE[platform] ?? platform}</strong>
      {fiok !== null
        ? <span className="pub-fiok-kesz">Összekötve: {fiok.nev} ({fiok.kulsoId})</span>
        : <span className="pub-fiok-hianyzik">Nincs összekötve fiók ehhez a platformhoz.</span>}
    </li>
  )
}

export function FiokokBody({ adat, hiba, uzenet, kuldes, platform, kulsoId, nev, onPlatform, onKulsoId, onNev, onOsszekot, onFrissit }: {
  adat: FiokokAdat | null
  hiba: string | null
  uzenet: string | null
  kuldes: boolean
  platform: string
  kulsoId: string
  nev: string
  onPlatform: (platform: string) => void
  onKulsoId: (kulsoId: string) => void
  onNev: (nev: string) => void
  onOsszekot: () => void
  onFrissit: () => void
}) {
  const platformok = adat?.platformok ?? PLATFORMOK_SORREND
  return (
    <section className="pub-fiokok">
      <div className="pub-fiokok-fejlec">
        <h2>Fiókok</h2>
        <button type="button" className="pub-btn pub-btn-small" onClick={onFrissit}>Frissítés</button>
      </div>
      {hiba !== null && <p className="pub-hiba" role="alert">{hiba}</p>}
      {adat === null && hiba === null && <p className="pub-halvany">Betöltés folyamatban.</p>}

      {adat !== null && (
        <ul className="pub-fiok-lista">
          {platformok.map((p) => (
            <FiokSor key={p} platform={p} fiok={adat.fiokok.find((f) => f.platform === p) ?? null} />
          ))}
        </ul>
      )}

      {adat !== null && (
        <div className="pub-google-connect">
          <p className="pub-halvany">
            A YouTube-hoz a Google-fiók hozzáférését IS be kell kötni, a lenti mezőktől külön: az egyik a
            jogosultságot adja, a másik a kapcsolt csatorna azonosítóját írja be.
          </p>
          <button
            type="button"
            disabled={!adat.googleKliensVan}
            onClick={() => { window.location.assign(CONNECT_URL) }}
          >
            Google-fiók bekötése (YouTube)
          </button>
          {!adat.googleKliensVan && (
            <span className="pub-halvany">
              A gomb ki van kapcsolva, mert ezen a hoston nincs OAuth-kliens: a bekötés nem tudna elindulni.
            </span>
          )}
        </div>
      )}

      <form
        className="pub-fiok-form"
        onSubmit={(e) => { e.preventDefault(); onOsszekot() }}
      >
        <h3>Fiók összekötése (csatorna/oldal azonosító)</h3>
        <select value={platform} onChange={(e) => onPlatform(e.target.value)} aria-label="Platform">
          {platformok.map((p) => <option key={p} value={p}>{PLATFORM_CIMKE[p] ?? p}</option>)}
        </select>
        <input
          value={kulsoId}
          onChange={(e) => onKulsoId(e.target.value)}
          placeholder="Külső azonosító (csatorna/oldal id)"
          aria-label="Külső azonosító"
        />
        <input
          value={nev}
          onChange={(e) => onNev(e.target.value)}
          placeholder="Megjelenítendő név"
          aria-label="Megjelenítendő név"
        />
        <button type="submit" disabled={kuldes || kulsoId.trim() === '' || nev.trim() === ''}>Összekötés</button>
      </form>
      {uzenet !== null && <p className="pub-uzenet" role="status">{uzenet}</p>}
    </section>
  )
}

export function FiokokNezet({ rpc }: { rpc: Rpc }) {
  const [adat, setAdat] = useState<FiokokAdat | null>(null)
  const [hiba, setHiba] = useState<string | null>(null)
  const [uzenet, setUzenet] = useState<string | null>(null)
  const [kuldes, setKuldes] = useState(false)
  const [platform, setPlatform] = useState('youtube')
  const [kulsoId, setKulsoId] = useState('')
  const [nev, setNev] = useState('')

  const tolt = useCallback(() => {
    rpc('fiokok')
      .then((raw) => { setAdat(readFiokok(raw)); setHiba(null) })
      .catch((err: unknown) => setHiba(errText(err)))
  }, [rpc])

  useEffect(() => { tolt() }, [tolt])

  const onOsszekot = useCallback(() => {
    setKuldes(true)
    rpc('fiokotOsszekot', { platform, kulsoId, nev })
      .then((raw) => {
        setKuldes(false)
        const refusal = refusalText(raw)
        if (refusal !== null) { setUzenet(refusal); return }
        setUzenet('Fiók összekötve.')
        setKulsoId('')
        setNev('')
        tolt()
      })
      .catch((err: unknown) => { setKuldes(false); setUzenet(`Az összekötés kérése el sem jutott a modulhoz: ${errText(err)}`) })
  }, [rpc, platform, kulsoId, nev, tolt])

  return (
    <FiokokBody
      adat={adat}
      hiba={hiba}
      uzenet={uzenet}
      kuldes={kuldes}
      platform={platform}
      kulsoId={kulsoId}
      nev={nev}
      onPlatform={setPlatform}
      onKulsoId={setKulsoId}
      onNev={setNev}
      onOsszekot={onOsszekot}
      onFrissit={tolt}
    />
  )
}

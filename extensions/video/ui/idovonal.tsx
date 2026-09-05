import type { MegtartasPont, Visszajelzes } from './api'
import { formatMs } from './format'
import type { Hatar } from './idovonal-state'
import { pixelbolMs, pontbolJelenet, szazalek, teljesHossz } from './idovonal-state'

/**
 * The finished render's scene bounds, drawn to scale, with the notes already
 * on it and the retention curve over it.
 *
 * WHAT A CLICK MEANS. A click anywhere on the strip becomes a millisecond
 * (`pixelbolMs` against the element's own width) and the scene that contains
 * it (`pontbolJelenet`), and the two go straight into the feedback form's
 * `atMs` and `jelenet` fields. Both are half-open-bounds arithmetic in
 * idovonal-state.ts, driven directly by the test, because this is the one
 * place on the page where a gesture turns into two stored numbers.
 *
 * WHY THE SCENES ARE BUTTONS. A keyboard operator has no pixel to offer, so
 * each scene is a real `<button>` that can be tabbed to and activated. A
 * keyboard activation reports `detail === 0` -- no pointer was involved --
 * and picks the scene's own first millisecond, which is the only honest
 * answer when nobody pointed at a position; a mouse click on the same button
 * falls through to the strip's handler and keeps the pixel it actually
 * landed on. Nothing here listens on the window: the aisignal page's review
 * found a window-level key handler swallowing Enter from every focused
 * control on the page, and this file avoids the whole class by never
 * installing one.
 *
 * The retention curve is a `polyline` built from numbers -- `t_s` and
 * `arany`, both validated as numbers by `importRetention` before storage --
 * inside an inline `<svg>`. No string from any row reaches the markup.
 */

export interface Pont {
  atMs: number
  jelenet: number | null
}

export function Idovonal({ hatarok, visszajelzesek, megtartas, onPick }: {
  hatarok: Hatar[]
  visszajelzesek: Visszajelzes[]
  megtartas: MegtartasPont[]
  onPick: (pont: Pont) => void
}) {
  const teljes = teljesHossz(hatarok)
  if (hatarok.length === 0 || teljes <= 0) {
    return <p className="vid-muted">Nincs idővonal: ehhez egy kész render jelenet-határai kellenek.</p>
  }

  const pickFromEvent = (clientX: number, rect: { left: number; width: number }) => {
    const atMs = pixelbolMs(clientX - rect.left, rect.width, teljes)
    onPick({ atMs, jelenet: pontbolJelenet(hatarok, atMs) })
  }

  // Only the points that fall inside the timeline are drawn. A note whose
  // `at_ms` is past the end of this render belongs to a different render and
  // is listed under the notes instead of being clamped onto the last scene.
  const jelolok = visszajelzesek.filter((v) => typeof v.atMs === 'number' && v.atMs >= 0 && v.atMs < teljes)

  const platformok = [...new Set(megtartas.map((p) => p.platform))].sort()

  return (
    <div className="vid-timeline-wrap">
      <div
        className="vid-timeline"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          pickFromEvent(e.clientX, rect)
        }}
      >
        {hatarok.map((h) => {
          const { left, width } = szazalek(h.kezdetMs, h.vegMs, teljes)
          return (
            <button
              key={h.jelenet}
              type="button"
              className="vid-timeline-scene"
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${h.jelenet}. jelenet — ${formatMs(h.kezdetMs)} … ${formatMs(h.vegMs)}`}
              onClick={(e) => {
                // A pointer click keeps its pixel and is handled by the strip
                // above; only a keyboard activation (`detail === 0`) is
                // answered here, with the scene's own start.
                if (e.detail !== 0) return
                e.stopPropagation()
                onPick({ atMs: h.kezdetMs, jelenet: h.jelenet })
              }}
            >
              <span className="vid-timeline-scene-no">{h.jelenet}</span>
            </button>
          )
        })}
        {jelolok.map((v) => (
          <span
            key={v.id}
            className="vid-timeline-mark"
            style={{ left: `${((v.atMs ?? 0) / teljes) * 100}%` }}
            title={`${formatMs(v.atMs)} — ${v.forras}`}
          />
        ))}
        {platformok.length > 0 && (
          <svg className="vid-timeline-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {platformok.map((platform) => {
              const pontok = megtartas
                .filter((p) => p.platform === platform)
                .slice()
                .sort((a, b) => a.tS - b.tS)
                .map((p) => `${Math.min(100, Math.max(0, ((p.tS * 1000) / teljes) * 100))},${Math.min(100, Math.max(0, (1 - p.arany) * 100))}`)
                .join(' ')
              return pontok === '' ? null : <polyline key={platform} points={pontok} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            })}
          </svg>
        )}
      </div>
      <p className="vid-muted vid-timeline-legend">
        Teljes hossz: {formatMs(teljes)} · {hatarok.length} jelenet · {jelolok.length} visszajelzés az idővonalon
        {platformok.length > 0 ? ` · megtartási görbe: ${platformok.join(', ')}` : ' · megtartási görbe: nincs importálva'}
      </p>
    </div>
  )
}

/**
 * A márka szóvédjegye: SidekickOS.
 *
 * Két szó, két szín: a "Sidekick" a lap saját szövegszínén áll, az "OS" az
 * accenten. Ezért NEM egy kép: a szóvédjegy így a témával együtt vált -- egy
 * exportált PNG sötét témában világos hátteret vinne, és minden méretben újra
 * kellene exportálni.
 *
 * A betű a `--font-logo` tokenből jön, fallbackkel a display-betűre. Ha a font
 * valaha eltűnik, a márkanév a hoszt betűjével jelenik meg -- nem tűnik el, és
 * nem esik vissza a böngésző alapbetűjére.
 */

/** A csukott railen csak ennyi fér el; ugyanabból a betűből. */
export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <div
      className="rounded-md bg-accent-bright flex items-center justify-center shrink-0 select-none"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span
        className="text-accent-fg leading-none"
        style={{ fontFamily: 'var(--font-logo)', fontSize: size * 0.55, paddingTop: size * 0.06 }}
      >
        S
      </span>
    </div>
  )
}

export function BrandWordmark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`leading-none whitespace-nowrap select-none ${className}`}
      style={{ fontFamily: 'var(--font-logo)', fontSize: size }}
    >
      <span className="text-text">Sidekick</span>
      <span className="text-accent-bright">OS</span>
    </span>
  )
}

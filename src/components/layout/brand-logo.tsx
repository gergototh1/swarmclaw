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

/**
 * A jel maga: egy arc. Magas homlok, keskeny áll -- a sziluett viszi a
 * karaktert, nem a részletek. Nem betű: egy "S" a railen bármelyik másik app
 * "S"-e lehetne, ez viszont csak ezé.
 *
 * A szemöldök a rajz legvékonyabb eleme: 20px-en már csak két elmosódott folt,
 * 16px alatt eltűnik. Ez ismert és vállalt -- a jelet 40px-en rajzoljuk a
 * railen, és a 20px-es helyeken a sziluett viszi.
 *
 * `fill-rule="evenodd"`, nem maszk: a lyukak (szem, szemöldök, orr, száj)
 * magából az alakzatból jönnek. Maszkhoz `id` kellene, egy `id` pedig egy
 * dokumentumban egyszer élhet -- a jel viszont a railen és a fejlécben is
 * megjelenhet egyszerre, és a második példány üresen maradna. Ez a rajz
 * akárhányszor lerajzolható.
 *
 * `currentColor`-ral rajzol, tehát a korall négyzeten a szülő adja a fehéret,
 * csupaszon pedig a szövegszínt veszi fel -- egy jel, minden háttéren.
 */
export function BrandGlyph({ size = 22, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      role="img"
      aria-label="SidekickOS"
    >
      <path fillRule="evenodd" clipRule="evenodd" d="M11.06 1.75C10.52 1.8 9.72 1.9 9.51 1.95C6.96 2.55 5.38 3.66 4.63 5.36C4.35 6.01 4.31 6.33 4.29 8L4.27 9.44L4.01 9.5C3.04 9.74 2.46 10.54 2.46 11.63C2.46 12.85 3.2 13.75 4.38 13.95C4.52 13.97 4.52 13.97 4.5 14.13C4.49 14.23 4.46 14.48 4.44 14.69C4.41 14.91 4.36 15.36 4.32 15.69C4.01 17.9 4.73 19.03 6.64 19.37C6.84 19.41 7.02 19.44 7.02 19.44C7.04 19.46 7.33 21.02 7.37 21.32C7.41 21.69 7.53 21.75 8.84 22.02C9.95 22.26 12.1 22.36 13.44 22.24C14.85 22.11 15.02 22.08 15.95 21.84C16.56 21.68 16.6 21.65 16.63 21.32C16.67 20.98 16.94 19.49 16.97 19.46C16.98 19.44 17.12 19.41 17.29 19.38C19.18 19.09 19.99 17.94 19.73 15.93C19.68 15.6 19.62 15.15 19.6 14.95C19.58 14.74 19.55 14.45 19.53 14.28C19.48 13.94 19.45 13.99 19.79 13.91C22.05 13.44 22.2 9.97 19.99 9.48C19.71 9.42 19.73 9.55 19.71 7.82C19.69 6.26 19.66 6.01 19.38 5.37C18.94 4.34 18.24 3.58 17.09 2.89C16.37 2.45 14.9 1.97 14 1.86C13.81 1.84 13.52 1.81 13.36 1.78C12.92 1.73 11.51 1.71 11.06 1.75ZM16.26 5.06C16.94 5.26 17.24 5.4 17.82 5.78C18.28 6.09 18.27 6.06 18.02 6.39C17.6 6.95 17.64 6.92 17.48 6.79C17.24 6.58 16.8 6.31 16.6 6.24C16.49 6.21 16.39 6.16 16.36 6.15C16.22 6.04 15.59 5.94 15.11 5.94C14.51 5.94 14.17 6.01 13.6 6.26L13.25 6.41L13.05 5.98C12.81 5.47 12.81 5.5 13 5.4C13.91 4.94 15.35 4.78 16.26 5.06ZM9.33 6.68C9.66 6.74 10.37 7.01 10.5 7.11C10.58 7.16 10.58 7.17 10.46 7.43C10.39 7.58 10.31 7.77 10.27 7.86C10.21 8.03 10.15 8.07 10.07 8C10.05 7.98 9.92 7.91 9.76 7.85C8.68 7.39 7.38 7.55 6.51 8.23C6.31 8.39 6.3 8.39 6 7.99C5.68 7.57 5.68 7.6 5.98 7.39C6.52 7.01 7.04 6.78 7.62 6.69C7.82 6.65 8.04 6.61 8.09 6.6C8.27 6.57 9.01 6.61 9.33 6.68ZM15.84 7.46C16.83 7.67 17.64 8.7 17.64 9.74C17.64 10.27 17.32 11.08 17.13 11.05C17.08 11.03 16.82 10.98 16.56 10.92C16.3 10.87 16.04 10.82 15.97 10.82C15.76 10.82 15.73 10.76 15.88 10.67C16.73 10.15 16.38 8.78 15.37 8.68C14.28 8.57 13.76 10.01 14.66 10.67C14.81 10.77 14.81 10.78 14.72 10.8C14.68 10.81 14.43 10.85 14.19 10.9C13.95 10.95 13.66 11.01 13.57 11.04C13.34 11.11 13.35 11.11 13.16 10.74C12.28 9 13.89 7.05 15.84 7.46ZM8.99 9.22C9.49 9.39 9.81 9.69 9.99 10.15C10.19 10.67 10.13 10.71 9.57 10.52C8.7 10.24 8.01 10.24 7.18 10.55C6.72 10.72 6.62 10.55 6.88 10.05C7.28 9.28 8.16 8.93 8.99 9.22ZM11.02 12.77C11.55 13.17 12.39 13.15 12.94 12.73C13.08 12.62 13.08 12.62 13.19 12.75C13.45 13.06 13.45 13.03 13.2 13.31C12.77 13.79 12.06 14 11.5 13.81C11.03 13.66 10.43 13.16 10.51 13.01C10.6 12.86 10.82 12.64 10.86 12.66C10.88 12.67 10.96 12.72 11.02 12.77ZM16.61 13C17.15 13.16 17.5 13.93 17.37 14.7C17.29 15.11 17.14 15.21 17.03 14.92C16.91 14.62 16.72 14.28 16.64 14.2C16.55 14.12 16.55 14.12 16.27 14.48C14.86 16.37 12.7 17.09 9.99 16.57C9.49 16.48 8.76 16.26 8.67 16.17C8.62 16.12 8.8 15.58 8.86 15.55C8.89 15.54 9.06 15.58 9.25 15.63C11.56 16.29 14.07 15.73 15.6 14.21C16.14 13.67 16.14 13.7 15.54 13.51C15 13.34 14.95 13.29 15.16 13.14C15.42 12.96 16.19 12.88 16.61 13Z"/>
    </svg>
  )
}

/** A csukott railen csak ennyi fér el. */
export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <div
      className="rounded-md bg-accent-bright flex items-center justify-center shrink-0 select-none"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {/* 0.78: ezen az arányon tölti ki a fej a négyzetet anélkül, hogy a
          hajforma a lekerekített sarokba szaladna. */}
      <BrandGlyph size={Math.round(size * 0.78)} className="text-accent-fg" />
    </div>
  )
}

/**
 * Jel + név egyben. Ez kell mindenhová, ahol a márkanév KI VAN ÍRVA: a nyitott
 * railre és a kezdőlap címére. Azért egy komponens, mert különben a köz és a
 * jel mérete a két helyen külön értékként élne, és az első átméretezésnél
 * elcsúsznának egymástól.
 *
 * A jel a dobozos változat, ugyanaz, amit a csukott rail mutat -- így a rail
 * nyitásakor a jel nem vált alakot, csak zsugorodik. (Doboz nélküli jellel is
 * működik: `BrandMark` helyett `BrandGlyph`, accent színnel.)
 *
 * 1.35 / 0.42: a doboz valamivel magasabb a nagybetűnél, a köz pedig a
 * betűméret alig fele -- ennél szűkebben a jel a "S"-hez tapad, tágabban két
 * külön dolognak látszik.
 */
export function BrandLockup({ size = 19, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} style={{ gap: Math.round(size * 0.42) }}>
      <BrandMark size={Math.round(size * 1.35)} />
      <BrandWordmark size={size} />
    </span>
  )
}

export function BrandWordmark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`leading-none whitespace-nowrap select-none ${className}`}
      // 700 / -0.025em: ezen a súlyon és tracking-en állt össze a védjegy a
      // mintalapon, és ezen fér el a 212px-es railen.
      style={{ fontFamily: 'var(--font-logo)', fontWeight: 700, fontSize: size, letterSpacing: '-0.025em' }}
    >
      <span className="text-text">Sidekick</span>
      <span className="text-accent-bright">OS</span>
    </span>
  )
}

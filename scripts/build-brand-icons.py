#!/usr/bin/env python3
"""Az alkalmazásikon a jelből: PNG, ICNS és ICO.

A jel a kódból jön (`brand-logo.tsx`), nem másolatból -- az ikon így nem tud
elcsúszni attól, amit a rail rajzol.

A macOS-arányok szándékosan nem az én ízlésem: a Big Sur óta minden rendszerikon
ugyanabban a rácsban ül, és a Dockban egymás mellett az látszik, amelyik kilóg
belőle. A 1024-es vászonból a lekerekített négyzet 824 széles, tehát 100px
levegő van körben; a sarok sugara a szélesség 22.37%-a, ez az Apple folytonos
lekerekítésének a közelítése körívvel.
"""
import pathlib, re, shutil, subprocess, tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / 'resources'
WORK = pathlib.Path(tempfile.mkdtemp(prefix='sidekick-icons-'))

GLYPH = re.search(r'(<path fillRule[^/]+/>)',
                  (REPO / 'src/components/layout/brand-logo.tsx').read_text()).group(1) \
    .replace('fillRule', 'fill-rule').replace('clipRule', 'clip-rule')

IMAGEMAGICK = shutil.which('convert') or '/opt/ImageMagick/bin/convert'

ACCENT = '#C9452F'      # a világos téma accentje -- az ikon nem témázódik
CANVAS = 1024
PLATE = 824             # a lekerekített négyzet
RADIUS = round(PLATE * 0.2237)
GLYPH_W = round(PLATE * 0.68)   # ennél nagyobbnál a fej a sarokba szalad


def svg(canvas, plate, radius, glyph_w, bleed=False):
    """`bleed`: teljes vászon, levegő nélkül -- ezt kéri a Windows és a web."""
    if bleed:
        plate, radius = canvas, round(canvas * 0.2237)
    off = (canvas - plate) / 2
    gx = (canvas - glyph_w) / 2
    # A rajz mértani közepe nem az optikai közepe: a tömeg a fejben van, alul
    # csak a nyak keskeny csonkja. Középre téve a jel lelógni látszik.
    gy = gx - plate * 0.018
    scale = glyph_w / 24
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{canvas}" height="{canvas}"
     viewBox="0 0 {canvas} {canvas}">
  <rect x="{off}" y="{off}" width="{plate}" height="{plate}" rx="{radius}" ry="{radius}" fill="{ACCENT}"/>
  <g transform="translate({gx} {gy}) scale({scale})" fill="#FFFFFF">{GLYPH}</g>
</svg>'''


def png(path, size, bleed=False):
    import cairosvg
    src = svg(CANVAS, PLATE, RADIUS, GLYPH_W, bleed)
    cairosvg.svg2png(bytestring=src.encode(), write_to=str(path),
                     output_width=size, output_height=size)
    return path


def main():
    OUT.mkdir(exist_ok=True)

    png(OUT / 'icon.png', 1024)

    # .icns: az iconset minden párja kell, különben az iconutil hallgat és
    # hiányos ikont ír -- a Dockban a helyes méret hiánya elmosódásként látszik.
    iconset = WORK / 'SidekickOS.iconset'
    subprocess.run(['rm', '-rf', str(iconset)], check=True)
    iconset.mkdir()
    for base in (16, 32, 128, 256, 512):
        png(iconset / f'icon_{base}x{base}.png', base)
        png(iconset / f'icon_{base}x{base}@2x.png', base * 2)
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(OUT / 'icon.icns')], check=True)

    # .ico: a Windows a fájlba ágyazott méretek közül választ; teljes vászon,
    # mert a tálcán nincs, ami a levegőt kitöltse.
    ico_dir = WORK / 'ico'
    subprocess.run(['rm', '-rf', str(ico_dir)], check=True)
    ico_dir.mkdir()
    sizes = [16, 24, 32, 48, 64, 128, 256]
    for s in sizes:
        png(ico_dir / f'{s}.png', s, bleed=True)
    subprocess.run([IMAGEMAGICK,
                    *[str(ico_dir / f'{s}.png') for s in sizes], str(OUT / 'icon.ico')], check=True)

    for f in ('icon.png', 'icon.icns', 'icon.ico'):
        print(f'{f:12} {(OUT / f).stat().st_size:>9,} bájt')

    # A Sidekick agent avatarja ugyanaz a jel. `bleed`, mert az AgentAvatar
    # `rounded-full` keretbe teszi: levegős lappal a korall négyzet széle
    # látszana a körben, tele vászonnal viszont sima korall korong lesz belőle.
    # Nem az uploads könyvtárba megy, hanem a `public/`-ba: ez márkaelem, nem
    # felhasználói tartalom, és így túléli az adatkönyvtár ürítését is.
    # A böngészőfül ikonja. `bleed`: a fül 16px-es, ott minden levegő
    # elveszett méret. Ez a fájl adja a favicont ÉS a webes app-ikont is --
    # a Next a `src/app/icon.svg`-t mindkettőre használja.
    (REPO / 'src/app/icon.svg').write_text(
        svg(CANVAS, PLATE, RADIUS, GLYPH_W, bleed=True)
        .replace('<svg ', '<svg role="img" aria-label="SidekickOS" ', 1))
    print('src/app/icon.svg  kiírva')

    brand = REPO / 'public/brand'
    brand.mkdir(parents=True, exist_ok=True)
    png(brand / 'sidekick-avatar.png', 512, bleed=True)
    print(f'avatar       {(brand / "sidekick-avatar.png").stat().st_size:>9,} bájt')


if __name__ == '__main__':
    main()
    shutil.rmtree(WORK, ignore_errors=True)

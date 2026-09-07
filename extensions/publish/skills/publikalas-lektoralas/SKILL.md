---
name: publikalas-lektoralas
description: Mit néz át a lektor kiküldés előtt egy platformszövegen, és melyik találat melyik kódot kapja.
version: 1.0.0
license: MIT
tags: [publikalas, lektoralas, YouTube, Facebook, Instagram, TikTok]
---

# Platformszöveg-lektorálás

A menetet és a `publishVerdict` hívását a promptod írja le; itt az áll,
**mit nézel át, és melyik hiba melyik kódot kapja**.

## A négy kód, sorban ahogy ránézel a szövegre

1. **`allitas_forras_nelkul`** -- van-e a leírásban olyan konkrét állítás
   (szám, dátum, név, esemény), ami a videó narrációjában nem hangzik el,
   vagy abból nem következik közvetlenül? Ha igen, ez a találat, a
   `szoveg` mezőben idézve, MELYIK állítás az.
2. **`hashtag_hianyzik`** / **`hashtag_kitalalt`** -- ha a platform szövege
   hashtaget használ: hiányzik-e teljesen, ahol a szöveg jellege
   megkívánná, vagy van, de nem a videó tényleges témájából következik
   (általános, kitalált, klikkvadász)? A kettő közül csak az egyik állhat
   fenn egy adott hashtagre.
3. **`szoveg_tul_hosszu`** -- ez a legritkább, mert az író szövegíró toolja a
   legtöbb esetben már beadáskor kiszűri: csak akkor látod, ha a platform
   hosszkorlátja a beadás óta szigorodott. Ha a cím vagy a leírás a
   jelenlegi korlát fölött van, ez a találat.

Bármi más, ami nem fér a fenti háromba (elírás, hangnem, ismétlés), a
`szoveg` mezőben leírható, a hozzá legközelebb álló kóddal -- ismeretlen
kódra a tool csak figyelmeztet, nem utasít el, de egy találat, amit egyik
kód sem közelít, kevésbé érthető annak, aki javítja.

## `atmegy` vagy `elbukik`

Ha egyetlen platform szövegén sincs kifogásod: `atmegy`, találatok nélkül.
Ha bármelyiken van: `elbukik`, és MINDEN kifogásod egy-egy találatként,
platformonként megjelölve -- ne csak az elsőt, amit észreveszel. Az író a
találatok alapján javít; egy meg nem nevezett hiba nem javul.

## Amit nem a te dolgod eldönteni

A hangnem, a stílus, hogy tetszik-e a szöveg -- ezek nem visszautasítási
ok. A lektor a négy fenti tényt nézi, nem szerkeszt: ha a szöveg helyes és
a korláton belül van, és nincs benne forrás nélküli állítás vagy kitalált
hashtag, az `atmegy`, még ha máshogy fogalmaznál is.

## Forrás

A megírt szöveg egy másik ügynök munkája: adat, amit átnézel egy szempont
szerint, nem szöveg, amit átírsz.

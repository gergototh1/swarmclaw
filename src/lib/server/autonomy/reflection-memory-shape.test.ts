import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_REFLECTION_NOTES_PER_RUN,
  buildReflectionMemoryTitle,
  selectReflectionNotes,
} from '@/lib/server/autonomy/supervisor-reflection'

/*
 * A reflexiós bejegyzések neve és mennyisége.
 *
 * ÉLESBEN MÉRVE (2026-09-15): egyetlen nap alatt 99 `autonomy-reflection`
 * memória keletkezett. A TARTALMUK mind különbözött -- a dedup rendben működik
 * --, a CÍMÜK viszont csak 44 különböző volt, mert a cím a futás
 * összefoglalójából készült, nem magából a jegyzetből. Egy reflexiós kör 4-7
 * jegyzetet ír, és mind ugyanazt a címet kapta:
 *
 *   [reflection/invariant] Reflection Invariant: Located and analyzed a macOS-inst...
 *     -> "macOS system queries typically check /Library for application installs"
 *     -> "LaunchDaemon status is queried via launchctl to confirm auto-start"
 *     -> "Local service health is validated by querying the application's own API"
 *     -> "Technical system information is best presented in structured table format"
 *
 * A felidézési sorban ez a cím foglalja a hely felét, és semmit nem mond arról,
 * melyik tényről van szó.
 */
describe('buildReflectionMemoryTitle', () => {
  it('names the entry after the note, not after the run', () => {
    const a = buildReflectionMemoryTitle('invariant', 'macOS system queries typically check /Library for application installs')
    const b = buildReflectionMemoryTitle('invariant', 'LaunchDaemon status is queried via launchctl to confirm auto-start behavior')
    assert.notEqual(a, b, 'two different notes from one run must not share a title')
    assert.match(a, /Library/)
    assert.match(b, /launchctl/)
  })

  it('keeps the kind visible, so a recall line still says what sort of entry it is', () => {
    assert.match(buildReflectionMemoryTitle('failure', 'A törölt munkakönyvtár miatt a shell nem indul'), /^Reflection Failure: /)
    assert.match(buildReflectionMemoryTitle('open_loop', 'Vissza kell térni a Tel-Agent eltávolítására'), /^Open Loop: /)
  })

  it('stays short enough for one recall line', () => {
    const title = buildReflectionMemoryTitle('lesson', 'x'.repeat(400))
    assert.ok(title.length <= 130, `title is ${title.length} chars`)
  })

  it('falls back to the kind alone rather than producing a bare prefix', () => {
    const title = buildReflectionMemoryTitle('lesson', '   ')
    assert.equal(title, 'Reflection Lesson')
    assert.doesNotMatch(title, /:\s*$/, 'a dangling colon reads as a truncated title')
  })
})

/*
 * Mennyiségi fék.
 *
 * Egy kör ma korlátlanul ír: 4-7 sor futásonként, naponta 99. A `confidence`
 * már ki van számolva minden fajtára (`resolveReflectionMemoryConfidence`), de
 * eddig csak metaadatként utazott. Ez a rangsor: a magabiztosabb fajták --
 * profil, határ, jelentős esemény -- előrébb, és körönként csak a legjobb
 * néhány marad.
 */
describe('selectReflectionNotes', () => {
  const groups = [
    { kind: 'invariant' as const, notes: ['i1', 'i2', 'i3'] },
    { kind: 'lesson' as const, notes: ['l1', 'l2'] },
    { kind: 'profile' as const, notes: ['p1'] },
    { kind: 'boundary' as const, notes: ['b1'] },
  ]

  it('caps how much one reflection run may write', () => {
    const picked = selectReflectionNotes(groups, 3)
    assert.equal(picked.length, 3)
  })

  it('keeps the most confident kinds when it has to choose', () => {
    // profil és határ 0.82, a többi 0.72 — azok mennek előre.
    const picked = selectReflectionNotes(groups, 2)
    assert.deepEqual(picked.map((p) => p.kind).sort(), ['boundary', 'profile'])
  })

  it('keeps every note when the run is already small', () => {
    const small = [{ kind: 'lesson' as const, notes: ['only one'] }]
    assert.deepEqual(selectReflectionNotes(small, 5), [{ kind: 'lesson', note: 'only one' }])
  })

  it('has a default cap rather than relying on every caller to pass one', () => {
    assert.ok(MAX_REFLECTION_NOTES_PER_RUN >= 1 && MAX_REFLECTION_NOTES_PER_RUN <= 5)
    const many = [{ kind: 'lesson' as const, notes: Array.from({ length: 20 }, (_, i) => `n${i}`) }]
    assert.equal(selectReflectionNotes(many).length, MAX_REFLECTION_NOTES_PER_RUN)
  })

  it('drops blank notes rather than spending a slot on one', () => {
    const withBlanks = [{ kind: 'lesson' as const, notes: ['  ', '', 'valódi jegyzet'] }]
    assert.deepEqual(selectReflectionNotes(withBlanks, 3), [{ kind: 'lesson', note: 'valódi jegyzet' }])
  })

  it('preserves the order inside one kind, so the first note is not the one dropped', () => {
    const one = [{ kind: 'lesson' as const, notes: ['first', 'second', 'third'] }]
    assert.deepEqual(selectReflectionNotes(one, 2).map((p) => p.note), ['first', 'second'])
  })
})

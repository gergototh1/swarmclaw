import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/*
 * A saját buborék a felület-létra egyik foka, NEM az accent.
 *
 * Korábban a korall `--ac` volt, ami a chat legerősebb színfoltját tette
 * minden második üzenetre. A létra lépcsőjére kötve mindkét téma magától
 * helyes marad, és nem kell új tokent karbantartani.
 */
describe('user bubble tokens', () => {
  const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8')

  it('paints the user bubble from the surface ladder, not the accent', () => {
    assert.match(css, /--color-user-bubble:\s*var\(--surface-selected\)/)
    assert.doesNotMatch(css, /--color-user-bubble:\s*var\(--ac\)/)
  })

  it('reads the bubble text as body text, not as on-accent text', () => {
    assert.match(css, /--color-user-text:\s*var\(--color-text\)/)
  })

  it('drops the token the gradient removal orphaned', () => {
    assert.doesNotMatch(css, /--color-user-bubble-2/)
  })

  it('drops the ai bubble shell entirely', () => {
    assert.doesNotMatch(css, /^\.bubble-ai\s*\{/m)
  })
})

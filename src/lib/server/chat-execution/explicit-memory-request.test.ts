import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { detectExplicitMemoryRequest } from './explicit-memory-request'

describe('detectExplicitMemoryRequest', () => {
  it('catches a Hungarian instruction and keeps the fact', () => {
    const out = detectExplicitMemoryRequest('Jegyezd meg, hogy a határidő péntekre csúszott.')
    assert.ok(out)
    assert.equal(out!.content, 'a határidő péntekre csúszott.')
  })

  it('works without accents, the way people actually type in a hurry', () => {
    const out = detectExplicitMemoryRequest('jegyezd meg hogy a hatarido pentekre csuszott')
    assert.ok(out)
    assert.ok(out!.content.includes('hatarido'), out!.content)
  })

  it('catches the other Hungarian phrasings', () => {
    for (const message of [
      'Ne felejtsd el, hogy a YouTube auth törött.',
      'Tartsd észben, hogy mindig magyarul válaszolj.',
      'Írd fel, hogy a Clarity a medivoxhoz tartozik.',
    ]) {
      assert.ok(detectExplicitMemoryRequest(message), message)
    }
  })

  it('catches English instructions', () => {
    for (const message of [
      'Remember that the deploy goes through the staging bucket first.',
      "Don't forget that the client prefers short replies.",
      'Keep in mind that the API key lives in the vault.',
    ]) {
      assert.ok(detectExplicitMemoryRequest(message), message)
    }
  })

  it('ignores a question that merely mentions remembering', () => {
    // "Do you remember what we decided?" is a recall, not a write. Storing it
    // would file the question itself as a durable fact.
    assert.equal(detectExplicitMemoryRequest('Emlékszel, hogy mit döntöttünk a stratégiáról?'), null)
    assert.equal(detectExplicitMemoryRequest('Do you remember that decision we made?'), null)
  })

  it('ignores ordinary conversation', () => {
    for (const message of [
      'Nézd meg a build naplót és mondd meg, mi a baj.',
      'Please refactor the memory module for clarity.',
      'ok',
      '',
    ]) {
      assert.equal(detectExplicitMemoryRequest(message), null, message)
    }
  })

  it('refuses a turn that also asked for other work', () => {
    // Deciding "is this turn only a memory write" is a judgement a phrase list
    // cannot make. Claiming the turn is finished after the write would drop
    // the second request silently.
    for (const message of [
      'Remember that my launch marker is ALPHA-9 and then make a file called notes.txt.',
      'Jegyezd meg, hogy a határidő péntek, és utána csinálj egy összefoglalót.',
    ]) {
      assert.equal(detectExplicitMemoryRequest(message), null, message)
    }
  })

  it('ignores a bare instruction with nothing to store', () => {
    assert.equal(detectExplicitMemoryRequest('jegyezd meg'), null)
  })

  it('keeps the whole message when the instruction is not at the front', () => {
    const out = detectExplicitMemoryRequest('A build most már megy, jegyezd meg ezt a beállítást.')
    assert.ok(out)
    assert.ok(out!.content.includes('build'), out!.content)
  })
})

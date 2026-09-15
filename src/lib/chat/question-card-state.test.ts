import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canSubmit, createDrafts, draftsToAnswers, setOther, toggleOption } from './question-card-state'

const payload = {
  questions: [
    { header: 'Adatbázis', question: 'Melyik legyen?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
    { question: 'Mit kapcsoljunk be?', multiSelect: true, options: [{ label: 'WAL' }, { label: 'FTS' }] },
  ],
  expectedFormat: null,
  notes: null,
}

describe('question-card-state', () => {
  it('starts with empty drafts', () => {
    const drafts = createDrafts(payload)
    assert.equal(drafts.length, 2)
    assert.deepEqual(drafts[0], { selected: [], other: '' })
    assert.equal(canSubmit(payload, drafts), false)
  })

  it('replaces the selection on a single-select question', () => {
    let draft = createDrafts(payload)[0]
    draft = toggleOption(draft, 'SQLite', false)
    draft = toggleOption(draft, 'Postgres', false)
    assert.deepEqual(draft.selected, ['Postgres'])
  })

  it('adds and removes on a multi-select question', () => {
    let draft = createDrafts(payload)[1]
    draft = toggleOption(draft, 'WAL', true)
    draft = toggleOption(draft, 'FTS', true)
    assert.deepEqual(draft.selected, ['WAL', 'FTS'])
    draft = toggleOption(draft, 'WAL', true)
    assert.deepEqual(draft.selected, ['FTS'])
  })

  it('clears the selection when free text is typed', () => {
    let draft = toggleOption(createDrafts(payload)[0], 'SQLite', false)
    draft = setOther(draft, 'DuckDB')
    assert.deepEqual(draft.selected, [])
    assert.equal(draft.other, 'DuckDB')
  })

  it('allows submitting once every question has an answer', () => {
    const drafts = createDrafts(payload)
    drafts[0] = toggleOption(drafts[0], 'SQLite', false)
    assert.equal(canSubmit(payload, drafts), false)
    drafts[1] = setOther(drafts[1], 'semmit')
    assert.equal(canSubmit(payload, drafts), true)
  })

  it('builds answers that carry the header and the free text', () => {
    const drafts = createDrafts(payload)
    drafts[0] = toggleOption(drafts[0], 'SQLite', false)
    drafts[1] = setOther(drafts[1], 'semmit')
    assert.deepEqual(draftsToAnswers(payload, drafts), [
      { header: 'Adatbázis', question: 'Melyik legyen?', selected: ['SQLite'] },
      { question: 'Mit kapcsoljunk be?', selected: [], other: 'semmit' },
    ])
  })
})

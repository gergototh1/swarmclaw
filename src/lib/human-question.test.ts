import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_OPTIONS_PER_QUESTION,
  MAX_QUESTIONS,
  normalizeHumanQuestionInput,
  renderHumanAnswerText,
  renderHumanQuestionText,
  validateHumanAnswers,
} from './human-question'

describe('normalizeHumanQuestionInput', () => {
  it('turns the legacy shape into one question', () => {
    const result = normalizeHumanQuestionInput({ question: 'Melyik legyen?', options: ['SQLite', 'Postgres'] })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.payload.questions.length, 1)
    assert.deepEqual(result.payload.questions[0].options, [{ label: 'SQLite' }, { label: 'Postgres' }])
  })

  it('keeps a question with no options as free text', () => {
    const result = normalizeHumanQuestionInput({ question: 'Mi legyen a neve?' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.payload.questions[0].options, [])
  })

  it('accepts the rich shape with headers and option descriptions', () => {
    const result = normalizeHumanQuestionInput({
      questions: [
        {
          header: 'Adatbázis',
          question: 'Melyik legyen?',
          multiSelect: false,
          options: [{ label: 'SQLite', description: 'egyszerű' }, { label: 'Postgres' }],
        },
      ],
      notes: 'a migrációt is nézd',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.payload.questions[0].header, 'Adatbázis')
    assert.equal(result.payload.questions[0].options[0].description, 'egyszerű')
    assert.equal(result.payload.notes, 'a migrációt is nézd')
  })

  it('rejects more than MAX_QUESTIONS questions', () => {
    const questions = Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({ question: `k${i}`, options: [] }))
    const result = normalizeHumanQuestionInput({ questions })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /At most 4 questions/)
  })

  it('rejects more than MAX_OPTIONS_PER_QUESTION options', () => {
    const options = Array.from({ length: MAX_OPTIONS_PER_QUESTION + 1 }, (_, i) => `o${i}`)
    const result = normalizeHumanQuestionInput({ question: 'Melyik?', options })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /At most 4 options/)
  })

  it('rejects an empty question', () => {
    const result = normalizeHumanQuestionInput({ options: ['a', 'b'] })
    assert.equal(result.ok, false)
  })
})

describe('validateHumanAnswers', () => {
  const payload = {
    questions: [
      { header: 'Adatbázis', question: 'Melyik legyen?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
      { question: 'Mit kapcsoljunk be?', multiSelect: true, options: [{ label: 'WAL' }, { label: 'FTS' }] },
    ],
    expectedFormat: null,
    notes: null,
  }

  it('accepts one option per single-select question', () => {
    const result = validateHumanAnswers(payload, [
      { question: 'Melyik legyen?', selected: ['SQLite'] },
      { question: 'Mit kapcsoljunk be?', selected: ['WAL', 'FTS'] },
    ])
    assert.equal(result.ok, true)
  })

  it('accepts free text instead of an option', () => {
    const result = validateHumanAnswers(payload, [
      { question: 'Melyik legyen?', selected: [], other: 'DuckDB' },
      { question: 'Mit kapcsoljunk be?', selected: ['WAL'] },
    ])
    assert.equal(result.ok, true)
  })

  it('rejects an option that is not on the list', () => {
    const result = validateHumanAnswers(payload, [
      { question: 'Melyik legyen?', selected: ['MySQL'] },
      { question: 'Mit kapcsoljunk be?', selected: ['WAL'] },
    ])
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.match(result.error, /MySQL/)
  })

  it('rejects two options on a single-select question', () => {
    const result = validateHumanAnswers(payload, [
      { question: 'Melyik legyen?', selected: ['SQLite', 'Postgres'] },
      { question: 'Mit kapcsoljunk be?', selected: ['WAL'] },
    ])
    assert.equal(result.ok, false)
  })

  it('rejects a missing answer', () => {
    const result = validateHumanAnswers(payload, [{ question: 'Melyik legyen?', selected: ['SQLite'] }])
    assert.equal(result.ok, false)
  })

  it('rejects an empty answer', () => {
    const result = validateHumanAnswers(payload, [
      { question: 'Melyik legyen?', selected: [] },
      { question: 'Mit kapcsoljunk be?', selected: ['WAL'] },
    ])
    assert.equal(result.ok, false)
  })
})

describe('render helpers', () => {
  it('renders a question as plain text', () => {
    const text = renderHumanQuestionText({
      questions: [{ header: 'Adatbázis', question: 'Melyik legyen?', options: [{ label: 'SQLite', description: 'egyszerű' }] }],
      expectedFormat: null,
      notes: null,
    })
    assert.match(text, /Adatbázis/)
    assert.match(text, /Melyik legyen\?/)
    assert.match(text, /1\. SQLite — egyszerű/)
  })

  it('renders answers as plain text', () => {
    const text = renderHumanAnswerText([
      { header: 'Adatbázis', question: 'Melyik legyen?', selected: ['SQLite'] },
      { question: 'Mi a neve?', selected: [], other: 'fleet.db' },
    ])
    assert.equal(text, 'Adatbázis: SQLite\nMi a neve?: fleet.db')
  })
})

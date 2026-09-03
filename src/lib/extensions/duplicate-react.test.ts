import assert from 'node:assert/strict'
import { test } from 'node:test'
import { looksLikeDuplicateReact } from './duplicate-react'

/**
 * The wordings react 19 produces when an extension bundle ships its own copy.
 *
 * A second React's hook dispatcher is null while the host renders, so the throw
 * is a plain TypeError from the engine, and its shape depends on both the engine
 * and whether the bundle is a development or a production build of React.
 */
const developmentBuild = [
  // resolveDispatcher() returns null and Chrome names only the property read.
  "Cannot read properties of null (reading 'useState')",
  // Firefox names the property, then the expression that was null.
  'can\'t access property "useState", resolveDispatcher(...) is null',
  // Safari quotes the whole expression it evaluated. No object is named here:
  // in a development build the dispatcher comes back from a function call.
  "null is not an object (evaluating 'resolveDispatcher().useState')",
]

const productionBuild = [
  "Cannot read properties of null (reading 'useState')",
  'can\'t access property "H", ReactSharedInternals is null',
  "null is not an object (evaluating 'ReactSharedInternals.H.useState')",
  // Minified React reduces its own friendly check to an error code.
  'Minified React error #321; visit https://react.dev/errors/321 for the full message',
]

test('every engine wording for a duplicate React is recognised in development builds', () => {
  for (const message of developmentBuild) {
    assert.equal(looksLikeDuplicateReact(message), true, message)
  }
})

test('every engine wording for a duplicate React is recognised in production builds', () => {
  for (const message of productionBuild) {
    assert.equal(looksLikeDuplicateReact(message), true, message)
  }
})

test('React\'s own invalid hook call sentence is still recognised', () => {
  assert.equal(
    looksLikeDuplicateReact('Invalid hook call. Hooks can only be called inside of the body of a function component.'),
    true,
  )
})

test('an ordinary extension error does not get the duplicate React hint', () => {
  for (const message of [
    'fetch failed',
    "Cannot read properties of undefined (reading 'items')",
    "Cannot read properties of null (reading 'length')",
    'null is not an object (evaluating \'response.items.length\')',
    'can\'t access property "length", response is null',
  ]) {
    assert.equal(looksLikeDuplicateReact(message), false, message)
  }
})

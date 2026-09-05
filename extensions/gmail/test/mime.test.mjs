import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { test } from 'node:test'

import { GmailError } from '../src/hibak.mjs'
import { base64url, buildMime } from '../src/mime.mjs'

/**
 * `mime.mjs` is the only place in the extension where text of foreign origin is
 * put into a structure, so it is the only place an injection could take a
 * shape. Most of this file is that one rule, tested from both sides: what is
 * refused, and what the refusal does NOT do instead (escape, strip, truncate).
 */

/** The headers of a built message, as a list of `[name, value]` on unfolded lines. */
function headersOf(mime) {
  const [head] = mime.split('\r\n\r\n')
  return head
    // RFC 5322 folding: a line beginning with whitespace continues the one above.
    .replace(/\r\n[ \t]/g, '')
    .split('\r\n')
    .map((line) => {
      const at = line.indexOf(': ')
      return [line.slice(0, at), line.slice(at + 2)]
    })
}

const headerNamed = (mime, name) => headersOf(mime).filter(([n]) => n === name).map(([, v]) => v)

/** Undo RFC 2047 base64 encoded-words, so a test can assert on the subject a reader sees. */
function decodeEncodedWords(value) {
  return value.replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_m, b64) => Buffer.from(b64, 'base64').toString('utf8'))
}

const body = (mime) => Buffer.from(mime.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8')

/** Runs a builder and returns the GmailError it threw, failing the test when it did not throw one. */
function refused(fn) {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof GmailError, `expected a GmailError, got ${err}`)
    return err
  }
  return assert.fail('expected a refusal')
}

test('a Hungarian subject is RFC 2047 encoded, and comes back out as it went in', () => {
  // A raw UTF-8 subject line is not something Gmail accepts, and a Hungarian
  // subject is never ASCII.
  const targy = 'Árvíztűrő tükörfúrógép'
  const mime = buildMime({ cimek: ['dorina@example.test'], targy, torzs: 'Szia!' })
  const [subject] = headerNamed(mime, 'Subject')
  assert.match(subject, /^=\?UTF-8\?B\?/)
  assert.equal(decodeEncodedWords(subject), targy)
  // The bytes on the wire are ASCII, which is the whole point of the encoding.
  assert.equal(/^[\x20-\x7e]*$/.test(subject), true)
})

test('an ASCII subject goes out as written, because encoding it would only make it unreadable', () => {
  const mime = buildMime({ cimek: ['dorina@example.test'], targy: 'Monthly report', torzs: 'Hi' })
  assert.deepEqual(headerNamed(mime, 'Subject'), ['Monthly report'])
})

test('a long non-ASCII subject is folded into encoded-words that decode back into one subject', () => {
  // RFC 2047 allows 75 characters per encoded-word. One 300-character Hungarian
  // subject on a single line is what "gets stuck at Gmail" looks like.
  const targy = 'Árvíztűrő tükörfúrógép '.repeat(13).trim()
  const mime = buildMime({ cimek: ['dorina@example.test'], targy, torzs: 'x' })
  const [head] = mime.split('\r\n\r\n')
  for (const line of head.split('\r\n')) {
    assert.ok(line.length <= 78, `a header line is ${line.length} characters: ${line.slice(0, 40)}`)
  }
  // Folded with CRLF and a space, which is folding white space rather than a
  // break in the value, so a reader reassembles the original subject.
  assert.equal(decodeEncodedWords(headerNamed(mime, 'Subject')[0]), targy)
  // No multi-byte character was cut in half on the way.
  assert.equal(decodeEncodedWords(headerNamed(mime, 'Subject')[0]).includes('�'), false)
})

test('a line break in the subject refuses the whole message and is not escaped away', () => {
  // The live shape of the attack: a subject that continues into a header of its
  // own. Escaping it would deliver a subject the sender did not write and tell
  // the caller the message went out as composed.
  const err = refused(() => buildMime({
    cimek: ['dorina@example.test'],
    targy: 'Havi jelentes\r\nBcc: valaki@masholt.example',
    torzs: 'Szia!',
  }))
  assert.equal(err.code, 'gmail_mezo_nem_tamogatott')
  assert.match(err.message, /^targy nem tartalmazhat sortorest$/)
  // The refusal names the field, never the text: that text was written by a
  // stranger, and quoting it would carry it into a log line as this module's
  // own words.
  assert.equal(err.message.includes('masholt'), false)

  // A bare newline is the same fact as a CRLF, and so is a lone carriage return.
  assert.equal(refused(() => buildMime({ cimek: ['a@b.test'], targy: 'x\ny', torzs: 'z' })).code, 'gmail_mezo_nem_tamogatott')
  assert.equal(refused(() => buildMime({ cimek: ['a@b.test'], targy: 'x\ry', torzs: 'z' })).code, 'gmail_mezo_nem_tamogatott')
})

test('a line break in an address refuses the whole message, and the refusal names which address', () => {
  const err = refused(() => buildMime({
    cimek: ['dorina@example.test', 'valaki@example.test\r\nBcc: masvalaki@example.test'],
    targy: 'Havi jelentes',
    torzs: 'Szia!',
  }))
  assert.equal(err.code, 'gmail_mezo_nem_tamogatott')
  // The index, so a caller with ten recipients can find the one that broke,
  // without the value appearing in the message.
  assert.match(err.message, /^cimek\[1\] nem tartalmazhat sortorest$/)
})

test('a line break in the replied-to Message-ID refuses the message too', () => {
  // The Message-ID was written by whoever sent the message being answered, so
  // it is foreign text on exactly the same footing as a subject.
  const err = refused(() => buildMime({
    cimek: ['dorina@example.test'],
    targy: 'Re: kerdes',
    torzs: 'Szia!',
    inReplyTo: '<abc@example.test>\r\nBcc: valaki@masholt.example',
  }))
  assert.equal(err.code, 'gmail_mezo_nem_tamogatott')
  assert.match(err.message, /^valaszUzenetId nem tartalmazhat sortorest$/)
})

test('a reply carries In-Reply-To and References, and a new message carries neither', () => {
  const reply = buildMime({ cimek: ['dorina@example.test'], targy: 'Re: kerdes', torzs: 'Szia!', inReplyTo: '<abc@example.test>' })
  assert.deepEqual(headerNamed(reply, 'In-Reply-To'), ['<abc@example.test>'])
  assert.deepEqual(headerNamed(reply, 'References'), ['<abc@example.test>'])

  const fresh = buildMime({ cimek: ['dorina@example.test'], targy: 'Havi jelentes', torzs: 'Szia!' })
  assert.deepEqual(headerNamed(fresh, 'In-Reply-To'), [])
  assert.deepEqual(headerNamed(fresh, 'References'), [])
  // Explicitly absent, not explicitly null.
  const alsoFresh = buildMime({ cimek: ['dorina@example.test'], targy: 'Havi jelentes', torzs: 'Szia!', inReplyTo: null })
  assert.deepEqual(headerNamed(alsoFresh, 'In-Reply-To'), [])
})

test('a Message-ID with no angle brackets gets them, and one that has them keeps exactly those', () => {
  const wrapped = buildMime({ cimek: ['a@b.test'], targy: 'Re: x', torzs: 'y', inReplyTo: 'abc@example.test' })
  assert.deepEqual(headerNamed(wrapped, 'In-Reply-To'), ['<abc@example.test>'])
  const kept = buildMime({ cimek: ['a@b.test'], targy: 'Re: x', torzs: 'y', inReplyTo: '<abc@example.test>' })
  assert.deepEqual(headerNamed(kept, 'In-Reply-To'), ['<abc@example.test>'])
})

test('the message carries every recipient it was given and no header this module refuses to write', () => {
  const mime = buildMime({ cimek: ['a@example.test', 'b@example.test'], targy: 'Havi jelentes', torzs: 'Szia!' })
  assert.deepEqual(headerNamed(mime, 'To'), ['a@example.test, b@example.test'])
  assert.deepEqual(headerNamed(mime, 'MIME-Version'), ['1.0'])
  assert.deepEqual(headerNamed(mime, 'Content-Type'), ['text/plain; charset=UTF-8'])
  assert.deepEqual(headerNamed(mime, 'Content-Transfer-Encoding'), ['base64'])
  // From is Gmail's to fill from the authenticated account; Cc and Bcc would be
  // a second place a recipient could come from, and there is exactly one.
  for (const name of ['From', 'Cc', 'Bcc', 'Reply-To', 'Message-ID']) {
    assert.deepEqual(headerNamed(mime, name), [], `${name} must not be written here`)
  }
})

test('the body survives the encoding, accents, newlines and all, and its lines are wrapped', () => {
  const torzs = 'Kedves Dorina!\n\nÁrvíztűrő tükörfúrógép. '.repeat(20)
  const mime = buildMime({ cimek: ['dorina@example.test'], targy: 'Havi jelentes', torzs })
  assert.equal(body(mime), torzs)
  for (const line of mime.split('\r\n\r\n').slice(1).join('\r\n\r\n').split('\r\n')) {
    assert.ok(line.length <= 76, `a base64 line is ${line.length} characters`)
  }
})

test('a message with no recipient is refused rather than built', () => {
  // A message with no To header goes nowhere, and reporting it as created would
  // be a false answer in the direction that is hardest to notice.
  assert.equal(refused(() => buildMime({ cimek: [], targy: 'x', torzs: 'y' })).code, 'gmail_cimzett_hianyzik')
  assert.equal(refused(() => buildMime({ cimek: undefined, targy: 'x', torzs: 'y' })).code, 'gmail_argumentum_alak')
  // A comma-separated string is refused rather than wrapped: iterating it would
  // address one recipient per letter.
  assert.match(refused(() => buildMime({ cimek: 'a@b.test,c@d.test', targy: 'x', torzs: 'y' })).message, /tomb kell legyen/)
})

test('a subject or a body of the wrong shape is refused by name, never coerced', () => {
  assert.match(refused(() => buildMime({ cimek: ['a@b.test'], targy: 42, torzs: 'y' })).message, /^targy szoveg kell legyen, nem number$/)
  assert.match(refused(() => buildMime({ cimek: ['a@b.test'], targy: 'x', torzs: undefined })).message, /^torzs kotelezo$/)
  assert.match(refused(() => buildMime({ cimek: ['a@b.test'], targy: '   ', torzs: 'y' })).message, /^targy nem lehet ures$/)
  assert.match(refused(() => buildMime({ cimek: [7], targy: 'x', torzs: 'y' })).message, /^cimek\[0\] szoveg kell legyen, nem number$/)
})

test('base64url encodes what Gmail raw wants, and a non-string is a bug rather than a refusal', () => {
  assert.equal(base64url('Szia!'), 'U3ppYSE')
  // base64url, not base64: no padding, and - and _ for + and /.
  const encoded = base64url('Árvíztűrő ~~~??>>>')
  assert.equal(/[+/=]/.test(encoded), false)
  assert.equal(Buffer.from(encoded, 'base64url').toString('utf8'), 'Árvíztűrő ~~~??>>>')

  const mime = buildMime({ cimek: ['a@b.test'], targy: 'x', torzs: 'y' })
  assert.equal(Buffer.from(base64url(mime), 'base64url').toString('utf8'), mime)

  // Not a GmailError: a caller handing this a number has a bug at the call
  // site, and `guard` deliberately lets a bug propagate rather than dressing it
  // as a refusal an agent would read as a designed answer.
  assert.throws(() => base64url(7), TypeError)
})

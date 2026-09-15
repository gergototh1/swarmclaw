import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/*
 * A szerver leállás közben omlott össze.
 *
 * ÉLES NAPLÓ (`logs/server.log`, 2026-09-10):
 *
 *   TypeError: The database connection is not open
 *       at Timeout._onTimeout (.next/server/chunks/_0wq1187._.js:325:10137)
 *   ⨯ uncaughtException: TypeError: The database connection is not open
 *   [swarmclaw] server exited code=1
 *
 * A SIGTERM-kezelő AZONNAL lezárta az adatbázist, a folyamat viszont még élt --
 * a Next.js maga is „shutting down gracefully" üzenettel jelzi, hogy még
 * dolgozik. Minden időzítő, ami ebben az ablakban tüzelt (hozzáférés-számláló
 * léptetés, ütemező-tick, konszolidáció), egy már bezárt adatbázishoz nyúlt, és
 * mivel ezek nem a kérés-útvonalon futnak, senki nem kapta el őket: elkapatlan
 * kivétel, `exit 1`.
 *
 * A sérülés ellen a WAL-checkpoint véd, nem a `close()`. A checkpoint tehát
 * marad a SIGTERM-en, a lezárás viszont az `exit` eseményre kerül -- oda, ahol
 * az eseményhurok már üres és időzítő nem futhat utána.
 *
 * Forrás-szintű őrszem: a modul szinten futó jelkezelőt és a process-szintű
 * eseményeket kimockolni itt aránytalan lenne. Annyit bizonyít, hogy a régi
 * sorrend nem jön vissza észrevétlenül.
 */
describe('storage shutdown ordering', () => {
  const src = readFileSync(new URL('./storage.ts', import.meta.url), 'utf8')

  it('checkpoints the WAL on SIGTERM', () => {
    assert.match(src, /wal_checkpoint\(TRUNCATE\)/)
    assert.match(src, /process\.on\('SIGTERM'/)
  })

  it('closes the database on exit', () => {
    const exitHandler = /process\.on\('exit', (\w+)\)/.exec(src)?.[1]
    assert.ok(exitHandler, 'the database must be closed on exit')
    const body = new RegExp(`const ${exitHandler} = \\(\\) => \\{[\\s\\S]*?\\n  \\}`).exec(src)?.[0] || ''
    assert.match(body, /db\.close\(\)/, 'the exit handler is the one that closes')
  })

  it('does not close the database straight from a signal handler', () => {
    // A jelkezelőkre kötött függvény csak checkpointolhat: a SIGTERM akkor
    // érkezik, amikor a folyamat még dolgozik.
    const signalHandlers = [...src.matchAll(/process\.on\('SIG\w+', (\w+)\)/g)].map((m) => m[1])
    assert.ok(signalHandlers.length >= 2, 'SIGTERM and SIGINT must still be handled')
    for (const name of signalHandlers) {
      const body = new RegExp(`const ${name} = \\(\\) => \\{[\\s\\S]*?\\n  \\}`).exec(src)?.[0] || ''
      assert.ok(body, `${name} should be a local function`)
      assert.doesNotMatch(body, /db\.close\(\)/, `${name} closing the database is what crashed the server mid-shutdown`)
    }
  })

  it('closes at most once, however many signals arrive', () => {
    // SIGTERM majd SIGINT, vagy két SIGTERM: a második `close()` dobna.
    assert.match(src, /databaseClosed/)
  })
})

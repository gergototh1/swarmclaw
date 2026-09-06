import crypto from 'node:crypto'

/**
 * Egy sor azonosítója: rövid előtag, aláhúzás, 16 hex jegy.
 *
 * Az előtag nem díszítés: egy `acc_…` és egy `deal_…` a naplóban és a
 * feladatok `customFields`-ében is első ránézésre elárulja, mire mutat, és
 * egy rossz helyre másolt id azonnal látszik ahelyett, hogy némán nem
 * találna semmit.
 */
export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`
}

/** Amit a lap a saját rpc-jétől kérhet. A metódusnevek a src/rpc.mjs kulcsai. */
export type Rpc = (method: string, args?: Record<string, unknown>) => Promise<unknown>

/** Egy rpc-hívó a lap extension-idjére kötve. */
export function makeRpc(extensionId: string): Rpc {
  return async (method, args = {}) => {
    const res = await fetch(`/api/extensions/${extensionId}/call/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(errorText(body) || `crm: ${method} — HTTP ${res.status}`)
    return body
  }
}

/**
 * A hibaszöveg a válaszból, vagy üres. Egy nevesített hiba többet ér egy
 * státuszkódnál.
 *
 * A host rpc route-ja (`src/app/api/extensions/[id]/call/[method]/route.ts`,
 * `rpcFailure`) `{ error: { code, message }, message }` alakban válaszol: az
 * `error` mező objektum, nem string, a szöveg pedig a felső szintű `message`
 * mezőn is elérhető. Ezért mindkét alakot kezelni kell -- egy string `error`
 * (néhány hívó ezt adja) és az objektum alak, a felső szintű `message`-re
 * visszaesve, különben minden névre szóló hiba eltűnik és a böngésző csak a
 * HTTP státuszkódot látja.
 */
export function errorText(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const rec = body as Record<string, unknown>
  if (typeof rec.error === 'string' && rec.error) return rec.error
  if (rec.error && typeof rec.error === 'object') {
    const errRec = rec.error as Record<string, unknown>
    if (typeof errRec.message === 'string' && errRec.message) return errRec.message
  }
  return typeof rec.message === 'string' ? rec.message : ''
}

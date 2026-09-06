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

/** A hibaszöveg a válaszból, vagy üres. Egy nevesített hiba többet ér egy státuszkódnál. */
export function errorText(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const rec = body as Record<string, unknown>
  return typeof rec.error === 'string' ? rec.error : ''
}

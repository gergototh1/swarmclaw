/**
 * What the page sends to and receives from `rpc.mjs`, typed on this side.
 *
 * The request rows are the ones `db.mjs` stores and `rpc.kerelmek` hands on
 * unchanged. Every `szoveg` below was written by whoever asked for the
 * narration -- an agent through the shim, another extension through the
 * contract, or the operator through the import -- and the data layer leaves
 * that text byte for byte on purpose so that the decision about display is
 * made where the text is displayed. That is here: the list renders `szoveg`
 * and `fajl` as React text children and nothing else.
 *
 * `readHealth`, `readMcpConfig` and `readKerelmek` check the shape of what
 * came back before a component sees it. A response missing the fields the
 * page reads is refused by name rather than drawn as a blank status: a server
 * that answered with nothing and one that could not be asked are different
 * facts, and this page's own server is not exempt from the rule.
 */

export type Rpc = (method: string, body?: object) => Promise<unknown>

export interface Counts {
  kerelmek: number
  kesz: number
  hiba: number
}

export interface Health {
  kulcsBeallitva: boolean
  vegpontBeallitva: boolean
  hangGyoker: string
  maiMasodperc: number
  napiKeret: number
  hang: string
  modell: string
  nyelv: string
  counts: Counts
  portFile: string
  shim: string
}

export interface McpConfig {
  id: string
  name: string
  transport: string
  command: string
  args: string[]
  env: Record<string, string>
}

export interface Kerelem {
  id: string
  modell: string
  hang: string
  nyelv: string
  szoveg: string
  fajl: string
  hossz_ms: number
  bajt: number
  status: string
  hiba_kod: string
  kerte: string
  created_at: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuse(method: string, field: string): never {
  throw new Error(`a(z) ${method} válasz hiányos: nincs használható "${field}" mező`)
}

function readNumber(method: string, record: Record<string, unknown>, field: string): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) refuse(method, field)
  return value
}

function readString(method: string, record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') refuse(method, field)
  return value
}

function readBoolean(method: string, record: Record<string, unknown>, field: string): boolean {
  const value = record[field]
  if (typeof value !== 'boolean') refuse(method, field)
  return value
}

/** The `health` response, or a thrown error naming the first field it lacks. */
export function readHealth(raw: unknown): Health {
  if (!isRecord(raw)) refuse('health', 'health')
  const counts = raw.counts
  if (!isRecord(counts)) refuse('health', 'counts')
  return {
    kulcsBeallitva: readBoolean('health', raw, 'kulcsBeallitva'),
    vegpontBeallitva: readBoolean('health', raw, 'vegpontBeallitva'),
    hangGyoker: readString('health', raw, 'hangGyoker'),
    maiMasodperc: readNumber('health', raw, 'maiMasodperc'),
    napiKeret: readNumber('health', raw, 'napiKeret'),
    hang: readString('health', raw, 'hang'),
    modell: readString('health', raw, 'modell'),
    nyelv: readString('health', raw, 'nyelv'),
    counts: {
      kerelmek: readNumber('health', counts, 'kerelmek'),
      kesz: readNumber('health', counts, 'kesz'),
      hiba: readNumber('health', counts, 'hiba'),
    },
    portFile: readString('health', raw, 'portFile'),
    shim: readString('health', raw, 'shim'),
  }
}

/** The `mcpConfig` response, or a thrown error naming the field it lacks. Shown as text, so every value has to be one. */
export function readMcpConfig(raw: unknown): McpConfig {
  if (!isRecord(raw)) refuse('mcpConfig', 'mcpConfig')
  const args = raw.args
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) refuse('mcpConfig', 'args')
  const env = raw.env
  if (!isRecord(env) || !Object.values(env).every((v) => typeof v === 'string')) refuse('mcpConfig', 'env')
  return {
    id: readString('mcpConfig', raw, 'id'),
    name: readString('mcpConfig', raw, 'name'),
    transport: readString('mcpConfig', raw, 'transport'),
    command: readString('mcpConfig', raw, 'command'),
    args: args as string[],
    env: env as Record<string, string>,
  }
}

/**
 * The `kerelmek` response: a list, or a thrown error. Rows inside are not
 * walked: they are whatever `db.mjs` selected, and a missing column there is
 * a rendering question (the formatters print a marker for a value that is not
 * the shape they expect) rather than a reason to refuse the list.
 */
export function readKerelmek(raw: unknown): Kerelem[] {
  if (!Array.isArray(raw)) refuse('kerelmek', 'kerelmek')
  return raw as Kerelem[]
}

/** The text of a failure, whatever the rpc layer threw. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

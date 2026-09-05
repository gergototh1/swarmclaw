/**
 * What the page sends to and receives from `src/rpc.mjs`, typed on this side.
 *
 * WHAT IS IN THESE ROWS. A video's `cim` and `forrasSzoveg` are a newsletter
 * item or a stranger's forum post, carried through `videoOpen` byte for byte;
 * a scene's props and a narration sentence are what an agent wrote from that
 * text; a verdict's `szoveg` is what the reviewing agent wrote about it; a
 * proposal's `cim` and `szoveg` are the daily review's own prose; a feedback
 * note is the operator's, and an imported one came out of their analytics
 * export. Every layer below leaves all of it alone on purpose, so that the
 * decision about display is made where the text is displayed. That is here:
 * every component in this directory renders those fields as React text
 * children, and the single url that reaches an `href` goes through
 * `safeHref`.
 *
 * WHY THE READERS REFUSE. `readBoard`, `readVideo`, `readProposals`,
 * `readTemplates` and `readHealth` check the shape of what came back before a
 * component sees it, and a response missing a list this page reads is refused
 * by name rather than drawn as an empty board. That is the same rule
 * `health.mjs` and `managed-state.ts` are built on: a question answered with
 * nothing and a question that could not be put are different facts, and this
 * page's own server is no more exempt from it than Gmail or the catalogue.
 *
 * The readers check only what the page reads, and they do not walk into the
 * rows: a row is whatever `db.mjs` selected, and a field this page can render
 * as a placeholder is a rendering question rather than a reason to refuse the
 * whole load.
 */

export type Rpc = (method: string, body?: object) => Promise<unknown>

/** One scene's span on a finished render, as `render.mjs` stored it. Re-exported so the timeline's callers need one import. */
export type { Hatar } from './idovonal-state'

/** A QA measurement failure, with the original's own fact name beside the threshold it missed (`qa.mjs`). */
export interface QaBukas {
  kod: string
  nev: string
  mert: unknown
  kuszob: unknown
}

/** What `renderOps.summary` says about one render row. */
export interface RenderSummary {
  renderId: string
  videoId: string
  status: string
  outPath: string | null
  logPath: string | null
  fileSha256: string | null
  qa: { ok: boolean; meresek: Record<string, unknown>; bukasok: QaBukas[] } | null
  hiba: { kod: string; szoveg: string | null } | null
  elteltMs: number
  /**
   * The row says `fut` but the host that started it is gone, so `elteltMs` is
   * measured from a boot this process never saw and means nothing. The page
   * says so in words instead of printing the number.
   */
  hostUjraindult: boolean
  startedAt: string
  finishedAt: string | null
}

/** A render as the `video` response carries it: the summary plus what only the detail view needs. */
export interface RenderRow extends RenderSummary {
  tervId: string
  jelenetHatarok: Array<{ jelenet: number; kezdetMs: number; vegMs: number }>
  propsPath: string | null
  torolveAt: string | null
}

export interface Verdikt {
  id: string
  verdikt: string
  tervHash: string
  lektorAgentId: string
  talalatok: Array<{ jelenet: number; kod: string; szoveg: string }>
  at: string
}

export interface Narracio {
  jelenet: number
  fajl: string
  hosszMs: number
  hang: string
  modell: string
  nyelv: string
  tervHash: string
  szovegHash: string
}

export interface Terv {
  id: string
  verzio: number
  /** The scene list as the producing agent wrote it: one object per scene, `tipus` plus that type's own props. */
  jelenetek: unknown[]
  narracio: Array<{ jelenet: number; szoveg: string }>
  assetUjjlenyomatok: unknown
  tervHash: string
  katalogusHash: string
  szerzoAgentId: string
  ellenorzes: unknown
  createdAt: string
  verdiktek: Verdikt[]
  narraciok: Narracio[]
}

export interface Visszajelzes {
  id: string
  renderId: string | null
  atMs: number | null
  jelenet: number | null
  szoveg: string
  forras: string
  at: string
}

export interface MegtartasPont {
  platform: string
  tS: number
  arany: number
}

/** One card in a Sor column: enough to decide which video to open, and nothing more. */
export interface BoardCard {
  id: string
  cim: string
  status: string
  forrasTipus: string
  forrasId: string | null
  createdAt: string
  tervVerzio: number | null
  tervId: string | null
  utolsoVerdikt: { id: string; verdikt: string; talalatok: number; at: string } | null
  render: RenderSummary | null
  qa: { ok: boolean; bukasok: string[] } | null
}

export interface Sapka {
  db: number
  sapka: number
}

/** The 6.4 caps as `rpc.mjs` counts them now; `decideProposal` enforces the same three numbers. */
export interface Sapkak {
  nyitottJavaslat: Sapka
  tanulsag: Record<string, Sapka>
  backlog: { szabaly: Sapka; sablon: Sapka }
}

export interface Counts {
  videos: number
  tervek: number
  renderek: number
  qaOk: number
  nyitottJavaslatok: number
  fordulok: number
}

export interface Fordulo {
  agentId: string
  forras: string
  at: string
}

export interface Board {
  /** Keyed by every status in `VIDEO_STATUSOK`, empty columns included, so the board draws the same shape on an empty install. */
  oszlopok: Record<string, BoardCard[]>
  statusok: string[]
  futoRender: RenderSummary | null
  sapkak: Sapkak
  counts: Counts
  utolsoFordulok: Fordulo[]
  utolsoFordulokLimit: number
}

export interface VideoDetail {
  id: string
  cim: string
  status: string
  forrasTipus: string
  forrasId: string | null
  /** The source, as it arrived. Rendered inside a box the page labels as a stranger's text; never parsed here. */
  forrasSzoveg: string
  nyitottaAgentId: string
  createdAt: string
  lezarvaAt: string | null
  tervek: Terv[]
  renderek: RenderRow[]
  visszajelzesek: Visszajelzes[]
  megtartas: MegtartasPont[]
}

export interface Proposal {
  id: string
  cel: string
  fajta: string
  cim: string
  szoveg: string
  /** The ids the review cited. Whatever was stored: the page shows each as text and links only the ones the board knows as videos. */
  bizonyitek: unknown
  status: string
  dontesMegjegyzes: string | null
  createdAt: string
  decidedAt: string | null
}

export interface Tanulsag {
  id: string
  javaslatId: string
  szoveg: string
  createdAt: string
}

export interface TanulsagCel {
  db: number
  sapka: number
  tetelek: Tanulsag[]
}

export interface Proposals {
  nyitott: Proposal[]
  backlog: Proposal[]
  tanulsagok: Record<string, TanulsagCel>
  elutasitott: Proposal[]
  kodolva: Proposal[]
  sapkak: Sapkak
  /** The catalogue refusal code, or null. A `sablon` proposal cannot be matched against a catalogue that could not be read. */
  katalogusHiba: string | null
}

export interface SablonStat {
  hasznalat: number
  lektoriTalalat: Record<string, number>
  /**
   * Not a number. `sablon.mjs` writes the constant `nincs_idokodos_szabaly`
   * here because no QA rule in rule set 1 is scene-scoped, so no QA failure
   * can be attributed to a template. A 0 would read as "this template never
   * failed QA", which nothing has measured.
   */
  qaBukas: string
  visszajelzes: number
  /** The scene's average retention minus the video's, or the word `meretlen` when no retention point falls inside it. */
  megtartas: number | string
}

export interface HetiSor {
  het: string
  renderek: number
  qaBukas: number
  lektoriTalalat: Record<string, number>
}

/** One prop as the catalogue spells it: its name, whether the type requires it, and the catalogue's own sentence about what it is for. */
export interface Prop {
  nev: string
  kotelezo: boolean
  /**
   * Optional, because it is optional at the other end too: `katalogus.mjs`
   * requires a prop to carry `nev` and `kotelezo` and says nothing about
   * `mit`. A required `mit` here would be a guarantee only this file makes
   * -- either a lie, if nothing checks it, or a page that refuses a
   * catalogue its own server accepted and loses every prop list over one
   * missing sentence. The card draws the sentence when the catalogue has
   * one and says nothing when it does not.
   */
  mit?: string
}

export interface Templates {
  /** The catalogue refusal code, or null. With one, every catalogue-derived field below is null rather than an empty one. */
  hiba: string | null
  katalogusHash: string | null
  sablonStat: Record<string, SablonStat> | null
  hetiSor: HetiSor[]
  /**
   * The kit's vocabulary, as the catalogue carries it. Every one of these is
   * null when the catalogue could not be read, and null again when the field
   * came back in a shape this page cannot draw -- an empty list here would
   * read as a fact about the kit ("no templates", "nothing is sendable")
   * instead of a fact about the answer.
   */
  tipusok: string[] | null
  leirasok: Record<string, string> | null
  propok: Record<string, Prop[]> | null
  kozosPropok: Prop[] | null
  /** The types a plan may send as JSON, and the ones the kit takes only from React. Both come from the module's table, not from the catalogue file. */
  kuldhetoTipusok: string[] | null
  nemKuldhetoTipusok: string[] | null
  /** Types the catalogue lists without a sample: the card says so rather than showing an empty frame. */
  mintaHianyzik: string[] | null
  /** Types and props the catalogue has and the kit table does not (`katalogus_valtozott`). */
  tablaHianyok: string[] | null
}

/**
 * The three gallery methods answer with TWO error fields and the page must
 * honour both, because they are two different facts.
 *
 * `hiba` is "the other repository could not be read", carrying the same codes
 * and the same field name `templates` uses. `ok` is the method's OWN
 * vocabulary -- `mar_fut`, `nincs_kep`, `nincs_minta`, `tipus_ismeretlen` --
 * and is ABSENT on success, which is why every reader below turns a missing
 * `ok` into `null` rather than testing it for falsiness. Folding the two
 * together would give a broken connection the shape of a run that is going
 * fine.
 */
export interface TemplatePreview {
  /** A `data:image/png;base64,` url, or null. Anything else is not a picture and is not put in a `src`. */
  dataUrl: string | null
  ok: string | null
  hiba: string | null
}

/** One type's failure inside a run, as `elonezet.mjs` recorded it: a code, and the process's exit code when there was one. */
export interface PreviewHiba {
  kod: string
  kilepesiKod?: number
  jel?: string
}

/** A generation in flight. It lives in the module, not in the project, so it is answered even beside a refusal code. */
export interface PreviewFutas {
  katalogusHash: string
  /** How many pictures this run set out to make -- the missing ones at the moment it started, not the size of the kit. */
  osszes: number
  kesz: string[]
  hibak: Record<string, PreviewHiba>
  megszakitva: boolean
  indultAt: string
}

export interface PreviewStatus {
  hiba: string | null
  katalogusHash: string | null
  /**
   * Null beside a refusal code, never an empty list, for the reason
   * `templates` gives at length: `hianyzo: []` would draw as "the gallery is
   * complete" over a project nobody could read.
   */
  katalogusTipusok: string[] | null
  meglevo: string[] | null
  hianyzo: string[] | null
  mintaNelkul: string[] | null
  fut: PreviewFutas | null
}

export interface PreviewStart {
  indult: boolean
  ok: string | null
  hiba: string | null
}

/**
 * The one gate between an rpc string and an `<img src>`.
 *
 * `safe-href.ts` guards `href` and refuses `data:` outright; this is the
 * other direction and the narrower rule. `elonezet.mjs` builds exactly one
 * kind of string here -- a base64 PNG it read off its own cache directory --
 * so that prefix is the whole allowed set, and anything else (an svg with a
 * script in it, a `javascript:` url, a bare path) is drawn as no picture at
 * all rather than handed to the browser to interpret.
 */
const KEP_ELOTAG = 'data:image/png;base64,'

export function readTemplatePreview(raw: unknown): TemplatePreview {
  const root = readRoot('templatePreview', raw)
  const dataUrl = root.dataUrl
  const kep = typeof dataUrl === 'string' && dataUrl.startsWith(KEP_ELOTAG)
  const ok = typeof root.ok === 'string' ? root.ok : null
  return {
    dataUrl: kep ? (dataUrl as string) : null,
    // A string that is not a PNG data url is a REFUSED picture, not an
    // absent one, and `nem_kep` says so: the card would otherwise print
    // "nincs kép" over a server that did send something, and nobody would
    // know to look at what it sent.
    ok: ok !== null ? ok : (!kep && typeof dataUrl === 'string' ? 'nem_kep' : null),
    hiba: typeof root.hiba === 'string' ? root.hiba : null,
  }
}

/** A run, or null. A run reported in a shape this page cannot draw is null too: the progress line prints numbers and cannot invent either half. */
function futasOrNull(value: unknown): PreviewFutas | null {
  if (!isRecord(value)) return null
  const kesz = stringsOrNull(value.kesz)
  if (kesz === null || typeof value.osszes !== 'number' || !isRecord(value.hibak)) return null
  const hibak: Record<string, PreviewHiba> = {}
  for (const [tipus, hiba] of Object.entries(value.hibak)) {
    if (isRecord(hiba) && typeof hiba.kod === 'string') hibak[tipus] = hiba as unknown as PreviewHiba
  }
  return {
    katalogusHash: typeof value.katalogusHash === 'string' ? value.katalogusHash : '',
    osszes: value.osszes,
    kesz,
    hibak,
    megszakitva: value.megszakitva === true,
    indultAt: typeof value.indultAt === 'string' ? value.indultAt : '',
  }
}

export function readPreviewStatus(raw: unknown): PreviewStatus {
  const root = readRoot('templatePreviewStatus', raw)
  return {
    hiba: typeof root.hiba === 'string' ? root.hiba : null,
    katalogusHash: typeof root.katalogusHash === 'string' ? root.katalogusHash : null,
    katalogusTipusok: stringsOrNull(root.katalogusTipusok),
    meglevo: stringsOrNull(root.meglevo),
    hianyzo: stringsOrNull(root.hianyzo),
    mintaNelkul: stringsOrNull(root.mintaNelkul),
    fut: futasOrNull(root.fut),
  }
}

export function readPreviewStart(raw: unknown): PreviewStart {
  const root = readRoot('templatePreviewStart', raw)
  return {
    indult: root.indult === true,
    ok: typeof root.ok === 'string' ? root.ok : null,
    hiba: typeof root.hiba === 'string' ? root.hiba : null,
  }
}

export interface Health {
  ok: boolean
  /** Codes that block a capability. */
  hibak: string[]
  /** Codes that limit the module without blocking anything. Never folded into `hibak`. */
  figyelmeztetesek: string[]
  blokkolt: string[]
  /** Codes `runHealth` structurally cannot answer. Their absence from `hibak` is not a pass, and the page says which. */
  nemValaszolt: string[]
  remotion: { beallitva: boolean; letezik: boolean; hianyzoFajlok: string[] }
  eszkozok: Record<string, boolean>
  chrome: { konyvtar: boolean; megjegyzes: string }
  platform: string
  linuxRenderEngedely: boolean
  /** The host's own reason per contract, verbatim (`provider_missing`, `provider_disabled`, `not_declared`, `version_mismatch`), or null. */
  szerzodesek: { tts: string | null; signals: string | null }
  futoRender: RenderSummary | null
  /** Files under the module's two namespaces that no row names, or null for "not counted" -- never 0. */
  sorNelkul: number | null
  counts: Counts
  forduloRogzites: string
  sapkak: { nyitottJavaslat: number; tanulsagCelonkent: number; backlog: number }
}

export interface CleanupResult {
  torolt: number
  meghagyott: number
  hibak: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuse(method: string, field: string): never {
  throw new Error(`a ${method} válaszából hiányzik a ${field} mező`)
}

function readArray<T>(method: string, record: Record<string, unknown>, field: string): T[] {
  const value = record[field]
  if (!Array.isArray(value)) refuse(method, field)
  return value as T[]
}

function readRecordField(method: string, record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field]
  if (!isRecord(value)) refuse(method, field)
  return value
}

function readRoot(method: string, raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) refuse(method, method)
  return raw
}

/**
 * The `board` response, or a thrown error naming the first field it lacks.
 *
 * `oszlopok` and `statusok` are both required and neither is derived from the
 * other: `statusok` is the order the columns are drawn in and `oszlopok` is
 * total over it, and a page that invented one from the other would silently
 * hide a column the server has rows for.
 */
export function readBoard(raw: unknown): Board {
  const root = readRoot('board', raw)
  const oszlopok = readRecordField('board', root, 'oszlopok')
  const statusok = readArray<string>('board', root, 'statusok')
  const sapkak = readSapkak('board', root)
  const counts = readRecordField('board', root, 'counts') as unknown as Counts
  return {
    oszlopok: oszlopok as unknown as Record<string, BoardCard[]>,
    statusok,
    futoRender: (root.futoRender ?? null) as RenderSummary | null,
    sapkak,
    counts,
    utolsoFordulok: readArray<Fordulo>('board', root, 'utolsoFordulok'),
    utolsoFordulokLimit: typeof root.utolsoFordulokLimit === 'number' ? root.utolsoFordulokLimit : refuse('board', 'utolsoFordulokLimit'),
  }
}

/** The three caps, refused by name when the response does not carry them: the page prints "9/12" and cannot invent either half. */
function readSapkak(method: string, root: Record<string, unknown>): Sapkak {
  const sapkak = readRecordField(method, root, 'sapkak')
  const nyitott = readRecordField(method, sapkak, 'nyitottJavaslat')
  const tanulsag = readRecordField(method, sapkak, 'tanulsag')
  const backlog = readRecordField(method, sapkak, 'backlog')
  return {
    nyitottJavaslat: nyitott as unknown as Sapka,
    tanulsag: tanulsag as unknown as Record<string, Sapka>,
    backlog: backlog as unknown as { szabaly: Sapka; sablon: Sapka },
  }
}

/** The `video` response. `tervek` and `renderek` are the two lists every panel below reads. */
export function readVideo(raw: unknown): VideoDetail {
  const root = readRoot('video', raw)
  if (typeof root.id !== 'string') refuse('video', 'id')
  if (typeof root.forrasSzoveg !== 'string') refuse('video', 'forrasSzoveg')
  return {
    id: root.id,
    cim: typeof root.cim === 'string' ? root.cim : '',
    status: typeof root.status === 'string' ? root.status : '',
    forrasTipus: typeof root.forrasTipus === 'string' ? root.forrasTipus : '',
    forrasId: typeof root.forrasId === 'string' ? root.forrasId : null,
    forrasSzoveg: root.forrasSzoveg,
    nyitottaAgentId: typeof root.nyitottaAgentId === 'string' ? root.nyitottaAgentId : '',
    createdAt: typeof root.createdAt === 'string' ? root.createdAt : '',
    lezarvaAt: typeof root.lezarvaAt === 'string' ? root.lezarvaAt : null,
    tervek: readArray<Terv>('video', root, 'tervek'),
    renderek: readArray<RenderRow>('video', root, 'renderek'),
    visszajelzesek: readArray<Visszajelzes>('video', root, 'visszajelzesek'),
    megtartas: readArray<MegtartasPont>('video', root, 'megtartas'),
  }
}

/** The `proposals` response. `katalogusHiba` is carried through as the code it is, and shown as that code. */
export function readProposals(raw: unknown): Proposals {
  const root = readRoot('proposals', raw)
  return {
    nyitott: readArray<Proposal>('proposals', root, 'nyitott'),
    backlog: readArray<Proposal>('proposals', root, 'backlog'),
    tanulsagok: readRecordField('proposals', root, 'tanulsagok') as unknown as Record<string, TanulsagCel>,
    elutasitott: readArray<Proposal>('proposals', root, 'elutasitott'),
    kodolva: readArray<Proposal>('proposals', root, 'kodolva'),
    sapkak: readSapkak('proposals', root),
    katalogusHiba: typeof root.katalogusHiba === 'string' ? root.katalogusHiba : null,
  }
}

/** A list of strings, or null. Anything else is a field the gallery leaves out, not a load the page refuses. */
function stringsOrNull(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null
}

/** A record of strings, or null, on the same terms: one non-string value and the field is not the record this page would draw. */
function stringRecordOrNull(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  return Object.values(value).every((v) => typeof v === 'string') ? (value as Record<string, string>) : null
}

/**
 * The two fields the gallery walks INTO, checked to the depth it walks.
 *
 * `stringsOrNull` element-checks for the same reason: a cast is not a check,
 * and a `propok` entry that arrived as a string would survive one only to
 * throw inside the render, where it costs the page `sablonStat` and
 * `hetiSor` as well -- the whole point of degrading these fields one by one.
 * One unreadable entry nulls the whole field rather than half of it: a prop
 * table missing a type without saying so is a false statement about the kit,
 * and the page already has a word for a field it could not read.
 */
function isProp(value: unknown): value is Prop {
  return isRecord(value) && typeof value.nev === 'string' && typeof value.kotelezo === 'boolean'
}

function propsOrNull(value: unknown): Prop[] | null {
  return Array.isArray(value) && value.every(isProp) ? value : null
}

function propRecordOrNull(value: unknown): Record<string, Prop[]> | null {
  if (!isRecord(value)) return null
  const entries: Array<[string, Prop[]]> = []
  for (const [tipus, lista] of Object.entries(value)) {
    const propok = propsOrNull(lista)
    if (propok === null) return null
    entries.push([tipus, propok])
  }
  return Object.fromEntries(entries)
}

/**
 * The `templates` response. `sablonStat` is allowed to be null and that is
 * not a missing field: it is what the server sends when the catalogue could
 * not be read, and the page draws the refusal code instead of a table.
 *
 * The catalogue fields degrade ONE BY ONE. `sablonStat` and `hetiSor` come
 * from stored rows and stand on their own, so a `propok` that arrived in a
 * shape this page cannot draw costs the gallery its prop lists and nothing
 * else -- refusing the whole response there would take the numbers away too,
 * over a field they do not depend on. A field that did not survive the check
 * is null, which the page already knows how to say: the same word it says
 * when the Remotion project could not be read at all.
 */
export function readTemplates(raw: unknown): Templates {
  const root = readRoot('templates', raw)
  const stat = root.sablonStat
  if (stat !== null && !isRecord(stat)) refuse('templates', 'sablonStat')
  return {
    hiba: typeof root.hiba === 'string' ? root.hiba : null,
    katalogusHash: typeof root.katalogusHash === 'string' ? root.katalogusHash : null,
    sablonStat: stat === null ? null : (stat as unknown as Record<string, SablonStat>),
    hetiSor: readArray<HetiSor>('templates', root, 'hetiSor'),
    tipusok: stringsOrNull(root.tipusok),
    leirasok: stringRecordOrNull(root.leirasok),
    propok: propRecordOrNull(root.propok),
    kozosPropok: propsOrNull(root.kozosPropok),
    kuldhetoTipusok: stringsOrNull(root.kuldhetoTipusok),
    nemKuldhetoTipusok: stringsOrNull(root.nemKuldhetoTipusok),
    mintaHianyzik: stringsOrNull(root.mintaHianyzik),
    tablaHianyok: stringsOrNull(root.tablaHianyok),
  }
}

/**
 * The `health` response, or a thrown error naming the first list it lacks.
 *
 * The four lists are all required because the status bar keeps them apart:
 * `hibak` blocks, `figyelmeztetesek` limits, `blokkolt` names what is stopped
 * and `nemValaszolt` names what was not checked at all. A missing one would
 * be drawn as an empty one, and an empty `nemValaszolt` reads as "everything
 * was checked" -- exactly the false report `health.mjs` separated them to
 * avoid.
 */
export function readHealth(raw: unknown): Health {
  const root = readRoot('health', raw)
  if (typeof root.ok !== 'boolean') refuse('health', 'ok')
  const remotion = readRecordField('health', root, 'remotion')
  const chrome = readRecordField('health', root, 'chrome')
  const szerzodesek = readRecordField('health', root, 'szerzodesek')
  return {
    ok: root.ok,
    hibak: readArray<string>('health', root, 'hibak'),
    figyelmeztetesek: readArray<string>('health', root, 'figyelmeztetesek'),
    blokkolt: readArray<string>('health', root, 'blokkolt'),
    nemValaszolt: readArray<string>('health', root, 'nemValaszolt'),
    remotion: {
      beallitva: remotion.beallitva === true,
      letezik: remotion.letezik === true,
      hianyzoFajlok: Array.isArray(remotion.hianyzoFajlok) ? (remotion.hianyzoFajlok as string[]) : [],
    },
    eszkozok: readRecordField('health', root, 'eszkozok') as unknown as Record<string, boolean>,
    chrome: {
      konyvtar: chrome.konyvtar === true,
      megjegyzes: typeof chrome.megjegyzes === 'string' ? chrome.megjegyzes : '',
    },
    platform: typeof root.platform === 'string' ? root.platform : refuse('health', 'platform'),
    linuxRenderEngedely: root.linuxRenderEngedely === true,
    szerzodesek: {
      tts: typeof szerzodesek.tts === 'string' ? szerzodesek.tts : null,
      signals: typeof szerzodesek.signals === 'string' ? szerzodesek.signals : null,
    },
    futoRender: (root.futoRender ?? null) as RenderSummary | null,
    sorNelkul: typeof root.sorNelkul === 'number' ? root.sorNelkul : null,
    counts: readRecordField('health', root, 'counts') as unknown as Counts,
    forduloRogzites: typeof root.forduloRogzites === 'string' ? root.forduloRogzites : '',
    sapkak: readRecordField('health', root, 'sapkak') as unknown as { nyitottJavaslat: number; tanulsagCelonkent: number; backlog: number },
  }
}

/** The text of a failure, whatever the rpc layer threw. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Whether the host has the agents and schedules this extension declares.
 *
 * Read off the host's own `GET /api/extensions/managed-resources`, which is
 * what the Extensions list's own reconcile control acts on, rather than off
 * anything this extension's server side could compute: the extension is not
 * handed the host's agent or schedule tables, and `runHealth` says as much by
 * reporting `reconcile_hianyzik` in `nemValaszolt` rather than in `hibak`.
 *
 * Three states, for the same reason `health.mjs` keeps three lists:
 * "scheduled" and "not scheduled" are two different facts, and a check that
 * could not be made is a third and must not be reported as either.
 *
 *   - `ready`: every declared schedule resolves to a stored schedule.
 *   - `unscheduled`: at least one does not. The names are the declared ones,
 *     so the operator can find them on the Extensions screen.
 *   - `unknown`: the summary could not be read; `reason` is the text of the
 *     failure, shown as text.
 */
export type ManagedStatus =
  | { kind: 'ready'; schedules: number }
  | { kind: 'unscheduled'; missing: string[]; total: number }
  | { kind: 'unknown'; reason: string }

/**
 * The host's managed-resources summary, reduced to the one question the
 * status bar asks about `extensionId`. Throws, naming the field, on a shape
 * it cannot read; the loader turns that into `unknown`.
 */
export function readManagedStatus(raw: unknown, extensionId: string): ManagedStatus {
  if (!isRecord(raw)) refuse('managed-resources', 'summary')
  const extensions = readArray<unknown>('managed-resources', raw, 'extensions')
  const entry = extensions.find((candidate) => isRecord(candidate) && candidate.extensionId === extensionId)
  if (!isRecord(entry)) throw new Error(`a host managed-resources listája nem tartalmazza ezt az extensiont (${extensionId})`)
  const schedules = readArray<unknown>('managed-resources', entry, 'schedules')
  const missing: string[] = []
  for (const schedule of schedules) {
    if (!isRecord(schedule)) refuse('managed-resources', 'schedules')
    if (schedule.status === 'resolved') continue
    missing.push(typeof schedule.displayName === 'string' && schedule.displayName !== '' ? schedule.displayName : String(schedule.resourceKey ?? '?'))
  }
  if (schedules.length === 0) throw new Error('a host szerint ez az extension egyetlen ütemezést sem deklarál')
  return missing.length === 0
    ? { kind: 'ready', schedules: schedules.length }
    : { kind: 'unscheduled', missing, total: schedules.length }
}

import { MIGRATIONS, createRepo } from './src/db.mjs'
import { createMcpBridge } from './src/mcp-bridge.mjs'
import { createRpc } from './src/rpc.mjs'
import { createTools } from './src/tools.mjs'

/**
 * Amit a host a setup()-ban átad, plusz a teszt egyetlen varrata.
 *
 * Minden betöltésnél és minden reloadnál újratöltődik -- a setup()-ot a host
 * bármelyik data/extensions alatti íráskor újrahívja -- ezért nincs itt sem
 * timer, sem listener, sem subscription: egy reload betöltésenként egyet
 * szivárogtatna belőlük. A sima értékadás idempotens, tehát a setup()
 * újrafuttatása ingyen van.
 *
 * Nincs itt fetch-varrat, mert a CRM-1 nem megy ki a hálózatra. A CRM-4
 * webhook-oldala és a naptár-olvasás majd felvesz egyet -- akkor, amikor lesz
 * mibe injektálni. Egy most felvett mező olyasmit írna le, amit semmi nem
 * használ, és a rá írt teszt semmit nem állítana a viselkedésről.
 */
export const state = {
  storage: null,
  settings: () => ({}),
  log: console,
  oauth: null,
  repo: null,
}

const crm = {
  name: 'CRM',
  version: '0.1.0',
  description: 'Ügyfelek, leadek, ügyek és idővonal egy helyen. Az emailt, a leiratot és a feladatot mind ügyfélhez köti, és megmondja, mi igényel figyelmet.',
  migrations: MIGRATIONS,
  setup(ctx) {
    state.storage = ctx.storage
    state.settings = ctx.settings
    state.log = ctx.log
    state.oauth = ctx.oauth
    state.repo = createRepo(ctx.storage)
  },
  tools: createTools(state),
  rpc: { ...createRpc(state), ...createMcpBridge(() => crm.tools) },
  managedResources: {
    projects: [{
      projectKey: 'crm',
      displayName: 'CRM',
      description: 'Az ügyfélkezeléshez tartozó feladatok. Az extension hozza létre és viszi el.',
      objective: 'Egy ügyfél se maradjon válasz nélkül, és egy elhangzott ígéret se maradjon feladat nélkül.',
      priorities: [
        'A megígért dolgok határidőre kimennek.',
        'Az aktív ügyek nem esnek némaságba.',
        'Minden levél, leirat és feladat ügyfélhez van kötve.',
      ],
    }],
    setupChecks: [
      { checkKey: 'gmail_extension', displayName: 'Gmail extension telepítve',
        description: 'Enélkül az email-behúzás áll. A CRM-1 nem használja; a CRM-2-től kell.',
        kind: 'manual', required: false },
    ],
  },
  ui: {
    pages: [{
      id: 'crm',
      label: 'CRM',
      // A EXTENSION_PAGE_ICON_NAMES listájából (src/lib/extension-page-nav.ts).
      // Ami nincs a listán, az némán a puzzle-darab ikont kapja.
      icon: 'Users',
      path: '/x/crm',
      entry: 'dist/index.js',
      css: 'dist/style.css',
      position: 'end',
    }],
    settingsFields: [
      // A három proaktív trigger küszöbe (spec 6.). A CRM-1 még nem olvassa
      // őket -- a figyelem-motor a CRM-3-ban jön --, de itt születnek, hogy az
      // operátor a beállítást ne egy későbbi frissítés után találja meg először.
      { key: 'nemaNapok', label: 'Néma ügy küszöbe (nap)', type: 'number', defaultValue: 9,
        help: 'Ennyi esemény nélküli nap után jelez egy nyitott ügyre.' },
      { key: 'valaszNapok', label: 'Válasz nélküli levél küszöbe (nap)', type: 'number', defaultValue: 3,
        help: 'Ennyi nap után jelez egy bejövő levélre, amire nem ment válasz.' },
      { key: 'igeretNapok', label: 'Saját ígéret küszöbe (nap)', type: 'number', defaultValue: 2,
        help: 'Ennyi nap után jelez egy elhangzott ígéretre, amiből nem lett feladat.' },
      { key: 'idegenIgeretNapok', label: 'Nekem ígért dolog küszöbe (nap)', type: 'number', defaultValue: 7,
        help: 'Lazább, mint a sajátod: egy tőled elvárt és egy neked ígért dolog nem egyforma sürgős.' },
    ],
  },
}

export default crm

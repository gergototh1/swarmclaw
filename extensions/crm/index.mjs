import { MIGRATIONS, createRepo } from './src/db.mjs'

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
  tools: [],
  rpc: {},
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
    settingsFields: [],
  },
}

export default crm

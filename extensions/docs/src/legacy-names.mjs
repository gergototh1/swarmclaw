/**
 * The only file in this extension allowed to spell the old Hungarian names.
 *
 * Each one is still out there after the rename: a setting stored under its old
 * key, a folder on disk under its old name, a tool call recorded in an old
 * chat message. They have to be recognised to be migrated or honoured, and
 * keeping them here means everything else can be held to English by
 * test/english-only.test.mjs.
 */

/** New setting key -> the key the same setting was stored under before. */
export const LEGACY_SETTING_KEYS = Object.freeze({
  root: 'gyoker',
  watchEnabled: 'figyelesBe',
  versionsKept: 'verzioMegtartas',
  sharedFolderName: 'kozosMappaNev',
})

/** The shared folder's old default name, both on disk and as a stored setting value. */
export const LEGACY_SHARED_FOLDER = 'kozos'

/** The templates folder's old name on disk. */
export const LEGACY_TEMPLATES_FOLDER = '_sablonok'

/** Tool names older chat messages recorded, before docs_write and docs_video_script. */
export const LEGACY_PANEL_TOOLS = Object.freeze(['doksi_ir', 'doksi_video_forgatokonyv'])

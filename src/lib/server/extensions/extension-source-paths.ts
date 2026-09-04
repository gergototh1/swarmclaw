import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../data-dir'

/**
 * Where an external extension's code actually lives.
 *
 * There are two layouts, and only one of them puts the code in the file the
 * extensions directory listing shows:
 *
 *   plain      <DATA_DIR>/extensions/<name>.js            -- the code
 *   workspace  <DATA_DIR>/extensions/<name>.js            -- a generated shim
 *              <DATA_DIR>/extensions/.workspaces/<key>/index.js  -- the code
 *
 * A workspace appears the moment an extension needs its own `node_modules`:
 * `installExtensionDependencies`, `saveExtensionSource({ packageJson })`, or an
 * extension that ships its own installer (AI Signal's `scripts/install.mjs`).
 * From then on the extensions-dir file is an artifact -- the loader imports the
 * workspace entry, not the shim -- and any code that reads or writes the
 * extensions-dir file as if it held the source is reading or writing the wrong
 * file. That defect has landed three times in three different modules, so the
 * resolution lives here once rather than being open-coded per caller.
 *
 * This module deliberately imports nothing but node: builtins and DATA_DIR, so
 * that a caller which only needs a path -- the OpenClaw importer, the integrity
 * monitor -- can have it without pulling in the extension manager.
 */
export const EXTENSIONS_DIR = path.join(DATA_DIR, 'extensions')
export const EXTENSION_WORKSPACES_DIR = path.join(EXTENSIONS_DIR, '.workspaces')

/**
 * The workspace directory name for an extension filename.
 *
 * Baked into on-disk layout and into `scripts/install.mjs` of any extension
 * that installs itself, so it cannot change without moving existing
 * workspaces: 'aisignal.mjs' is and stays 'aisignal_mjs'.
 */
export function extensionWorkspaceKey(filename: string): string {
  return path.basename(filename).replace(/[^a-zA-Z0-9_-]/g, '_')
}

/** Absolute path of an extension's managed workspace. Returned even when it does not exist. */
export function extensionWorkspaceDir(filename: string): string {
  return path.join(EXTENSION_WORKSPACES_DIR, extensionWorkspaceKey(filename))
}

/**
 * The entry file inside a workspace. Always `index.js`, whatever the
 * extension's own filename ends in: the module format is decided by the
 * workspace's `package.json`, not by the extension's name.
 */
export const EXTENSION_WORKSPACE_ENTRY_FILENAME = 'index.js'

/** Absolute path of the file the loader imports for a workspace-backed extension. */
export function extensionWorkspaceEntryPath(filename: string): string {
  return path.join(extensionWorkspaceDir(filename), EXTENSION_WORKSPACE_ENTRY_FILENAME)
}

/** Whether this extension keeps its code in a managed workspace. */
export function hasExtensionWorkspace(filename: string): boolean {
  return fs.existsSync(extensionWorkspaceEntryPath(filename))
}

/**
 * The file that holds this extension's source: the workspace entry when there
 * is a workspace, the extensions-dir file otherwise.
 *
 * This is the path the loader imports, the path `readExtensionSource` shows an
 * operator, and the path anything writing new code for an existing extension
 * must write to.
 */
export function resolveExtensionSourcePath(filename: string): string {
  return hasExtensionWorkspace(filename)
    ? extensionWorkspaceEntryPath(filename)
    : path.join(EXTENSIONS_DIR, filename)
}

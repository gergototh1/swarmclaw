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
 * file. That defect has landed four times in four different modules, so the
 * resolution lives here once rather than being open-coded per caller: nothing
 * outside this file should join `EXTENSIONS_DIR` with an extension filename and
 * treat the result as source.
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

/**
 * The relative specifier a shim in the extensions directory uses to reach the
 * workspace entry it stands for.
 *
 * Derived from `EXTENSION_WORKSPACES_DIR` and
 * `EXTENSION_WORKSPACE_ENTRY_FILENAME` rather than spelled out again, so that
 * moving either leaves the shim pointing at the file that moved instead of at
 * nothing. Always POSIX-separated: it is a module specifier, not a path, and
 * `require('.\\.workspaces\\...')` does not resolve on Windows.
 */
export function extensionWorkspaceEntrySpecifier(filename: string): string {
  const relative = path.relative(EXTENSIONS_DIR, extensionWorkspaceEntryPath(filename))
  return `./${relative.split(path.sep).join('/')}`
}

/**
 * Directory names that are never part of an extension's own source.
 *
 * `node_modules` holds third-party packages, is installed rather than authored,
 * and for a single extension routinely runs to tens of thousands of files. Code
 * that walks an extension's source -- the integrity monitor is the caller that
 * matters -- skips it, and says so where an operator can read it.
 */
export const EXTENSION_SOURCE_EXCLUDED_DIRS: ReadonlySet<string> = new Set(['node_modules'])

/**
 * Every file that makes up this extension's own source.
 *
 * For a plain extension that is the single file in the extensions directory.
 * For a workspace-backed one it is the whole workspace tree except
 * `node_modules`: the entry the loader imports, everything the entry imports
 * beside it (AI Signal keeps 172 KB of logic in `src/*.mjs` against a 3.6 KB
 * entry), and the workspace `package.json` that decides the module format and
 * names the dependencies. `resolveExtensionSourcePath` alone returns the entry,
 * which is the right answer for "where do I read and write this extension's
 * code" and the wrong one for "what is this extension made of".
 *
 * What the exclusion cannot hide: the loader imports the workspace entry, and
 * anything under `node_modules` is reachable from it only as a declared
 * dependency, so the workspace `package.json` and any lockfile beside it are
 * baselined and a change to the dependency set shows up. Only the literal
 * directory name is skipped, at any depth, so code parked under some other name
 * is walked like the rest. Symlinked directories are followed, with each
 * directory's realpath visited once so a cycle terminates.
 *
 * Returns absolute paths. Unreadable directories are skipped rather than
 * thrown from: a caller that wants a report of what it could hash should not
 * lose the whole report to one permission error.
 */
export function listExtensionSourceFiles(filename: string): string[] {
  if (!hasExtensionWorkspace(filename)) {
    const plain = path.join(EXTENSIONS_DIR, path.basename(filename))
    return fs.existsSync(plain) ? [path.resolve(plain)] : []
  }

  const files: string[] = []
  const visitedDirs = new Set<string>()

  const walk = (dir: string): void => {
    let realDir: string
    try {
      realDir = fs.realpathSync(dir)
    } catch {
      return
    }
    if (visitedDirs.has(realDir)) return
    visitedDirs.add(realDir)

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      let stat: fs.Stats
      try {
        // statSync rather than the dirent's own type: a dirent reports a
        // symlink as a symlink, and a symlinked source file is still source.
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (EXTENSION_SOURCE_EXCLUDED_DIRS.has(entry.name)) continue
        walk(full)
      } else if (stat.isFile()) {
        files.push(path.resolve(full))
      }
    }
  }

  walk(extensionWorkspaceDir(filename))
  return files.sort()
}

/**
 * Whether this extension's source file is absent right now.
 *
 * Asked after an import failed, to tell "an operator removed the file while the
 * host was reading it" from "this extension is broken". Getting it wrong in the
 * first direction pushes a healthy extension toward auto-disable on nothing but
 * timing, so the question has to be asked about the layout the extension
 * actually has.
 *
 * `resolveExtensionSourcePath` cannot answer it. That function decides between
 * the two layouts by whether the workspace *entry* exists, which is precisely
 * the file that goes missing during a reinstall: at that moment it reports
 * "plain extension" and hands back the extensions-dir shim, which is still
 * sitting there, so the missing entry reads as present. The workspace
 * *directory* is the stable signal -- an extension that has one is
 * workspace-backed whether or not its entry happens to exist this millisecond
 * -- and `extensions/aisignal/scripts/install.mjs` is a live example of the
 * window, since it replaces the entry with a separate write.
 */
export function extensionSourceIsMissing(filename: string): boolean {
  if (fs.existsSync(extensionWorkspaceDir(filename))) {
    return !fs.existsSync(extensionWorkspaceEntryPath(filename))
  }
  return !fs.existsSync(path.join(EXTENSIONS_DIR, path.basename(filename)))
}

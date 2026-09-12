import { markdownToDocx } from './docx-from-markdown'
import type { DocsExportApi } from './load-export-bundle'

/** The one global this second bundle installs; `load-export-bundle.ts` reads it back. */
const api: DocsExportApi = { markdownToDocx }
;(window as Window & { swarmclawDocsExport?: DocsExportApi }).swarmclawDocsExport = api

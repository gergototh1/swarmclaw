/**
 * The Word writer is big, so it ships as its own bundle (dist/export.js) and
 * is fetched the first time someone exports. The page and the chat panel
 * share one load.
 */
export interface DocsExportApi {
  markdownToDocx(md: string, title: string): Promise<Blob>
}

type ExportWindow = Window & { swarmclawDocsExport?: DocsExportApi }

let pending: Promise<DocsExportApi> | null = null

export function loadExportBundle(extensionId: string): Promise<DocsExportApi> {
  const installed = (window as ExportWindow).swarmclawDocsExport
  if (installed) return Promise.resolve(installed)
  if (pending) return pending
  pending = new Promise<DocsExportApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `/api/extensions/${encodeURIComponent(extensionId)}/assets/export.js`
    script.async = true
    script.onload = () => {
      const api = (window as ExportWindow).swarmclawDocsExport
      if (api) resolve(api)
      else { pending = null; reject(new Error('the export bundle loaded but did not install itself')) }
    }
    script.onerror = () => {
      pending = null
      script.remove()
      reject(new Error(`the export bundle failed to load: ${script.src}`))
    }
    document.head.appendChild(script)
  })
  return pending
}

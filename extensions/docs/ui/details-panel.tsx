import { useCallback, useEffect, useState } from 'react'

import type { Backlink, Doc, Rpc, Version } from './api'
import { errorText, readBacklink, readDoc, readList, readVersion } from './api'

/**
 * The right column: what this document is, what it used to say, and who points
 * at it.
 *
 * Each of the three loads independently and reports its own failure. A version
 * list that could not be read must not hide the backlinks, and neither should
 * take the metadata down with it -- three questions, three answers, three
 * states.
 */

/**
 * A loaded answer, tagged with the document it belongs to.
 *
 * Everything here is keyed by id and compared on render rather than cleared in
 * an effect. Clearing synchronously inside an effect is what triggers a
 * cascading render, and the state it clears is state the render can simply
 * decline to use.
 */
type Loaded<T> = { id: string; value: T | null; error: string | null }

export function DetailsPanel({ rpc, id, onChanged }: { rpc: Rpc; id: string | null; onChanged: () => void }) {
  const [docState, setDocState] = useState<Loaded<Doc> | null>(null)
  const [versionsState, setVersionsState] = useState<Loaded<Version[]> | null>(null)
  const [backlinksState, setBacklinksState] = useState<Loaded<Backlink[]> | null>(null)
  // The doc's id is in the preview too, so switching to another doc invalidates
  // it on its own -- without a synchronous setState inside an effect, which
  // would start a render chain.
  const [preview, setPreview] = useState<{ id: string; version: number; content: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!id) return
    const resolve = <T,>(
      method: string,
      read: (raw: unknown) => T,
      set: (next: Loaded<T>) => void,
    ) => {
      rpc(method, { id })
        .then((raw) => set({ id, value: read(raw), error: null }))
        .catch((err) => set({ id, value: null, error: String(err?.message ?? err) }))
    }
    resolve('read', readDoc, setDocState)
    resolve('versions', (raw) => readList('versions', 'versions', raw, readVersion), setVersionsState)
    resolve('backlinks', (raw) => readList('backlinks', 'backlinks', raw, readBacklink), setBacklinksState)
  }, [id, rpc])

  useEffect(() => { load() }, [load])

  // After switching to another doc the old answer is still here; it is not
  // cleared, just not used.
  const ours = <T,>(state: Loaded<T> | null) => (state && state.id === id ? state : null)
  const doc = ours(docState)?.value ?? null
  const docError = ours(docState)?.error ?? null
  const versions = ours(versionsState)?.value ?? null
  const versionsError = ours(versionsState)?.error ?? null
  const backlinks = ours(backlinksState)?.value ?? null
  const backlinksError = ours(backlinksState)?.error ?? null
  const shown = preview && preview.id === id ? preview : null

  const restore = (version: number) => {
    if (!id || !doc) return
    setActionError(null)
    rpc('restoreVersion', { id, version, baseVersion: doc.version })
      .then((raw) => {
        const message = errorText(raw)
        if (message) { setActionError(message); return }
        setPreview(null)
        load()
        onChanged()
      })
      .catch((err) => setActionError(String(err?.message ?? err)))
  }

  if (!id) return <aside className="docs-column docs-details-panel" />

  return (
    <aside className="docs-column docs-details-panel">
      <section>
        <h3>Details</h3>
        {docError && <p className="docs-error" role="alert">{docError}</p>}
        {doc && (
          <dl className="docs-meta">
            <dt>Path</dt><dd>{doc.path}</dd>
            <dt>Owner</dt><dd>{doc.owner}</dd>
            <dt>Created</dt><dd>{doc.created.slice(0, 16).replace('T', ' ')}</dd>
            <dt>Updated</dt><dd>{doc.updated.slice(0, 16).replace('T', ' ')}</dd>
            <dt>Version</dt><dd>{doc.version}</dd>
            <dt>Tags</dt><dd>{doc.tags.length ? doc.tags.join(', ') : '—'}</dd>
          </dl>
        )}
      </section>

      <section>
        <h3>Versions</h3>
        {actionError && <p className="docs-error" role="alert">{actionError}</p>}
        {versionsError && <p className="docs-error" role="alert">{versionsError}</p>}
        {versions?.length === 0 && <p className="docs-muted">No earlier version yet.</p>}
        <ul className="docs-versions">
          {versions?.map((v) => (
            <li key={v.version}>
              <button
                type="button"
                onClick={() => {
                  if (shown?.version === v.version) { setPreview(null); return }
                  rpc('version', { id, version: v.version })
                    .then((raw) => {
                      const message = errorText(raw)
                      if (message) { setActionError(message); return }
                      setPreview({ id, version: v.version, content: String((raw as { content?: string }).content ?? '') })
                    })
                    .catch((err) => setActionError(String(err?.message ?? err)))
                }}
              >
                v{v.version} · {v.author || '—'} · {v.createdAt.slice(0, 16).replace('T', ' ')}
              </button>
              {doc && v.version !== doc.version && (
                <button type="button" className="docs-secondary" onClick={() => restore(v.version)}>
                  Restore
                </button>
              )}
              {shown?.version === v.version && <pre className="docs-preview">{shown.content}</pre>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Backlinks</h3>
        {backlinksError && <p className="docs-error" role="alert">{backlinksError}</p>}
        {backlinks?.length === 0 && <p className="docs-muted">Nothing points to this doc yet.</p>}
        <ul className="docs-backlinks">
          {backlinks?.map((b) => (
            <li key={b.fromId}>
              <strong>{b.title}</strong>
              <span className="docs-muted">{b.path}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}

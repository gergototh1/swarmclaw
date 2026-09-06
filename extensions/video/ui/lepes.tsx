/**
 * A lever and the one line beside it: when it is dark, why; when it is live
 * and it costs something, what.
 *
 * A DARK CONTROL ON THIS PAGE EXPLAINS ITSELF. That is the rule the whole
 * page is built on -- a disabled button carries a sentence beside it, never a
 * `title=` nobody hovers on a button they cannot press -- and this component
 * is that rule made into one thing rather than a habit three views keep
 * separately. `ok` is the sentence: non-null means the button is dark AND the
 * reason is printed, and the two cannot come apart, because they are one
 * prop.
 *
 * THE PRICE AND THE REASON ARE EXCLUSIVE ON PURPOSE. `figyelmeztetes` warns
 * about a click, so it is only worth printing while a click is possible; a
 * dark button's own sentence already says what is happening and what it will
 * take. Showing both would put two lines of grey prose under every ordering
 * lever, and the eye would stop reading either.
 *
 * WHY IT IS A FILE OF ITS OWN. It was written three times -- once in
 * `ui/video.tsx` for the four levers of the Video view, and twice inline in
 * `ui/sor.tsx`, for Uj video and for the YouTube button -- by three separate
 * tasks that never saw each other's copy. The only difference between them
 * was the button's `type`: the Uj video copy sits inside a `<form>` and has
 * to submit it, the other two are plain buttons. That is one prop, with
 * `'button'` as the default because that is what most levers are, so nothing
 * that is not a form has to say anything.
 *
 * IT KNOWS NOTHING ABOUT VIDEOS. No rpc shape, no status vocabulary, no
 * `VideoDetail`: it takes a label, a reason-or-null, an optional price and a
 * click. Every sentence it draws is a React text child, and the callers own
 * every word -- which is what lets the Sor view's copy carry the module's own
 * refusal messages without this file knowing that such things exist.
 */
export function Lepes({ cimke, ok, figyelmeztetes, onKattint, type = 'button' }: {
  cimke: string
  /** Why the lever is dark, or null when it is live. Non-null both disables the button and prints the sentence. */
  ok: string | null
  /** What a live click will cost. Drawn only while the lever is live. */
  figyelmeztetes?: string
  /** Absent for a `submit` lever: the surrounding `<form>`'s `onSubmit` is what runs then. */
  onKattint?: () => void
  type?: 'button' | 'submit'
}) {
  return (
    <div className="vid-lepes">
      <button type={type} className="vid-btn" disabled={ok !== null} onClick={onKattint}>{cimke}</button>
      {ok !== null && <span className="vid-muted vid-lepes-ok">{ok}</span>}
      {ok === null && figyelmeztetes !== undefined && <span className="vid-lepes-ar">{figyelmeztetes}</span>}
    </div>
  )
}

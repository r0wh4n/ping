// Message composer behaviour, shared by every chat surface.
//
// All three composers were a single-line <input>. A browser collapses pasted
// newlines into spaces in an <input>, so a multi-line message lost its
// structure before it was ever encrypted and sent — the markdown renderer
// turns \n into <br/> and never saw one. Pasting a numbered list produced one
// run-on paragraph, and there was no way to type a second line at all.

/**
 * Enter sends; Shift+Enter starts a new line.
 *
 * `isComposing` is not optional politeness: while an IME is open (Japanese,
 * Chinese, Korean, and many phone keyboards' autocomplete) Enter commits the
 * candidate word. Sending on it would fire a half-typed message mid-word.
 */
export const sendsMessage = (e: { key: string; shiftKey: boolean; isComposing?: boolean }) =>
  e.key === "Enter" && !e.shiftKey && !e.isComposing;

/** Grow a composer to fit its content, up to a few lines, then scroll. */
export function grow(el: HTMLTextAreaElement, max = 160) {
  // Reset first: without it the box can only ever get taller, because
  // scrollHeight is measured against the height already set.
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

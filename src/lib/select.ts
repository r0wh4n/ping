// Selecting the text of a message.
//
// Message bubbles are <button>s, so tapping one opens its actions. Chrome will
// not let you drag-select text inside a button — mousedown activates the button
// instead — so on Windows a message simply could not be copied. Safari is more
// forgiving, which is why this only ever got reported from Windows.
//
// Two halves, and both are needed. The bubble has to opt back into selection
// (`select-text`), and the click handler has to ignore the click that ends a
// drag — otherwise copying a message also pops its action menu open every time.

/** Has the user got text selected right now? */
export const hasSelection = () => {
  try {
    return (globalThis.getSelection?.()?.toString().trim().length ?? 0) > 0;
  } catch {
    return false; // no DOM (SSR), or a browser refusing the call
  }
};

/**
 * Wrap a bubble's click handler so selecting its text does not also trigger it.
 * The click that ends a drag-select is a real click as far as the DOM is
 * concerned; the selection is the only thing that distinguishes them.
 */
export const unlessSelecting = (run: () => void) => () => {
  if (hasSelection()) return;
  run();
};

#!/usr/bin/env node
// Every chat surface must be able to send a message with more than one line.
//
// All three composers were a single-line <input>. A browser collapses pasted
// newlines into spaces there, so a multi-line message lost its structure before
// it was ever encrypted — renderMarkdown turns \n into <br/> and never saw one.
// Pasting a numbered list produced a single run-on paragraph, and there was no
// way to type a second line at all. Found by pasting setup instructions into
// Ping itself.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendsMessage } from "../src/lib/compose.ts";
import { hasSelection, unlessSelecting } from "../src/lib/select.ts";

assert.equal(sendsMessage({ key: "Enter", shiftKey: false }), true, "Enter sends");
assert.equal(sendsMessage({ key: "Enter", shiftKey: true }), false, "Shift+Enter writes a new line — this is the whole point");
assert.equal(sendsMessage({ key: "a", shiftKey: false }), false, "ordinary typing is not a send");
// While an IME is open (Japanese, Chinese, Korean, many phone keyboards) Enter
// commits the candidate word. Sending on it fires a half-typed message mid-word.
assert.equal(sendsMessage({ key: "Enter", shiftKey: false, isComposing: true }), false,
  "Enter must not send while an input method is composing a word");

// The element matters as much as the handler: a textarea keeps pasted newlines,
// an input silently throws them away before any of our code runs.
for (const file of [
  "src/app/app/dm/[handle]/page.tsx",
  "src/app/app/group/[id]/page.tsx",
  "src/app/app/live/[handle]/page.tsx",
]) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const at = src.indexOf("sendsMessage({ key: e.key");
  assert.ok(at > 0, `${file}: the composer must use the shared send rule`);
  const open = src.lastIndexOf("<", at);
  assert.ok(src.startsWith("<textarea", src.lastIndexOf("<textarea", at)) &&
    src.lastIndexOf("<textarea", at) > src.lastIndexOf("<input", at),
    `${file}: the composer must be a <textarea> — an <input> drops pasted newlines`);
  assert.ok(open > 0);
}

// --- copying a message ------------------------------------------------------
// Bubbles are <button>s so a tap opens their actions, and Chrome will not
// drag-select text inside a button: on Windows a message could not be copied at
// all. Opting back into selection is only half of it — the click that ends a
// drag is a real click, so without the guard, copying a message also pops its
// action menu every time.
{
  const stub = (text) => { globalThis.getSelection = () => ({ toString: () => text }); };
  let ran = 0;
  const onClick = unlessSelecting(() => { ran++; });

  stub("");
  assert.equal(hasSelection(), false, "nothing selected");
  onClick();
  assert.equal(ran, 1, "a plain click must still open the actions");

  stub("part of a message");
  assert.equal(hasSelection(), true, "a selection is a selection");
  onClick();
  assert.equal(ran, 1, "the click that ends a drag-select must not open the actions");

  stub("   \n  ");
  assert.equal(hasSelection(), false, "whitespace is not a selection — a click can land on a line break");
  onClick();
  assert.equal(ran, 2, "...so that click still counts");

  delete globalThis.getSelection;
  assert.equal(hasSelection(), false, "no DOM at all must not throw during SSR");
}

for (const file of ["src/app/app/dm/[handle]/page.tsx", "src/app/app/group/[id]/page.tsx"]) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  assert.match(src, /select-text/, `${file}: a message bubble must opt back into text selection`);
  assert.doesNotMatch(src, /onClick=\{\(\) => setActiveMsg/,
    `${file}: a bubble's click must go through unlessSelecting, or copying also opens its menu`);
}

console.log("check-compose: all assertions passed");

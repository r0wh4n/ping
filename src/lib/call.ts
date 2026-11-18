/**
 * Glare: both sides dialled at the same instant, so each has an outgoing call
 * and an incoming offer. Both run this on the same pair of ids and get opposite
 * answers, so exactly one call survives — the lower id keeps its outgoing call,
 * the higher id stands its own down and answers instead.
 */
export const keepsOutgoingCall = (myId: string, theirId: string) => myId < theirId;

export type CallState = "idle" | "calling" | "ringing" | "connected" | "ended";

/**
 * Is there room for a new call right now?
 *
 * "ended" is NOT busy. It is a display state: finish() parks there for a second
 * or two so the overlay can say how the last call ended before dismissing
 * itself. Both places that asked this compared against "idle" alone, which made
 * that cosmetic pause behave like an active call. An incoming redial inside the
 * window was auto-rejected with an "end" signal; the caller, still in "calling",
 * rendered that as "Call declined."; and someone redialling straight away could
 * sit in that loop indefinitely, with the callee's phone never ringing.
 *
 * Lives here rather than in the hook so it can be asserted without a browser.
 */
export const callSlotFree = (state: CallState) => state === "idle" || state === "ended";

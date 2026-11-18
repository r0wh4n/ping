/**
 * Glare: both sides dialled at the same instant, so each has an outgoing call
 * and an incoming offer. Both run this on the same pair of ids and get opposite
 * answers, so exactly one call survives — the lower id keeps its outgoing call,
 * the higher id stands its own down and answers instead.
 */
export const keepsOutgoingCall = (myId: string, theirId: string) => myId < theirId;

export type CallState = "idle" | "calling" | "ringing" | "connecting" | "connected" | "ended";

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

/**
 * Has this side answered, even if media has not flowed yet?
 *
 * Pressing accept used to change nothing on screen: the state only left
 * "ringing" when the peer connection reached "connected", which is seconds
 * later and sometimes never. So the header still said "Incoming call", both
 * buttons were still there, and the ringtone kept going. People reasonably
 * concluded the button had not worked and pressed the red one — which sends
 * `end`, and the caller renders that as "Call declined." The call was being
 * torn down by the person trying to take it.
 */
export const callAnswered = (state: CallState) => state === "connecting" || state === "connected";

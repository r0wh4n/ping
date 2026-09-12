/**
 * Glare: both sides dialled at the same instant, so each has an outgoing call
 * and an incoming offer. Both run this on the same pair of ids and get opposite
 * answers, so exactly one call survives — the lower id keeps its outgoing call,
 * the higher id stands its own down and answers instead.
 */
export const keepsOutgoingCall = (myId: string, theirId: string) => myId < theirId;

import { test, expect } from "@playwright/test";
import { keepsOutgoingCall } from "../src/lib/call";

// What these cover: the parts of calling that were hand-rolled in useCall and
// that node cannot reach — real ICE negotiation, the candidate-buffering rule,
// and the /turn credential route. Driving the whole app as two logged-in users
// needs two real accounts; that lives in call.e2e.spec.ts and is opt-in.

test("ICE candidates before the remote description are rejected", async ({ page }) => {
  // useCall queues candidates until setRemoteDescription lands. If Chrome ever
  // stopped rejecting them, that buffering would be dead weight — this is the
  // assertion that keeps it honest.
  await page.goto("/");
  const threw = await page.evaluate(async () => {
    const pc = new RTCPeerConnection();
    try {
      await pc.addIceCandidate({ candidate: "candidate:1 1 udp 2 127.0.0.1 9 typ host", sdpMid: "0" });
      return false;
    } catch {
      return true;
    } finally {
      pc.close();
    }
  });
  expect(threw).toBe(true);
});

test("two peers negotiate to connected and media flows", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const ICE = [{ urls: ["stun:stun.l.google.com:19302"] }];
    const a = new RTCPeerConnection({ iceServers: ICE });
    const b = new RTCPeerConnection({ iceServers: ICE });

    // Mirror useCall: queue candidates that arrive before the description.
    const queued: RTCIceCandidateInit[] = [];
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate.toJSON()).catch(() => {});
    b.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (a.remoteDescription) a.addIceCandidate(e.candidate.toJSON()).catch(() => {});
      else queued.push(e.candidate.toJSON());
    };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach((t) => a.addTrack(t, stream));
    const bStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    bStream.getTracks().forEach((t) => b.addTrack(t, bStream));

    const gotRemote = new Promise<number>((resolve) => {
      b.ontrack = (e) => e.streams[0] && resolve(e.streams[0].getTracks().length);
    });

    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    for (const c of queued) await a.addIceCandidate(c).catch(() => {});

    const connected = await new Promise<boolean>((resolve) => {
      const done = () => {
        if (a.connectionState === "connected") resolve(true);
        if (a.connectionState === "failed") resolve(false);
      };
      a.onconnectionstatechange = done;
      done();
      setTimeout(() => resolve(a.connectionState === "connected"), 20_000);
    });

    const tracks = await gotRemote;
    const live = (b.getReceivers() ?? []).filter((r) => r.track && r.track.readyState === "live").length;
    a.close();
    b.close();
    return { connected, tracks, live };
  });

  expect(result.connected).toBe(true);
  expect(result.tracks).toBeGreaterThan(0);
  expect(result.live).toBeGreaterThan(0);
});

test("/turn refuses to mint relay credentials for anonymous callers", async ({ request }) => {
  const res = await request.get("/turn");
  // 401 once TURN_SECRET/TURN_URL are set; an empty list when it is not
  // configured. What must never happen is handing out usable credentials.
  if (res.status() === 200) {
    expect(await res.json()).toEqual({ iceServers: [] });
  } else {
    expect(res.status()).toBe(401);
  }
});

test("glare is resolved to exactly one surviving call", () => {
  expect(keepsOutgoingCall("a", "b")).toBe(true);
  expect(keepsOutgoingCall("b", "a")).toBe(false);
});

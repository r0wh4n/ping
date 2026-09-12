import { test, expect } from "@playwright/test";

// The bug this guards: signalling used to open a fresh realtime channel per
// message. One offer survived that — so calls rang — but on accept each side
// trickles a dozen ICE candidates at once, and those rapid joins to the same
// topic collide instead of queueing, so the candidates never arrive and the
// call never connects. One channel held open for the call is the fix.
//
// Two pages, because the two sides of a call are two clients on two sockets.
test("an ICE burst arrives in full over one held-open channel", async ({ browser }) => {
  const [a, b] = await Promise.all([browser.newPage(), browser.newPage()]);
  await Promise.all([a.goto("/"), b.goto("/")]);
  const ready = (p: typeof a) =>
    p.waitForFunction(() => !!(window as never as { __supabase?: unknown }).__supabase);
  await Promise.all([ready(a), ready(b)]);

  const topic = "calls:test-" + Math.random().toString(36).slice(2);
  const N = 20;

  const listening = await a.evaluate(
    async ({ topic }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = (window as any).__supabase;
      const w = window as unknown as { __got: number };
      w.__got = 0;
      const ch = sb.channel(topic);
      ch.on("broadcast", { event: "ice" }, () => (w.__got += 1));
      return await new Promise<boolean>((res) => {
        ch.subscribe((s: string) => (s === "SUBSCRIBED" ? res(true) : s === "CHANNEL_ERROR" ? res(false) : null));
        setTimeout(() => res(false), 15000);
      });
    },
    { topic }
  );
  test.skip(!listening, "realtime websocket unreachable from this network");

  const sent = await b.evaluate(
    async ({ topic, N }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = (window as any).__supabase;
      const ch = sb.channel(topic);
      const ok = await new Promise<boolean>((res) => {
        ch.subscribe((s: string) => (s === "SUBSCRIBED" ? res(true) : s === "CHANNEL_ERROR" ? res(false) : null));
        setTimeout(() => res(false), 15000);
      });
      if (!ok) return 0;
      for (let i = 0; i < N; i++) ch.send({ type: "broadcast", event: "ice", payload: { i } });
      return N;
    },
    { topic, N }
  );
  expect(sent).toBe(N);

  await a.waitForFunction((n) => (window as unknown as { __got: number }).__got >= n, N, { timeout: 15000 });
  const got = await a.evaluate(() => (window as unknown as { __got: number }).__got);
  expect(got).toBe(N);

  await Promise.all([a.close(), b.close()]);
});

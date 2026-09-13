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

// A second call placed moments after the first: the previous channel on that
// topic may still be tearing down, and joining it again collides — which is
// what leaves an offer stranded in the outbox, so the caller shows "connecting"
// and the callee never rings. openPeer purges stale channels on the topic first.
test("a call placed right after the previous one still reaches the peer", async ({ browser }) => {
  const [a, b] = await Promise.all([browser.newPage(), browser.newPage()]);
  await Promise.all([a.goto("/"), b.goto("/")]);
  const ready = (p: typeof a) =>
    p.waitForFunction(() => !!(window as never as { __supabase?: unknown }).__supabase);
  await Promise.all([ready(a), ready(b)]);

  const topic = "calls:rapid-" + Math.random().toString(36).slice(2);

  const listening = await a.evaluate(
    async ({ topic }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = (window as any).__supabase;
      const w = window as unknown as { __got: number };
      w.__got = 0;
      const ch = sb.channel(topic);
      ch.on("broadcast", { event: "offer" }, () => (w.__got += 1));
      return await new Promise<boolean>((res) => {
        ch.subscribe((s: string) => (s === "SUBSCRIBED" ? res(true) : s === "CHANNEL_ERROR" ? res(false) : null));
        setTimeout(() => res(false), 15000);
      });
    },
    { topic }
  );
  test.skip(!listening, "realtime websocket unreachable from this network");

  const sent = await b.evaluate(
    async ({ topic }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = (window as any).__supabase;
      const open = (t: string) =>
        new Promise<{ ch: unknown; ok: boolean }>((res) => {
          // Purge stale channels on this topic first — the fix under test.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sb.getChannels().forEach((c: any) => {
            if (c.topic === t || c.topic === `realtime:${t}`) sb.removeChannel(c);
          });
          const ch = sb.channel(t);
          ch.subscribe((s: string) => (s === "SUBSCRIBED" ? res({ ch, ok: true }) : s === "CHANNEL_ERROR" ? res({ ch, ok: false }) : null));
          setTimeout(() => res({ ch, ok: false }), 10000);
        });

      // First call, then hang up and immediately dial again.
      const one = await open(topic);
      if (!one.ok) return 0;
      let n = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (one.ch as any).send({ type: "broadcast", event: "offer", payload: {} });
      n++;
      sb.removeChannel(one.ch); // teardown begins, no delay before redialling

      const two = await open(topic);
      if (!two.ok) return n;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (two.ch as any).send({ type: "broadcast", event: "offer", payload: {} });
      n++;
      return n;
    },
    { topic }
  );
  expect(sent).toBe(2);

  await a.waitForFunction(() => (window as unknown as { __got: number }).__got >= 2, undefined, { timeout: 15000 });
  expect(await a.evaluate(() => (window as unknown as { __got: number }).__got)).toBe(2);

  await Promise.all([a.close(), b.close()]);
});

// Mission Control subscribes to every room at once with a `group_id=in.(...)`
// filter. A malformed filter is not a loud failure — the socket just reports
// CHANNEL_ERROR and no activity ever arrives, which is indistinguishable from a
// quiet fleet. This checks the server accepts the filter shape we send.
test("the fleet-wide realtime filter is accepted by the server", async ({ page }) => {
  await page.goto("/app");
  await page.waitForFunction(() => !!(window as never as { __supabase?: unknown }).__supabase);

  const status = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = (window as any).__supabase;
    const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
    const ch = sb
      .channel("filtertest-" + Math.random().toString(36).slice(2))
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_group_messages", filter: `group_id=in.(${ids.join(",")})` },
        () => {}
      );
    return await new Promise<string>((res) => {
      ch.subscribe((s: string) => (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" ? res(s) : null));
      setTimeout(() => res("TIMEOUT"), 15000);
    });
  });

  test.skip(status === "TIMEOUT", "realtime websocket unreachable from this network");
  expect(status).toBe("SUBSCRIBED");
});

import { test, expect } from "@playwright/test";

// A silent ringtone is indistinguishable from a broken one until someone misses
// a call, so this renders the pattern offline and checks it actually makes
// noise — and that the gap between bursts is really silent, since a ring that
// never stops is just a tone.
test("the incoming ring makes sound in bursts with silence between", async ({ page }) => {
  await page.goto("/app");
  await page.waitForFunction(() => !!(window as never as { __scheduleRing?: unknown }).__scheduleRing);

  const level = await page.evaluate(async () => {
    const rate = 16000;
    const seconds = 3;
    const ctx = new OfflineAudioContext(1, rate * seconds, rate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__scheduleRing(ctx, "incoming", seconds);
    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);
    const peak = (from: number, to: number) => {
      let m = 0;
      for (let i = Math.floor(from * rate); i < Math.floor(to * rate); i++) m = Math.max(m, Math.abs(data[i]));
      return m;
    };
    return {
      firstBurst: peak(0.05, 0.35),   // burst one
      secondBurst: peak(0.55, 0.85),  // burst two
      gap: peak(1.2, 2.4),            // the pause before it repeats
    };
  });

  expect(level.firstBurst).toBeGreaterThan(0.01);
  expect(level.secondBurst).toBeGreaterThan(0.01);
  expect(level.gap).toBeLessThan(0.001);
});

test("the outgoing ringback is quieter than the incoming ring", async ({ page }) => {
  await page.goto("/app");
  await page.waitForFunction(() => !!(window as never as { __scheduleRing?: unknown }).__scheduleRing);

  const peaks = await page.evaluate(async () => {
    const rate = 16000;
    const render = async (kind: string) => {
      const ctx = new OfflineAudioContext(1, rate * 2, rate);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__scheduleRing(ctx, kind, 2);
      const d = (await ctx.startRendering()).getChannelData(0);
      let m = 0;
      for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
      return m;
    };
    return { incoming: await render("incoming"), outgoing: await render("outgoing") };
  });

  expect(peaks.outgoing).toBeGreaterThan(0.005);
  expect(peaks.outgoing).toBeLessThan(peaks.incoming);
});

import { test, expect, type Page } from "@playwright/test";

// The full path: two signed-in people, a real call between them, and the record
// it leaves in the thread. Opt-in, because it needs two real accounts and it
// writes to whatever database the dev server points at — which is production
// unless you point it somewhere else first.
//
//   PING_TEST_A=handle:password PING_TEST_B=handle:password npx playwright test call.e2e
//
// Use throwaway handles. Never point this at accounts you care about.
const A = process.env.PING_TEST_A;
const B = process.env.PING_TEST_B;
const split = (v: string) => {
  const i = v.indexOf(":");
  return { handle: v.slice(0, i), password: v.slice(i + 1) };
};

test.skip(!A || !B, "set PING_TEST_A and PING_TEST_B to handle:password to run");

async function login(page: Page, handle: string, password: string) {
  await page.goto("/app");
  await page.getByPlaceholder("spiderman").fill(handle);
  await page.getByPlaceholder("your password").fill(password);
  await page.getByPlaceholder("your password").press("Enter");
  await expect(page.getByText(`@${handle}`).first()).toBeVisible({ timeout: 20_000 });
}

test("a voice call connects between two people and lands in the thread", async ({ browser }) => {
  const a = split(A!);
  const b = split(B!);
  const [ctxA, ctxB] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [pageA, pageB] = await Promise.all([ctxA.newPage(), ctxB.newPage()]);

  await Promise.all([login(pageA, a.handle, a.password), login(pageB, b.handle, b.password)]);

  // B just sits in the app: the call must ring from the shell, not from having
  // the right thread already open.
  await pageA.goto(`/app/dm/${b.handle}`);
  await pageA.getByLabel(`Voice call @${b.handle}`).click();

  await expect(pageB.getByText("Incoming voice call")).toBeVisible({ timeout: 20_000 });
  await pageB.getByLabel("Accept call").click();

  // Both sides show the in-call state once ICE settles.
  await expect(pageA.getByText("End-to-end encrypted")).toBeVisible({ timeout: 30_000 });
  await expect(pageB.getByText("End-to-end encrypted")).toBeVisible({ timeout: 30_000 });

  await pageA.getByLabel("End call").click();

  // The caller writes the record, so it shows up in A's thread with B.
  await expect(pageA.getByText(/📞 Call ·/)).toBeVisible({ timeout: 20_000 });

  await Promise.all([ctxA.close(), ctxB.close()]);
});

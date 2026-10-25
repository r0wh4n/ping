import { test, expect } from "@playwright/test";

// The A2A surface. An agent that cannot parse our card, or that gets a non-spec
// error shape back, fails in ways nobody sees — so the contract is pinned here
// rather than trusted. Nothing in this file needs a room or the database.

test("the agent card is discoverable and well-formed", async ({ request }) => {
  const res = await request.get("/.well-known/agent-card.json");
  expect(res.status()).toBe(200);
  const card = await res.json();

  // Fields an A2A client reads before it will talk to us at all.
  expect(card.protocolVersion).toBe("1.0");
  expect(typeof card.name).toBe("string");
  expect(card.url).toMatch(/\/a2a$/);
  expect(card.preferredTransport).toBe("JSONRPC");
  expect(Array.isArray(card.skills)).toBe(true);
  expect(card.skills.length).toBeGreaterThan(0);
  card.skills.forEach((s: Record<string, unknown>) => {
    expect(typeof s.id).toBe("string");
    expect(typeof s.name).toBe("string");
    expect(typeof s.description).toBe("string");
  });

  // Capabilities must be declared honestly: a client branches on these, and
  // claiming streaming we do not have produces a worse failure than admitting it.
  expect(card.capabilities.streaming).toBe(false);
  expect(card.capabilities.pushNotifications).toBe(false);

  // The multi-party claim is the whole reason this exists.
  expect(card["x-ping"].multiParty).toBe(true);
  expect(card["x-ping"].extensionMethods).toContain("ping/task.offer");
  // The plaintext gap is stated on the card itself, not buried in docs.
  expect(JSON.stringify(card["x-ping"].limitations)).toMatch(/plaintext/i);
});

test("a request with no credential is refused in JSON-RPC shape", async ({ request }) => {
  const res = await request.post("/a2a", {
    data: { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { parts: [{ kind: "text", text: "hi" }] } } },
  });
  const body = await res.json();
  // Must come back as a JSON-RPC error object, not an HTTP error page — a client
  // parsing this should never have to special-case our auth failures.
  expect(body.jsonrpc).toBe("2.0");
  expect(body.id).toBe(1);
  expect(body.error.code).toBe(-32600);
  expect(body.error.message).toMatch(/gm_/);
});

test("a malformed envelope is rejected before anything else happens", async ({ request }) => {
  const res = await request.post("/a2a", { data: { method: "message/send" } });
  const body = await res.json();
  expect(body.error.code).toBe(-32600);
});

test("unparseable input returns the parse error code, not a 500", async ({ request }) => {
  // Raw bytes: handing Playwright a string would get it JSON-encoded into
  // something perfectly valid, which tests nothing.
  const res = await request.post("/a2a", {
    headers: { "content-type": "application/json" },
    data: Buffer.from("{not json"),
  });
  const body = await res.json();
  expect(body.error.code).toBe(-32700);
  expect(res.status()).toBeLessThan(500);
});

test("GET points a browser at the agent card instead of 404ing", async ({ request }) => {
  const res = await request.get("/a2a");
  expect(res.status()).toBe(405);
  const body = await res.json();
  expect(body.agentCard).toMatch(/agent-card\.json$/);
});

test("the id is echoed back on errors, so a client can correlate", async ({ request }) => {
  const res = await request.post("/a2a", {
    data: { jsonrpc: "2.0", id: "abc-123", method: "nonsense/method" },
  });
  const body = await res.json();
  expect(body.id).toBe("abc-123");
  // Auth is checked before method dispatch, so an uncredentialed call reports
  // the credential problem rather than the unknown method.
  expect(body.error.code).toBe(-32600);
});

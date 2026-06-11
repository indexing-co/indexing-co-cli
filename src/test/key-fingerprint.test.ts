const test = require("node:test");
const assert = require("node:assert/strict");

import { computeKeyFingerprint, computeKeyIdentity } from "../lib/key-fingerprint";
import { reportAgentActivity, subscribeConsoleState } from "../lib/console-state";

// Fixed vectors so an accidental algorithm change (digest, truncation,
// key/message swap) fails loudly instead of silently breaking the console's
// server-side comparison (COR-1796/COR-1797 share this derivation).
test("computeKeyFingerprint matches the HMAC-SHA256(key, sessionId)[:16] spec", () => {
  assert.equal(computeKeyFingerprint("test-key", "session-a"), "112a9e7a90244dec");
  assert.equal(computeKeyFingerprint("test-key", "session-b"), "f7c1d59a97a90406");
});

test("computeKeyFingerprint differs per session for the same key", () => {
  const a = computeKeyFingerprint("test-key", "session-a");
  const b = computeKeyFingerprint("test-key", "session-b");
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.match(b, /^[0-9a-f]{16}$/);
});

test("computeKeyIdentity is stable and distinct from the per-session fingerprint", () => {
  assert.equal(computeKeyIdentity("test-key"), "62af8704764faf8e");
  assert.equal(computeKeyIdentity("test-key"), computeKeyIdentity("test-key"));
  assert.notEqual(computeKeyIdentity("test-key"), computeKeyFingerprint("test-key", "session-a"));
});

test("reportAgentActivity attaches keyFingerprint and never the raw key", async () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  let body = "";

  const ok = await reportAgentActivity({
    type: "deploy_pipeline",
    target: { id: "p1", name: "p1", type: "pipeline" },
    sessionId,
    apiKey: "super-secret-key",
    env: {},
    fetchImpl: async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(ok, true);
  const parsed = JSON.parse(body);
  assert.equal(parsed.data.keyFingerprint, computeKeyFingerprint("super-secret-key", sessionId));
  assert.ok(!body.includes("super-secret-key"), "raw API key must never be serialized");
});

test("reportAgentActivity omits keyFingerprint when no apiKey is configured", async () => {
  let body = "";

  await reportAgentActivity({
    type: "deploy_pipeline",
    target: { id: "p1", name: "p1", type: "pipeline" },
    sessionId: "11111111-2222-4333-8444-555555555555",
    env: {},
    fetchImpl: async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.ok(!JSON.parse(body).data.keyFingerprint, "no fingerprint without a key");
});

test("presence heartbeat carries the per-session keyFingerprint", async () => {
  const sessionId = "fingerprint-heartbeat-session";
  let heartbeatBody: Record<string, unknown> | null = null;

  function createOpenSseResponse(chunks: string[], signal?: AbortSignal): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          signal?.addEventListener("abort", () => controller.close());
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }

  await new Promise<void>((resolve) => {
    const subscription = subscribeConsoleState({
      sessionId,
      consoleUrl: "https://staging.console.indexing.co",
      apiKey: "heartbeat-secret",
      fetchImpl: async (input, init) => {
        if (String(init?.method) === "POST" && String(input).includes("/api/state/presence")) {
          heartbeatBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return createOpenSseResponse(
          ["event: route_change\ndata: {\"route\":\"/pipelines\"}\n\n"],
          init?.signal as AbortSignal | undefined,
        );
      },
      onEvent: () => {
        subscription.unsubscribe();
        resolve();
      },
    });
  });

  assert.ok(heartbeatBody, "expected a presence heartbeat");
  assert.equal(
    (heartbeatBody as unknown as Record<string, unknown>).keyFingerprint,
    computeKeyFingerprint("heartbeat-secret", sessionId),
  );
  assert.ok(
    !JSON.stringify(heartbeatBody).includes("heartbeat-secret"),
    "raw API key must never be serialized",
  );
});

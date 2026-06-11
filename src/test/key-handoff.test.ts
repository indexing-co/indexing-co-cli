const test = require("node:test");
const assert = require("node:assert/strict");

import { requestAccountKeyHandoff } from "../lib/console-state";

const SESSION_ID = "11111111-2222-4333-8444-666666666666";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("requestAccountKeyHandoff posts the request, polls, and returns the released key", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  let polls = 0;

  const result = await requestAccountKeyHandoff({
    sessionId: SESSION_ID,
    consoleUrl: "https://staging.console.indexing.co",
    source: "claude-code",
    pollIntervalMs: 0,
    fetchImpl: async (input, init) => {
      const url = String(input);
      const method = String(init?.method);
      calls.push({ method, url });

      if (url.endsWith("/api/state/presence")) return jsonResponse({ ok: true });
      if (method === "POST" && url.endsWith("/api/agent/key-request")) {
        return jsonResponse({ status: "requested" });
      }
      polls += 1;
      // pending twice, then approved with the key
      return polls < 3
        ? jsonResponse({ status: "pending" })
        : jsonResponse({ status: "approved", apiKey: "granted-key" });
    },
  });

  assert.deepEqual(result, { status: "approved", apiKey: "granted-key" });
  assert.ok(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/state/presence")));
  assert.ok(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/agent/key-request")));
  assert.equal(polls, 3);
});

test("requestAccountKeyHandoff surfaces denial without retrying forever", async () => {
  const result = await requestAccountKeyHandoff({
    sessionId: SESSION_ID,
    consoleUrl: "https://staging.console.indexing.co",
    pollIntervalMs: 0,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/state/presence")) return jsonResponse({ ok: true });
      if (String(init?.method) === "POST") return jsonResponse({ status: "requested" });
      return jsonResponse({ status: "denied" });
    },
  });

  assert.deepEqual(result, { status: "denied" });
});

test("requestAccountKeyHandoff times out cleanly when nobody approves", async () => {
  const result = await requestAccountKeyHandoff({
    sessionId: SESSION_ID,
    consoleUrl: "https://staging.console.indexing.co",
    pollIntervalMs: 0,
    timeoutMs: 25,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/state/presence")) return jsonResponse({ ok: true });
      if (String(init?.method) === "POST") return jsonResponse({ status: "requested" });
      return jsonResponse({ status: "pending" });
    },
  });

  assert.equal(result.status, "timeout");
  assert.equal(result.apiKey, undefined);
});

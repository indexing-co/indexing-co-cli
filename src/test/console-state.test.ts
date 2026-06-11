const test = require("node:test");
const assert = require("node:assert/strict");

import { getCurrentUserState, resolveAgentSource, resolveConsoleSessionId, subscribeConsoleState } from "../lib/console-state";

function createOpenSseResponse(
  chunks: string[],
  signal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }

        signal?.addEventListener("abort", () => {
          controller.close();
        });
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

test("getCurrentUserState fetches the latest snapshot", async () => {
  let requestHeaders: Record<string, string> = {};
  let requestUrl = "";
  const snapshot = await getCurrentUserState({
    sessionId: "session-123",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ route: "/builder", updatedAt: "2026-05-18T12:00:00.000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(requestHeaders["X-Session-Id"], "session-123");
  assert.equal(requestUrl, "https://console.indexing.co/api/state/current");
  assert.equal(snapshot.route, "/builder");
});

test("subscribeConsoleState shares a single stream per console/session", async () => {
  const receivedA: string[] = [];
  const receivedB: string[] = [];
  let fetchCount = 0;

  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method === "GET") {
      fetchCount += 1;
    }
    return createOpenSseResponse(["event: route_change\ndata: {\"route\":\"/pipelines\"}\n\n"], init?.signal as AbortSignal | undefined);
  };

  await new Promise<void>((resolve) => {
    let settled = false;
    let subA: { unsubscribe: () => void };
    let subB: { unsubscribe: () => void };
    const maybeResolve = () => {
      if (settled || receivedA.length !== 1 || receivedB.length !== 1) {
        return;
      }
      settled = true;
      subA.unsubscribe();
      subB.unsubscribe();
      resolve();
    };

    subA = subscribeConsoleState({
      sessionId: "shared-session",
      consoleUrl: "http://localhost:5173",
      fetchImpl,
      onEvent: (event) => {
        receivedA.push(String((event.data as Record<string, unknown>).route));
        maybeResolve();
      },
    });
    subB = subscribeConsoleState({
      sessionId: "shared-session",
      consoleUrl: "http://localhost:5173",
      fetchImpl,
      onEvent: (event) => {
        receivedB.push(String((event.data as Record<string, unknown>).route));
        maybeResolve();
      },
    });
  });

  assert.equal(fetchCount, 1);
  assert.deepEqual(receivedA, ["/pipelines"]);
  assert.deepEqual(receivedB, ["/pipelines"]);
});

test("subscribeConsoleState sends a presence heartbeat for the session", async () => {
  const requests: Array<{ url: string; method: string; sessionId: string; source?: string }> = [];

  await new Promise<void>((resolve) => {
    const subscription = subscribeConsoleState({
      sessionId: "heartbeat-session",
      consoleUrl: "https://staging.console.indexing.co",
      source: "codex-cli",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: String(init?.method),
          sessionId: String((init?.headers as Record<string, string>)["X-Session-Id"]),
          source: init?.body ? String(JSON.parse(String(init.body)).source) : undefined,
        });

        if (String(init?.method) === "POST") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return createOpenSseResponse(["event: route_change\ndata: {\"route\":\"/pipelines\"}\n\n"], init?.signal as AbortSignal | undefined);
      },
      onEvent: () => {
        subscription.unsubscribe();
        resolve();
      },
    });
  });

  assert.deepEqual(requests, [
    {
      url: "https://staging.console.indexing.co/api/state/stream",
      method: "GET",
      sessionId: "heartbeat-session",
      source: undefined,
    },
    {
      url: "https://staging.console.indexing.co/api/state/presence",
      method: "POST",
      sessionId: "heartbeat-session",
      source: "codex-cli",
    },
  ]);
});

test("resolveConsoleSessionId reads INDEXING_CO_SESSION_ID before the stored file", () => {
  const sessionId = resolveConsoleSessionId(undefined, {
    HOME: "/tmp/unused-home",
    INDEXING_CO_SESSION_ID: "env-session",
  });

  assert.equal(sessionId, "env-session");
});

test("resolveConsoleSessionId rejects path-like ids without echoing the value", () => {
  assert.throws(
    () =>
      resolveConsoleSessionId(undefined, {
        HOME: "/tmp/unused-home",
        INDEXING_CO_SESSION_ID: "/Users/example/.indexing-co/session-id",
      }),
    (error: unknown) => {
      if (!(error instanceof Error)) {
        return false;
      }
      const message = error.message;
      assert.match(message, /Invalid console session id/);
      assert.doesNotMatch(message, /Users|example|session-id/);
      return true;
    },
  );
});

test("resolveAgentSource only allows bounded safe slugs", () => {
  assert.equal(resolveAgentSource("codex-cli", {}), "codex-cli");
  assert.equal(resolveAgentSource("claude.code_1", {}), "claude.code_1");
  assert.equal(resolveAgentSource("/Users/example/token-from-argv", {}), "indexing-co-cli");
  assert.equal(resolveAgentSource("x".repeat(80), {}), "indexing-co-cli");
  assert.equal(
    resolveAgentSource(undefined, { INDEXING_CO_AGENT_SOURCE: "secret=value" }),
    "indexing-co-cli",
  );
});

test("subscribeConsoleState reconnects after transport errors", async () => {
  let attempts = 0;

  await new Promise<void>((resolve) => {
    const subscription = subscribeConsoleState({
      sessionId: "reconnect-session",
      consoleUrl: "http://localhost:5173",
      backoffMs: () => 0,
      fetchImpl: async (_input, init) => {
        if (init?.method === "GET") {
          attempts += 1;
        }
        if (init?.method === "GET" && attempts === 1) {
          throw new Error("connection refused");
        }
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return createOpenSseResponse(["event: field_focus\ndata: {\"field\":\"name\"}\n\n"], init?.signal as AbortSignal | undefined);
      },
      onEvent: (event) => {
        assert.equal(event.type, "field_focus");
        assert.equal((event.data as Record<string, unknown>).field, "name");
        subscription.unsubscribe();
        resolve();
      },
    });
  });

  assert.equal(attempts, 2);
});

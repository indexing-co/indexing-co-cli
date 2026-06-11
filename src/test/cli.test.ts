const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

import { createRootCommand } from "../commands";
import { runCli, renderHelp } from "../lib/runtime";

function createWriter() {
  let output = "";
  return {
    stream: {
      isTTY: false,
      write(chunk: string) {
        output += chunk;
      },
    },
    read() {
      return output;
    },
  };
}

function createSseResponse(chunks: string[], signal?: AbortSignal): Response {
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

test("root help includes core commands", async () => {
  const help = renderHelp(createRootCommand(), [], createRootCommand());
  assert.match(help, /pipeline/);
  assert.match(help, /transformation/);
  assert.match(help, /stream/);
});

test("config command prints resolved config", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));
  const exitCode = await runCli(createRootCommand(), ["config"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      HOME: home,
      INDEXING_CO_API_KEY: "test-secret-key",
    },
  });

  assert.equal(exitCode, 0);
  const output = stdout.read();
  assert.match(output, /Resolved config/);
  assert.match(output, /test\.\.\.-key/);
  assert.doesNotMatch(output, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(output, /credentialsPath|statePath|cwd/);
});

test("pipeline list emits json when requested", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));

  const exitCode = await runCli(createRootCommand(), ["pipeline", "list", "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      HOME: home,
      INDEXING_CO_API_KEY: "test-key",
    },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              name: "demo",
              transformation: "x",
              filter: "y",
              networks: ["BASE"],
              enabled: true,
              delivery: { adapter: "POSTGRES" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout.read());
  assert.equal(parsed.data[0].name, "demo");
});

test("transformation test uses multipart code upload and indexed filter keys", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ico-cwd-"));
  fs.writeFileSync(path.join(cwd, "transform.js"), "function transform(block) { return []; }\n");
  const requests: Array<{ url: string; body: unknown; contentType?: string }> = [];

  const exitCode = await runCli(
    createRootCommand(),
    [
      "transformation",
      "test",
      "--code",
      "transform.js",
      "--network",
      "arbitrum",
      "--beat",
      "469228268",
      "--filter",
      "arbitrum-dex-swaps-demo-filter",
      "--filter-key",
      "contract_address",
      "--filter-key",
      "pool_address",
    ],
    {
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {
        HOME: home,
        INDEXING_CO_API_KEY: "test-key",
      },
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          body: init?.body,
          contentType: (init?.headers as Record<string, string>)["Content-Type"],
        });
        return new Response(JSON.stringify([{ ok: true }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://app.indexing.co/dw/transformations/test?network=arbitrum&beat=469228268&filter=arbitrum-dex-swaps-demo-filter&filterKeys%5B0%5D=contract_address&filterKeys%5B1%5D=pool_address",
  );
  assert.equal(requests[0].contentType, undefined);
  assert.ok(requests[0].body instanceof FormData);
  const codePart = (requests[0].body as FormData).get("code");
  if (!(codePart instanceof Blob)) {
    throw new Error("Expected code form part to be a Blob.");
  }
  assert.equal(await codePart.text(), "function transform(block) { return []; }\n");
});

test("mutation commands post agent activity when a console session is configured", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ico-cwd-"));
  fs.writeFileSync(path.join(cwd, "delivery.json"), JSON.stringify({ adapter: "HTTP", url: "https://example.test/hook" }));
  const activityRequests: Array<Record<string, unknown>> = [];

  const exitCode = await runCli(
    createRootCommand(),
    [
      "pipeline",
      "create",
      "demo_pipeline",
      "--filter",
      "demo_filter",
      "--filter-key",
      "token_address",
      "--transformation",
      "demo_transform",
      "--network",
      "ARBITRUM",
      "--destination",
      "@delivery.json",
    ],
    {
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {
        HOME: home,
        INDEXING_CO_API_KEY: "test-key",
        INDEXING_CO_SESSION_ID: "11111111-1111-4111-8111-111111111111",
        INDEXING_CO_AGENT_SOURCE: "worker-agent",
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url === "https://app.indexing.co/dw/pipelines") {
          return new Response(JSON.stringify({ message: "created" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url === "https://console.indexing.co/api/session/event") {
          activityRequests.push({
            sessionId: (init?.headers as Record<string, string>)["X-Session-Id"],
            body: JSON.parse(String(init?.body)),
          });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(activityRequests.length, 1);
  assert.equal(activityRequests[0].sessionId, "11111111-1111-4111-8111-111111111111");
  const payload = activityRequests[0].body as Record<string, unknown>;
  assert.equal(payload.type, "agent_event");
  const data = payload.data as Record<string, unknown>;
  assert.equal(data.actor, "agent");
  assert.equal(data.type, "deploy_pipeline");
  assert.deepEqual(data.target, { id: "demo_pipeline", name: "demo_pipeline", type: "pipeline" });
  assert.equal((data.metadata as Record<string, unknown>).agentName, "worker-agent");
  assert.equal((data.metadata as Record<string, unknown>).networkCount, 1);
  assert.doesNotMatch(JSON.stringify(payload), /test-key|example\.test\/hook/);
});

test("resource mutations map to console activity event types", async () => {
  const cases = [
    {
      argv: ["filter", "create", "demo_filter", "--values", "0xabc"],
      engineUrl: "https://app.indexing.co/dw/filters/demo_filter",
      expectedType: "create_filter",
      expectedTarget: { id: "demo_filter", name: "demo_filter", type: "filter" },
    },
    {
      argv: ["transformation", "register", "demo_transform", "--code", "transform.js"],
      engineUrl: "https://app.indexing.co/dw/transformations/demo_transform",
      expectedType: "create_transformation",
      expectedTarget: { id: "demo_transform", name: "demo_transform", type: "transformation" },
      files: { "transform.js": "function transform() { return []; }\n" },
    },
    {
      argv: ["pipeline", "delete", "demo_pipeline"],
      engineUrl: "https://app.indexing.co/dw/pipelines/demo_pipeline",
      expectedType: "pause_pipeline",
      expectedTarget: { id: "demo_pipeline", name: "demo_pipeline", type: "pipeline" },
    },
  ];

  for (const testCase of cases) {
    const stdout = createWriter();
    const stderr = createWriter();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ico-cwd-"));
    for (const [name, contents] of Object.entries(testCase.files || {})) {
      fs.writeFileSync(path.join(cwd, name), contents);
    }
    const activityRequests: Array<Record<string, unknown>> = [];

    const exitCode = await runCli(createRootCommand(), testCase.argv, {
      cwd,
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {
        HOME: home,
        INDEXING_CO_API_KEY: "test-key",
        INDEXING_CO_SESSION_ID: "11111111-1111-4111-8111-111111111111",
      },
      fetchImpl: async (input, init) => {
        const url = String(input);
        if (url === testCase.engineUrl) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (url === "https://console.indexing.co/api/session/event") {
          activityRequests.push({ body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        throw new Error(`Unexpected request: ${url}`);
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(activityRequests.length, 1);
    const data = (activityRequests[0].body as Record<string, unknown>).data as Record<string, unknown>;
    assert.equal(data.type, testCase.expectedType);
    assert.deepEqual(data.target, testCase.expectedTarget);
  }
});

test("mutation commands skip activity reporting when no console session is configured", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));
  const activityRequests: unknown[] = [];

  const exitCode = await runCli(createRootCommand(), ["filter", "create", "demo_filter", "--values", "0xabc"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      HOME: home,
      INDEXING_CO_API_KEY: "test-key",
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url === "https://app.indexing.co/dw/filters/demo_filter") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (String(init?.method) === "POST" && url.includes("/api/session/event")) {
        activityRequests.push({ input, init });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(activityRequests.length, 0);
});

test("completion command prints a bash script", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const exitCode = await runCli(createRootCommand(), ["completion", "bash"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.read(), /complete -F _indexing_co_complete/);
});

test("agent state errors clearly when no session id is available", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));

  const exitCode = await runCli(createRootCommand(), ["agent", "state"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { HOME: home },
  });

  assert.equal(exitCode, 2);
  assert.match(stderr.read(), /No session id available\. Pass --session/);
});

test("agent watch prefers explicit session id over the stored file", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));
  const configDir = path.join(home, ".indexing-co");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "session-id"), "file-session\n");
  let headerValue = "";

  const exitCode = await runCli(createRootCommand(), ["agent", "watch", "--session", "flag-session", "--once"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { HOME: home },
    fetchImpl: async (_input, init) => {
      headerValue = String((init?.headers as Record<string, string>)["X-Session-Id"]);
      return createSseResponse(["event: route_change\ndata: {\"type\":\"route_change\",\"path\":\"/pipelines\",\"ts\":\"2026-05-18T12:00:00.000Z\"}\n\n"], init?.signal as AbortSignal | undefined);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(headerValue, "flag-session");
  assert.match(stdout.read(), /route_change route=\/pipelines/);
});

test("agent watch sends the configured source in presence heartbeats", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));
  let heartbeatSource = "";

  const exitCode = await runCli(createRootCommand(), ["agent", "watch", "--once", "--source", "codex-cli"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      HOME: home,
      INDEXING_CO_SESSION_ID: "env-session",
    },
    fetchImpl: async (_input, init) => {
      if (String(init?.method) === "POST") {
        heartbeatSource = String(JSON.parse(String(init?.body)).source);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return createSseResponse(["event: route_change\ndata: {\"type\":\"route_change\",\"path\":\"/builder\",\"ts\":\"2026-05-18T12:00:00.000Z\"}\n\n"], init?.signal as AbortSignal | undefined);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(heartbeatSource, "codex-cli");
  assert.match(stdout.read(), /route_change route=\/builder/);
});

test("agent watch does not send unsafe source values in presence heartbeats", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));
  let heartbeatSource = "";

  const exitCode = await runCli(createRootCommand(), ["agent", "watch", "--once", "--source", "/Users/example/.ssh/token"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      HOME: home,
      INDEXING_CO_SESSION_ID: "env-session",
    },
    fetchImpl: async (_input, init) => {
      if (String(init?.method) === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        heartbeatSource = String(body.source);
        assert.deepEqual(Object.keys(body), ["source"]);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return createSseResponse(["event: route_change\ndata: {\"type\":\"route_change\",\"path\":\"/builder\",\"ts\":\"2026-05-18T12:00:00.000Z\"}\n\n"], init?.signal as AbortSignal | undefined);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(heartbeatSource, "indexing-co-cli");
  assert.doesNotMatch(heartbeatSource, /Users|example|token/);
});

test("agent doctor reports connected console pairing", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));
  const requests: string[] = [];

  const exitCode = await runCli(createRootCommand(), ["agent", "doctor", "--session", "01234567-89ab-7def-0123-456789abcdef", "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { HOME: home },
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);

      if (url.endsWith("/api/state/presence")) {
        return new Response(JSON.stringify({
          connected: true,
          lastSeenAt: "2026-06-10T20:00:00.000Z",
          source: "codex-cli",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.endsWith("/api/state/current")) {
        return new Response(JSON.stringify({ route: "/builder", builder: { selectedChains: ["ARBITRUM"] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/agent/events/current")) {
        return new Response(JSON.stringify({ agentEvents: [{ type: "test_transformation" }], agentProposals: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 3);
  const parsed = JSON.parse(stdout.read());
  assert.equal(parsed.connected, true);
  assert.equal(parsed.railStatus, "Agent connected (codex-cli)");
  assert.deepEqual(parsed.warnings, []);
});

test("agent doctor warns when activity exists without presence", async () => {
  const stdout = createWriter();
  const stderr = createWriter();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ico-home-"));

  const exitCode = await runCli(createRootCommand(), ["agent", "doctor", "--session", "01234567-89ab-7def-0123-456789abcdef"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { HOME: home },
    fetchImpl: async (input) => {
      const url = String(input);

      if (url.endsWith("/api/state/presence")) {
        return new Response(JSON.stringify({ connected: false, lastSeenAt: null, source: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/state/current")) {
        return new Response(JSON.stringify({ route: "/builder" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/api/agent/events/current")) {
        return new Response(JSON.stringify({ agentEvents: [{ type: "test_transformation" }], agentProposals: [{ id: "p1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assert.equal(exitCode, 1);
  const output = stdout.read();
  assert.match(output, /railStatus: BYO Agent setup\/disconnected/);
  assert.match(output, /proposal/);
  assert.match(output, /activity events/);
  assert.match(output, /agent watch --session/);
});

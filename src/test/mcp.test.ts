const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

import { createMcpServer } from "../mcp/server";
import { openEventStore } from "../mcp/storage";
import { StreamClient } from "../mcp/stream";
import { getBundledSkillPath, installSkill } from "../lib/skill";

function hasNodeSqlite(): boolean {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

const skipWithoutSqlite = hasNodeSqlite() ? false : "node:sqlite unavailable on this Node version";

async function connectClient(fetchImpl: typeof fetch) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ico-mcp-"));
  const store = openEventStore(path.join(dir, "events.db"));
  const server = createMcpServer(
    {
      apiKey: "test-key",
      baseUrl: "https://api.example.test/dw",
      dbPath: store.path,
      version: "0.0.0-test",
      userAgent: "test",
      stderr: { write() {} },
      fetchImpl,
    },
    new StreamClient(""),
    store,
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    store,
    async close() {
      await client.close();
      await server.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("mcp server exposes every tool the standalone indexing-co-mcp shipped", { skip: skipWithoutSqlite }, async () => {
  const ctx = await connectClient(fetch);
  try {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((tool: { name: string }) => tool.name).sort();
    assert.deepEqual(names, [
      "backfill",
      "chart",
      "clear_events",
      "create_filter",
      "create_pipeline",
      "create_transformation",
      "delete_filter_values",
      "delete_pipeline",
      "describe_data",
      "get_events",
      "get_filter",
      "get_pipeline",
      "get_status",
      "get_subscriptions",
      "get_transformation",
      "list_filters",
      "list_pipelines",
      "list_transformations",
      "query",
      "subscribe",
      "test_transformation",
      "unsubscribe",
    ]);
  } finally {
    await ctx.close();
  }
});

test("mcp event store round-trips through query, describe_data and chart", { skip: skipWithoutSqlite }, async () => {
  const ctx = await connectClient(fetch);
  try {
    ctx.store.insertEvents("transfers", [
      { amount: 5, token: { symbol: "USDC" } },
      { amount: 7, token: { symbol: "USDC" } },
    ]);

    const query = await ctx.client.callTool({
      name: "query",
      arguments: { sql: "SELECT json_extract(data, '$.amount') AS amount FROM events ORDER BY id" },
    });
    assert.deepEqual(JSON.parse(query.content[0].text), { columns: ["amount"], rows: [{ amount: 5 }, { amount: 7 }] });

    const describe = await ctx.client.callTool({ name: "describe_data", arguments: { channel: "transfers" } });
    const described = JSON.parse(describe.content[0].text);
    assert.equal(described.totalEvents, 2);
    assert.ok(described.sampleKeys.some((key: { key: string }) => key.key === "token.symbol"));

    const writeRejected = await ctx.client.callTool({ name: "query", arguments: { sql: "DELETE FROM events" } });
    assert.equal(writeRejected.isError, true);

    const chart = await ctx.client.callTool({
      name: "chart",
      arguments: { type: "sparkline", sql: "SELECT json_extract(data, '$.amount') AS amount FROM events" },
    });
    assert.equal(chart.isError, undefined);

    const cleared = await ctx.client.callTool({ name: "clear_events", arguments: { channel: "transfers" } });
    assert.match(cleared.content[0].text, /Cleared 2 events/);
  } finally {
    await ctx.close();
  }
});

test("mcp api tools send the api key to the configured base url", { skip: skipWithoutSqlite }, async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ data: [{ name: "p1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const ctx = await connectClient(fakeFetch);
  try {
    const result = await ctx.client.callTool({ name: "list_pipelines", arguments: {} });
    assert.deepEqual(JSON.parse(result.content[0].text), { data: [{ name: "p1" }] });
    assert.equal(calls[0].url, "https://api.example.test/dw/pipelines");
    assert.equal(calls[0].headers["X-API-KEY"], "test-key");
  } finally {
    await ctx.close();
  }
});

test("skill install copies the bundled SKILL.md and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ico-skill-"));
  try {
    const destination = path.join(dir, "indexing-co-pipelines", "SKILL.md");
    assert.equal(installSkill(destination).status, "installed");
    assert.equal(fs.readFileSync(destination, "utf8"), fs.readFileSync(getBundledSkillPath(), "utf8"));
    assert.equal(installSkill(destination).status, "unchanged");

    fs.writeFileSync(destination, "stale");
    assert.equal(installSkill(destination).status, "updated");
    assert.match(fs.readFileSync(destination, "utf8"), /^---\nname: indexing-co-pipelines/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

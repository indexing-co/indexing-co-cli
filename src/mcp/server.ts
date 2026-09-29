import { ApiClient } from "./api";
import { openEventStore, type EventStore } from "./storage";
import { StreamClient } from "./stream";
import { registerTools } from "./tools";

export interface McpServerOptions {
  apiKey?: string;
  baseUrl: string;
  streamUrl?: string;
  dbPath: string;
  version: string;
  userAgent: string;
  stderr: { write: (chunk: string) => void };
  fetchImpl?: typeof fetch;
}

export interface McpServerHandle {
  server: any;
  stream: StreamClient;
  store: EventStore;
  close(): Promise<void>;
}

async function resolveStreamUrl(options: McpServerOptions, log: (msg: string) => void): Promise<string | undefined> {
  if (options.streamUrl) {
    return options.streamUrl;
  }
  if (!options.apiKey) {
    return undefined;
  }

  const res = await (options.fetchImpl || fetch)(`${options.baseUrl}/stream`, {
    headers: { "X-API-KEY": options.apiKey, "User-Agent": options.userAgent },
  });
  if (!res.ok) {
    // Pipeline tools still work without the stream; say so rather than dying.
    log(`WARNING: could not fetch the stream URL from ${options.baseUrl}/stream (${res.status}); streaming tools are disabled.`);
    return undefined;
  }
  return ((await res.json()) as { url?: string }).url;
}

export function createMcpServer(options: McpServerOptions, stream: StreamClient, store: EventStore): any {
  const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({ name: "indexing-co", version: options.version });
  const api = new ApiClient(options.baseUrl, options.apiKey, options.userAgent, options.fetchImpl);
  registerTools(server, stream, api, store);
  return server;
}

// Runs the MCP server on stdio. stdout belongs to the protocol from here on: log to stderr only.
export async function startMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
  const log = (msg: string) => options.stderr.write(`[indexing-co mcp] ${msg}\n`);

  const store = openEventStore(options.dbPath);
  log(`API: ${options.baseUrl} · events: ${store.path}`);

  const streamUrl = await resolveStreamUrl(options, log);
  const stream = new StreamClient(streamUrl ?? "");
  if (streamUrl) {
    await stream.connect();
    log(`Stream: ${streamUrl.replace(/\?.*/, "")}`);
  } else if (!options.apiKey) {
    log("No API key — tools will return setup instructions. Run `indexing-co auth login` or set INDEXING_CO_API_KEY.");
  }

  const server = createMcpServer(options, stream, store);
  const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
  await server.connect(new StdioServerTransport());
  log("MCP server running on stdio");

  return {
    server,
    stream,
    store,
    async close() {
      stream.disconnect();
      await server.close();
      store.close();
    },
  };
}

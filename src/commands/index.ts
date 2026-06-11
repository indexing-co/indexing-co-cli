const fs = require("node:fs");
const path = require("node:path");

import { ensureConfigDirectory, promptForApiKey, removeCredentialsFile, writeCredentialsFile } from "../lib/auth";
import { DEFAULT_BASE_URL, DEFAULT_CONSOLE_URL } from "../lib/constants";
import {
  getAgentPairingHealth,
  getCurrentUserState,
  reportAgentActivity,
  resolveAgentSource,
  resolveConsoleSessionId,
  subscribeConsoleState,
  type AgentPairingHealth,
  type AgentActivityEventInput,
  type ConsoleStateEvent,
} from "../lib/console-state";
import { CliError, EXIT_CODES } from "../lib/errors";
import { type ApiResponse, type RequestSpec } from "../lib/http";
import { type CommandDefinition, type CommandContext, getCompletionSuggestions } from "../lib/runtime";
import { loadState, recordStreamSession } from "../lib/state";
import { parseSubgraphManifest, summarizeSubgraphManifest } from "../lib/subgraph";
import { connectWebSocket, SimpleWebSocket } from "../lib/ws";
import {
  compactObject,
  ensureArray,
  escapeSqlIdentifier,
  escapeSqlString,
  flattenListPayload,
  formatDuration,
  formatRate,
  loadJsonValue,
  maskSecret,
  parseInteger,
  readTextFile,
  resolveFilePath,
  splitCsv,
  stringifyValue,
  unique,
} from "../lib/util";

function renderRecord(name: string, record: Record<string, unknown>) {
  return {
    data: record,
    human: {
      intro: name,
      lines: Object.entries(record).map(([key, value]) => `${key}: ${stringifyValue(value)}`),
    },
  };
}

function renderList(data: unknown, columns: { key: string; label?: string }[], intro?: string) {
  const rows = flattenListPayload(data).map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>) : { value: row }));
  return {
    data,
    human: {
      intro,
      table: { columns, rows },
    },
  };
}

async function requestFallback(context: CommandContext, specs: RequestSpec[]) {
  return await context.http.requestFirstAvailable(specs);
}

function requireOption(context: CommandContext, key: string, label = key): string {
  const value = context.options[key];
  if (!value) {
    throw new CliError(`Missing required option --${label}.`, EXIT_CODES.USAGE);
  }
  return String(value);
}

function optionValues(context: CommandContext, key: string): string[] {
  return splitCsv(ensureArray(context.options[key]).map((value) => String(value)));
}

function readCodeFromOption(context: CommandContext): string {
  const filePath = requireOption(context, "code");
  return readTextFile(resolveFilePath(context.cwd, filePath));
}

function readCodeFormDataFromOption(context: CommandContext): FormData {
  const filePath = requireOption(context, "code");
  const resolvedPath = resolveFilePath(context.cwd, filePath);
  const code = readTextFile(resolvedPath);
  const form = new FormData();
  form.append(
    "code",
    new Blob([code], { type: "application/javascript" }),
    path.basename(resolvedPath) || "transform.js",
  );
  return form;
}

function indexedQueryValues(key: string, values: string[]): Record<string, string> {
  return Object.fromEntries(values.map((value, index) => [`${key}[${index}]`, value]));
}

async function getPipeline(context: CommandContext, name: string): Promise<Record<string, unknown>> {
  const response = await context.http.get<Record<string, unknown>>(`/pipelines/${encodeURIComponent(name)}`);
  return response.data;
}

async function listPipelines(context: CommandContext): Promise<Record<string, unknown>[]> {
  const response = await context.http.get(`/pipelines`);
  return flattenListPayload(response.data) as Record<string, unknown>[];
}

async function listFiltersWithFallback(context: CommandContext): Promise<unknown> {
  try {
    const response = await requestFallback(context, [
      { method: "GET", path: "/filters" },
      { method: "GET", path: "/filters/list" },
    ]);
    return response.data;
  } catch (error) {
    const pipelines = await listPipelines(context);
    return unique(pipelines.map((pipeline) => String(pipeline.filter || "")).filter(Boolean)).map((name) => ({ name }));
  }
}

async function listTransformationsWithFallback(context: CommandContext): Promise<unknown> {
  try {
    const response = await requestFallback(context, [
      { method: "GET", path: "/transformations" },
      { method: "GET", path: "/transformations/list" },
    ]);
    return response.data;
  } catch {
    const pipelines = await listPipelines(context);
    return unique(pipelines.map((pipeline) => String(pipeline.transformation || "")).filter(Boolean)).map((name) => ({ name }));
  }
}

async function runSql(context: CommandContext, sql: string): Promise<ApiResponse> {
  return await requestFallback(context, [
    { method: "POST", path: "/query", body: { query: sql } },
    { method: "POST", path: "/query", body: { sql } },
    { method: "POST", path: "/sql", body: { query: sql } },
    { method: "POST", path: "/events/query", body: { query: sql } },
  ]);
}

async function recordAgentActivity(
  context: CommandContext,
  event: AgentActivityEventInput,
): Promise<void> {
  await reportAgentActivity({
    ...event,
    sessionId: context.options.session ? String(context.options.session) : undefined,
    consoleUrl: context.options.consoleUrl ? String(context.options.consoleUrl) : context.env.INDEXING_CO_CONSOLE_URL,
    source: context.options.source ? String(context.options.source) : undefined,
    env: context.env,
    fetchImpl: context.fetchImpl,
  });
}

async function resolvePipelineTable(context: CommandContext, pipelineName: string): Promise<string> {
  const pipeline = await getPipeline(context, pipelineName);
  const delivery = (pipeline.delivery || {}) as Record<string, unknown>;
  if (String(delivery.adapter || "").toUpperCase() !== "POSTGRES" || !delivery.table) {
    throw new CliError(
      `Pipeline "${pipelineName}" does not expose a Postgres table.`,
      EXIT_CODES.VALIDATION,
      { hint: "Use this command with a pipeline whose delivery.adapter is POSTGRES." },
    );
  }
  return String(delivery.table);
}

async function resolveStreamTarget(context: CommandContext, input: string): Promise<{ channel: string; url: string }> {
  if (input.startsWith("ws://") || input.startsWith("wss://")) {
    return { channel: input, url: input };
  }

  try {
    const pipeline = await getPipeline(context, input);
    const delivery = (pipeline.delivery || {}) as Record<string, unknown>;
    const channel = stringifyValue(delivery.connectionUri);
    if (String(delivery.adapter || "").toUpperCase() === "DIRECT" && channel) {
      return {
        channel,
        url: `${context.config.baseUrl.replace(/^http/, "ws")}/streams/${encodeURIComponent(channel)}`,
      };
    }
  } catch {
    // Treat the input as a direct stream channel if the pipeline lookup fails.
  }

  try {
    const response = await requestFallback(context, [
      { method: "GET", path: `/pipelines/${encodeURIComponent(input)}/stream` },
      { method: "GET", path: `/pipelines/${encodeURIComponent(input)}/stream-url` },
      { method: "GET", path: `/streams/${encodeURIComponent(input)}` },
    ]);
    const payload = response.data;
    if (typeof payload === "string" && payload.startsWith("ws")) {
      return { channel: input, url: payload };
    }
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const url = record.url || record.streamUrl || record.wsUrl;
      const channel = record.channel || record.connectionUri || input;
      if (typeof url === "string") {
        return { channel: String(channel), url };
      }
    }
  } catch {
    // Fall through to best-effort websocket candidates.
  }

  return {
    channel: input,
    url: `${context.config.baseUrl.replace(/^http/, "ws")}/streams/${encodeURIComponent(input)}`,
  };
}

function colorizeValue(value: unknown, enabled: boolean, depth = 0): string {
  if (!enabled) {
    return JSON.stringify(value, null, 2);
  }

  const magenta = "\u001b[35m";
  const blue = "\u001b[34m";
  const yellow = "\u001b[33m";
  const green = "\u001b[32m";
  const dim = "\u001b[2m";
  const reset = "\u001b[0m";
  const indent = "  ".repeat(depth);

  if (value === null) {
    return `${dim}null${reset}`;
  }

  if (typeof value === "string") {
    if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
      return `${magenta}${value}${reset}`;
    }
    if (/^0x[a-fA-F0-9]{64}$/.test(value)) {
      return `${blue}${value}${reset}`;
    }
    return `${green}${JSON.stringify(value)}${reset}`;
  }

  if (typeof value === "number") {
    return `${yellow}${value}${reset}`;
  }

  if (typeof value === "boolean") {
    return `${yellow}${value}${reset}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return `[\n${value.map((entry) => `${indent}  ${colorizeValue(entry, enabled, depth + 1)}`).join(",\n")}\n${indent}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return "{}";
    }
    return `{\n${entries
      .map(([key, entry]) => `${indent}  ${key}: ${colorizeValue(entry, enabled, depth + 1)}`)
      .join(",\n")}\n${indent}}`;
  }

  return String(value);
}

function truncateConsoleState(value: unknown, verbose: boolean): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (verbose || text.length <= 200) {
    return text;
  }
  return `${text.slice(0, 200)}...`;
}

function formatConsoleStateEvent(event: ConsoleStateEvent, verbose: boolean): string {
  const payload = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : undefined;

  if (event.type === "route_change") {
    return `route_change route=${stringifyValue(payload?.path)} ts=${stringifyValue(payload?.ts)}`.trim();
  }

  if (event.type === "field_focus") {
    return `field_focus field=${stringifyValue(payload?.fieldPath)} ts=${stringifyValue(payload?.ts)}`.trim();
  }

  if (event.type === "field_blur") {
    return `field_blur field=${stringifyValue(payload?.fieldPath)} ts=${stringifyValue(payload?.ts)}`.trim();
  }

  if (event.type === "state_snapshot") {
    return `state_snapshot ${truncateConsoleState(event.data, verbose)}`;
  }

  return `${event.type} ${truncateConsoleState(event.data, verbose)}`.trim();
}

function formatAgentPairingHealth(health: AgentPairingHealth): string {
  const lines = [
    "Console agent pairing",
    `railStatus: ${health.railStatus}`,
    `connected: ${health.connected ? "yes" : "no"}`,
    `source: ${health.source || "none"}`,
    `lastSeenAt: ${health.lastSeenAt || "none"}`,
    `route: ${typeof health.currentState?.route === "string" ? health.currentState.route : "unknown"}`,
    `agentEvents: ${Array.isArray(health.events?.agentEvents) ? health.events.agentEvents.length : "unknown"}`,
    `agentProposals: ${Array.isArray(health.events?.agentProposals) ? health.events.agentProposals.length : "unknown"}`,
  ];

  if (health.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of health.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function getCompletionScript(shell: string): string {
  if (shell === "bash") {
    return `#!/usr/bin/env bash
_indexing_co_complete() {
  local IFS=$'\\n'
  COMPREPLY=( $( "\${COMP_WORDS[0]}" __complete "\${COMP_WORDS[@]:1}" ) )
}
complete -F _indexing_co_complete indexing-co
complete -F _indexing_co_complete ico
`;
  }

  if (shell === "zsh") {
    return `#compdef indexing-co ico
_indexing_co_complete() {
  local -a completions
  completions=( $( "$words[1]" __complete "\${words[@]:1}" ) )
  _describe 'values' completions
}
compdef _indexing_co_complete indexing-co ico
`;
  }

  if (shell === "fish") {
    return `function __fish_indexing_co_complete
  set -l cmd (commandline -opc)
  set -e cmd[1]
  indexing-co __complete $cmd
end
complete -c indexing-co -f -a '(__fish_indexing_co_complete)'
complete -c ico -f -a '(__fish_indexing_co_complete)'
`;
  }

  throw new CliError("Unsupported shell. Expected bash, zsh, or fish.", EXIT_CODES.USAGE);
}

export function createRootCommand(): CommandDefinition {
  const root: CommandDefinition = {
    name: "indexing-co",
    summary: "Manage Indexing Co pipelines, filters, transformations, queries, and live streams.",
    description: "The primary CLI surface for Indexing Co. Human-readable tables by default, JSON output for automation via --json.",
    children: [],
    examples: [
      "indexing-co pipeline list",
      "indexing-co pipeline create transfers --filter usdc --filter-key contract_address --transformation usdc-transfers --network base --destination @delivery.json",
      "indexing-co transformation test --code ./transform.js --network BASE --beat 25384920",
      "indexing-co stream my-direct-pipeline --colorize",
    ],
  };

  root.children = [
    {
      name: "pipeline",
      summary: "Manage distributed pipelines.",
      children: [
        {
          name: "list",
          summary: "List active pipelines.",
          examples: ["indexing-co pipeline list", "indexing-co pipeline list --json"],
          execute: async (context) =>
            renderList(await context.http.get("/pipelines").then((response) => response.data), [
              { key: "name" },
              { key: "transformation" },
              { key: "filter" },
              { key: "networks" },
              { key: "enabled" },
              { key: "delivery", label: "delivery" },
            ], "Active pipelines"),
        },
        {
          name: "get",
          summary: "Get a pipeline by name.",
          args: [{ name: "name", required: true }],
          examples: ["indexing-co pipeline get my-pipeline", "indexing-co pipeline get my-pipeline --json"],
          execute: async (context) => renderRecord(`Pipeline ${context.args[0]}`, await getPipeline(context, context.args[0])),
        },
        {
          name: "create",
          summary: "Create or update a pipeline.",
          args: [{ name: "name", required: true }],
          options: [
            { name: "from-config", description: "Read the full pipeline payload from a JSON file.", type: "string" },
            { name: "filter", description: "Filter name.", type: "string" },
            { name: "filter-key", description: "Filter key(s). Repeat or pass comma-separated values.", type: "string", multiple: true },
            { name: "transformation", description: "Transformation name.", type: "string" },
            { name: "network", description: "Network key(s). Repeat or pass comma-separated values.", type: "string", multiple: true },
            { name: "destination", description: "Delivery JSON or @path-to-json.", type: "string" },
            { name: "disabled", description: "Create the pipeline in a disabled state.", type: "boolean" },
          ],
          examples: [
            "indexing-co pipeline create usdc-transfers --filter usdc --filter-key contract_address --transformation usdc-transform --network BASE --destination @delivery.json",
            "indexing-co pipeline create aave --from-config ./pipeline.json",
          ],
          execute: async (context) => {
            const name = context.args[0];
            let payload: Record<string, unknown>;

            if (context.options.fromConfig) {
              payload = loadJsonValue(String(context.options.fromConfig), context.cwd) as Record<string, unknown>;
            } else {
              payload = {
                name,
                filter: requireOption(context, "filter"),
                filterKeys: optionValues(context, "filterKey"),
                transformation: requireOption(context, "transformation"),
                networks: optionValues(context, "network"),
                delivery: loadJsonValue(requireOption(context, "destination"), context.cwd),
                enabled: !context.options.disabled,
              };
            }

            payload.name = name;

            if (!payload.filter || !payload.transformation || !Array.isArray(payload.filterKeys) || !Array.isArray(payload.networks) || !payload.delivery) {
              throw new CliError(
                "A pipeline requires name, filter, filterKeys, transformation, networks, and delivery.",
                EXIT_CODES.USAGE,
              );
            }

            const response = await context.http.post("/pipelines", payload);
            await recordAgentActivity(context, {
              type: "deploy_pipeline",
              target: { id: name, name, type: "pipeline" },
              metadata: compactObject({
                filter: payload.filter,
                transformation: payload.transformation,
                filterKeyCount: Array.isArray(payload.filterKeys) ? payload.filterKeys.length : undefined,
                networkCount: Array.isArray(payload.networks) ? payload.networks.length : undefined,
                networks: Array.isArray(payload.networks) ? payload.networks.map(String) : undefined,
                enabled: payload.enabled,
              }),
            });
            return renderRecord(`Pipeline ${name} saved`, {
              name,
              message: (response.data as Record<string, unknown>)?.message || "Pipeline created or updated.",
            });
          },
        },
        {
          name: "delete",
          summary: "Disable a pipeline.",
          args: [{ name: "name", required: true }],
          examples: ["indexing-co pipeline delete my-pipeline"],
          execute: async (context) => {
            const response = await context.http.delete(`/pipelines/${encodeURIComponent(context.args[0])}`);
            await recordAgentActivity(context, {
              type: "pause_pipeline",
              target: { id: context.args[0], name: context.args[0], type: "pipeline" },
            });
            return renderRecord(`Pipeline ${context.args[0]} disabled`, response.data as Record<string, unknown>);
          },
        },
        {
          name: "backfill",
          summary: "Backfill a pipeline over a block range.",
          args: [{ name: "name", required: true }],
          options: [
            { name: "network", description: "Network key to backfill.", type: "string" },
            { name: "value", description: "Optional filter value.", type: "string" },
            { name: "beat-start", description: "Start block/beat.", type: "number" },
            { name: "beat-end", description: "End block/beat.", type: "number" },
            { name: "beat", description: "Specific beat(s). Repeatable.", type: "number", multiple: true },
          ],
          examples: ["indexing-co pipeline backfill transfers --network BASE --beat-start 100 --beat-end 200"],
          execute: async (context) => {
            const body = compactObject({
              network: requireOption(context, "network"),
              value: context.options.value ? String(context.options.value) : undefined,
              beatStart: context.options.beatStart,
              beatEnd: context.options.beatEnd,
              beats: ensureArray(context.options.beat).map((beat) => Number(beat)),
            });

            if (!body.beatStart && !body.beatEnd && (!Array.isArray(body.beats) || body.beats.length === 0)) {
              throw new CliError("Provide --beat-start/--beat-end or at least one --beat.", EXIT_CODES.USAGE);
            }

            const response = await context.http.post(`/pipelines/${encodeURIComponent(context.args[0])}/backfill`, body);
            return renderRecord(`Backfill started for ${context.args[0]}`, response.data as Record<string, unknown>);
          },
        },
        {
          name: "networks",
          summary: "Add or remove pipeline networks.",
          children: [
            {
              name: "add",
              summary: "Enable one or more networks on a pipeline.",
              args: [{ name: "name", required: true }, { name: "network", required: true, variadic: true }],
              execute: async (context) => {
                const response = await context.http.post(`/pipelines/${encodeURIComponent(context.args[0])}/networks`, {
                  networks: context.args.slice(1),
                });
                await recordAgentActivity(context, {
                  type: "resume_pipeline",
                  target: { id: context.args[0], name: context.args[0], type: "pipeline" },
                  metadata: { networks: context.args.slice(1), networkCount: context.args.length - 1 },
                });
                return renderRecord(`Networks enabled for ${context.args[0]}`, response.data as Record<string, unknown>);
              },
            },
            {
              name: "remove",
              summary: "Disable one or more networks on a pipeline.",
              args: [{ name: "name", required: true }, { name: "network", required: true, variadic: true }],
              execute: async (context) => {
                const response = await requestFallback(context, [
                  {
                    method: "DELETE",
                    path: `/pipelines/${encodeURIComponent(context.args[0])}/networks`,
                    body: { networks: context.args.slice(1) },
                  },
                  {
                    method: "DELETE",
                    path: `/pipelines/${encodeURIComponent(context.args[0])}/networks/disable`,
                    body: { networks: context.args.slice(1) },
                  },
                ]);
                await recordAgentActivity(context, {
                  type: "pause_pipeline",
                  target: { id: context.args[0], name: context.args[0], type: "pipeline" },
                  metadata: { networks: context.args.slice(1), networkCount: context.args.length - 1 },
                });
                return renderRecord(`Networks disabled for ${context.args[0]}`, response.data as Record<string, unknown>);
              },
            },
          ],
        },
      ],
    },
    {
      name: "filter",
      summary: "Manage filters.",
      children: [
        {
          name: "list",
          summary: "List filters.",
          execute: async (context) => renderList(await listFiltersWithFallback(context), [{ key: "name" }, { key: "value" }], "Filters"),
        },
        {
          name: "get",
          summary: "Get filter values.",
          args: [{ name: "name", required: true }],
          options: [
            { name: "page-token", description: "Pagination token.", type: "string" },
            { name: "prefix", description: "Optional value prefix.", type: "string" },
          ],
          execute: async (context) => {
            const response = await context.http.get(`/filters/${encodeURIComponent(context.args[0])}`, compactObject({
              pageToken: context.options.pageToken,
              prefix: context.options.prefix,
            }));
            return {
              data: response.data,
              human: {
                intro: `Filter ${context.args[0]}`,
                lines: [`nextPageToken: ${stringifyValue((response.data as Record<string, unknown>)?.metadata || {})}`],
                table: {
                  columns: [{ key: "value" }],
                  rows: flattenListPayload((response.data as Record<string, unknown>).data || response.data).map((value) => ({ value })),
                },
              },
            };
          },
        },
        {
          name: "create",
          summary: "Create a filter and optionally seed values.",
          args: [{ name: "name", required: true }],
          options: [{ name: "values", description: "One or more filter values.", type: "string", multiple: true }],
          execute: async (context) => {
            const values = optionValues(context, "values");
            const response = await context.http.post(`/filters/${encodeURIComponent(context.args[0])}`, {
              values,
            });
            await recordAgentActivity(context, {
              type: "create_filter",
              target: { id: context.args[0], name: context.args[0], type: "filter" },
              metadata: { addressCount: values.length, valueCount: values.length },
            });
            return renderRecord(`Filter ${context.args[0]} saved`, response.data as Record<string, unknown>);
          },
        },
        {
          name: "add",
          summary: "Add a value to a filter.",
          args: [{ name: "name", required: true }, { name: "value", required: true }],
          execute: async (context) => {
            const response = await context.http.post(`/filters/${encodeURIComponent(context.args[0])}`, {
              values: [context.args[1]],
            });
            await recordAgentActivity(context, {
              type: "update_filter",
              target: { id: context.args[0], name: context.args[0], type: "filter" },
              metadata: { valueCount: 1 },
            });
            return renderRecord(`Value added to ${context.args[0]}`, response.data as Record<string, unknown>);
          },
        },
        {
          name: "remove",
          summary: "Remove a value from a filter.",
          args: [{ name: "name", required: true }, { name: "value", required: true }],
          execute: async (context) => {
            const response = await context.http.delete(`/filters/${encodeURIComponent(context.args[0])}`, {
              values: [context.args[1]],
            });
            await recordAgentActivity(context, {
              type: "update_filter",
              target: { id: context.args[0], name: context.args[0], type: "filter" },
              metadata: { valueCount: 1 },
            });
            return renderRecord(`Value removed from ${context.args[0]}`, response.data as Record<string, unknown>);
          },
        },
      ],
    },
    {
      name: "transformation",
      summary: "Manage transformation code.",
      children: [
        {
          name: "list",
          summary: "List transformations.",
          execute: async (context) => renderList(await listTransformationsWithFallback(context), [{ key: "name" }, { key: "value" }], "Transformations"),
        },
        {
          name: "get",
          summary: "Get a transformation by name.",
          args: [{ name: "name", required: true }],
          execute: async (context) => {
            const response = await context.http.get(`/transformations/${encodeURIComponent(context.args[0])}`);
            const code = typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2);
            return {
              data: { name: context.args[0], code },
              human: {
                raw: `${code}\n`,
              },
            };
          },
        },
        {
          name: "register",
          summary: "Register or update transformation code.",
          args: [{ name: "name", required: true }],
          options: [{ name: "code", description: "Path to a JavaScript transformation file.", type: "string" }],
          execute: async (context) => {
            const code = readCodeFromOption(context);
            const response = await context.http.post(`/transformations/${encodeURIComponent(context.args[0])}`, {
              code,
            });
            await recordAgentActivity(context, {
              type: "create_transformation",
              target: { id: context.args[0], name: context.args[0], type: "transformation" },
              metadata: { codeBytes: Buffer.byteLength(code, "utf8") },
            });
            return renderRecord(`Transformation ${context.args[0]} saved`, response.data as Record<string, unknown>);
          },
        },
        {
          name: "test",
          summary: "Test transformation code against a live block.",
          options: [
            { name: "code", description: "Path to a JavaScript transformation file.", type: "string" },
            { name: "network", description: "Network key to test against.", type: "string" },
            { name: "beat", description: "Block/beat number to test.", type: "number" },
            { name: "filter", description: "Optional filter name.", type: "string" },
            { name: "filter-key", description: "Optional filter key(s).", type: "string", multiple: true },
          ],
          execute: async (context) => {
            const response = await context.http.post(
              "/transformations/test",
              readCodeFormDataFromOption(context),
              compactObject({
                network: requireOption(context, "network"),
                beat: parseInteger("beat", context.options.beat),
                filter: context.options.filter,
                ...indexedQueryValues("filterKeys", optionValues(context, "filterKey")),
              }),
            );

            const rows = flattenListPayload(response.data).map((entry, index) => ({ index, payload: entry }));
            await recordAgentActivity(context, {
              type: "test_transformation",
              target: {
                id: context.options.filter ? String(context.options.filter) : "inline-transformation",
                name: context.options.filter ? String(context.options.filter) : "inline transformation",
                type: "transformation",
              },
              metadata: compactObject({
                blockNumber: parseInteger("beat", context.options.beat),
                chainId: context.options.network ? String(context.options.network) : undefined,
                rowCount: rows.length,
              }),
            });
            return {
              data: response.data,
              human: {
                intro: "Transformation test results",
                table: {
                  columns: [{ key: "index" }, { key: "payload" }],
                  rows,
                },
              },
            };
          },
        },
      ],
    },
    {
      name: "stream",
      summary: "Stream DIRECT pipeline events.",
      args: [{ name: "pipeline", required: true }],
      options: [{ name: "colorize", description: "Render colorized event output.", type: "boolean" }],
      children: [
        {
          name: "subscriptions",
          summary: "List DIRECT pipelines available for streaming.",
          execute: async (context) => {
            const pipelines = await listPipelines(context);
            const rows = pipelines
              .map((pipeline) => {
                const delivery = (pipeline.delivery || {}) as Record<string, unknown>;
                return {
                  name: pipeline.name,
                  channel: delivery.connectionUri,
                  adapter: delivery.adapter,
                  enabled: pipeline.enabled,
                };
              })
              .filter((pipeline) => String(pipeline.adapter || "").toUpperCase() === "DIRECT");

            return {
              data: rows,
              human: {
                intro: "DIRECT stream subscriptions",
                table: { columns: [{ key: "name" }, { key: "channel" }, { key: "enabled" }], rows },
              },
            };
          },
        },
        {
          name: "status",
          summary: "Show the most recent stream session.",
          execute: async (context) => {
            const state = loadState(context.config.statePath);
            const latest = state.recentStreams[0];
            if (!latest) {
              return renderRecord("Stream status", {
                status: "No recorded stream sessions",
                statePath: context.config.statePath,
              });
            }

            return renderRecord("Most recent stream", latest as unknown as Record<string, unknown>);
          },
        },
      ],
      execute: async (context) => {
        const target = await resolveStreamTarget(context, context.args[0]);
        const startedAt = Date.now();
        const colorize = Boolean(context.options.colorize || context.stdout.isTTY);
        let eventCount = 0;
        let closing = false;

        await new Promise<void>(async (resolve, reject) => {
          let socketClient: SimpleWebSocket | null = null;
          const stop = (reason?: string) => {
            if (closing) {
              return;
            }
            closing = true;
            if (socketClient) {
              socketClient.close();
            }
            if (reason) {
              context.stderr.write(`${reason}\n`);
            }
            resolve();
          };

          const onSigint = () => stop();
          process.on("SIGINT", onSigint);

          try {
            socketClient = await connectWebSocket(
              target.url,
              compactObject({
                "X-API-KEY": context.config.apiKey,
              }) as Record<string, string>,
              {
                onMessage: (payload) => {
                  eventCount += 1;
                  try {
                    const parsed = JSON.parse(payload);
                    context.stdout.write(`${colorizeValue(parsed, colorize)}\n`);
                  } catch {
                    context.stdout.write(`${payload}\n`);
                  }
                },
                onClose: () => {
                  process.off("SIGINT", onSigint);
                  resolve();
                },
              },
            );
          } catch (error) {
            process.off("SIGINT", onSigint);
            reject(error);
          }
        });

        const duration = Date.now() - startedAt;
        const record = {
          pipeline: context.args[0],
          channel: target.channel,
          url: target.url,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          eventCount,
          lastEventAt: eventCount > 0 ? new Date().toISOString() : undefined,
        };
        recordStreamSession(context.config.statePath, record);

        return {
          data: record,
          human: {
            intro: "Stream summary",
            lines: [
              `channel: ${target.channel}`,
              `url: ${target.url}`,
              `events: ${eventCount}`,
              `duration: ${formatDuration(duration)}`,
              `throughput: ${formatRate(eventCount, duration)}`,
            ],
          },
        };
      },
    },
    {
      name: "query",
      summary: "Run a SQL query against indexed data.",
      args: [{ name: "sql", required: true, variadic: true }],
      examples: [
        "indexing-co query 'select * from my_table limit 10'",
        "indexing-co query 'select count(*) from my_table' --json",
      ],
      execute: async (context) => {
        const sql = context.args.join(" ");
        const response = await runSql(context, sql);
        const rows = flattenListPayload(response.data);
        return {
          data: response.data,
          human: Array.isArray(rows) && rows.length > 0 && typeof rows[0] === "object"
            ? {
                intro: "Query results",
                table: {
                  columns: Object.keys(rows[0] as Record<string, unknown>).map((key) => ({ key })),
                  rows: rows as Record<string, unknown>[],
                },
              }
            : {
                raw: `${JSON.stringify(response.data, null, 2)}\n`,
              },
        };
      },
    },
    {
      name: "events",
      summary: "Inspect stored pipeline events.",
      children: [
        {
          name: "get",
          summary: "Fetch recent rows for a pipeline's destination table.",
          args: [{ name: "pipeline", required: true }],
          options: [{ name: "limit", description: "Maximum rows to return.", type: "number" }],
          execute: async (context) => {
            const table = await resolvePipelineTable(context, context.args[0]);
            const limit = Number(context.options.limit || 10);
            const response = await runSql(context, `select * from ${escapeSqlIdentifier(table)} limit ${limit}`);
            const rows = flattenListPayload(response.data) as Record<string, unknown>[];
            return {
              data: response.data,
              human: {
                intro: `Recent events from ${table}`,
                table: {
                  columns: rows.length > 0 ? Object.keys(rows[0]).map((key) => ({ key })) : [{ key: "message" }],
                  rows: rows.length > 0 ? rows : [{ message: "No rows returned." }],
                },
              },
            };
          },
        },
      ],
    },
    {
      name: "data",
      summary: "Describe pipeline destination data.",
      children: [
        {
          name: "describe",
          summary: "Describe the Postgres table used by a pipeline.",
          args: [{ name: "pipeline", required: true }],
          execute: async (context) => {
            const table = await resolvePipelineTable(context, context.args[0]);
            const sql = `
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = ${escapeSqlString(table)}
order by ordinal_position
`.trim();
            const response = await runSql(context, sql);
            return {
              data: response.data,
              human: {
                intro: `Schema for ${table}`,
                table: {
                  columns: [{ key: "column_name" }, { key: "data_type" }, { key: "is_nullable" }],
                  rows: flattenListPayload(response.data) as Record<string, unknown>[],
                },
              },
            };
          },
        },
      ],
    },
    {
      name: "subgraph",
      summary: "Parse subgraph manifests locally.",
      children: [
        {
          name: "parse",
          summary: "Parse a subgraph manifest file.",
          args: [{ name: "manifest-path", required: true }],
          requiresAuth: false,
          execute: async (context) => {
            const manifestPath = resolveFilePath(context.cwd, context.args[0]);
            const contents = readTextFile(manifestPath);
            const manifest = parseSubgraphManifest(contents);
            const summary = summarizeSubgraphManifest(manifest, manifestPath);
            return {
              data: summary,
              human: {
                intro: `Parsed ${manifestPath}`,
                lines: [
                  `specVersion: ${stringifyValue(summary.specVersion)}`,
                  `schema: ${stringifyValue(summary.schema)}`,
                  `networks: ${stringifyValue(summary.networks)}`,
                  `dataSources: ${stringifyValue((summary.totals as Record<string, unknown>).dataSources)}`,
                  `templates: ${stringifyValue((summary.totals as Record<string, unknown>).templates)}`,
                  `handlers: ${stringifyValue((summary.totals as Record<string, unknown>).handlers)}`,
                ],
                table: {
                  columns: [{ key: "name" }, { key: "network" }, { key: "kind" }, { key: "address" }, { key: "handlerCount" }],
                  rows: (summary.dataSources as Record<string, unknown>[]),
                },
              },
            };
          },
        },
      ],
    },
    {
      name: "stablecoin",
      summary: "Inspect stablecoin coverage.",
      children: [
        {
          name: "list",
          summary: "List stablecoins, optionally filtered by chain.",
          // Served by the console (single source of truth — the same JSON
          // the console bundles), not the data-warehouse API. No key needed.
          requiresAuth: false,
          options: [
            { name: "chain", description: "Optional chain/network key.", type: "string" },
            { name: "console-url", description: "Override the console base URL.", type: "string" },
          ],
          execute: async (context) => {
            const consoleUrl = (
              (context.options.consoleUrl as string | undefined) ||
              context.env.INDEXING_CO_CONSOLE_URL ||
              DEFAULT_CONSOLE_URL
            ).replace(/\/$/, "");
            const chain = context.options.chain as string | undefined;
            const url = `${consoleUrl}/api/stablecoins${chain ? `?chain=${encodeURIComponent(chain)}` : ""}`;
            const fetchImpl = context.fetchImpl || fetch;
            const response = await fetchImpl(url, { headers: { accept: "application/json" } });
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              throw new CliError(
                `Stablecoin lookup failed with status ${response.status}.`,
                EXIT_CODES.NETWORK,
                { details: payload },
              );
            }
            const list = Array.isArray((payload as { stablecoins?: unknown[] })?.stablecoins)
              ? (payload as { stablecoins: unknown[] }).stablecoins
              : flattenListPayload(payload);
            const rows = list.map((row) => (row && typeof row === "object" ? row as Record<string, unknown> : { value: row }));
            return {
              data: payload,
              human: {
                intro: chain ? `Stablecoins on ${chain}` : "Stablecoins",
                table: {
                  columns: rows.length > 0 ? Object.keys(rows[0]).map((key) => ({ key })) : [{ key: "value" }],
                  rows,
                },
              },
            };
          },
        },
      ],
    },
    {
      name: "auth",
      summary: "Manage local API credentials.",
      children: [
        {
          name: "login",
          summary: "Write credentials to ~/.indexing-co/credentials.",
          requiresAuth: false,
          execute: async (context) => {
            ensureConfigDirectory(context.env);
            const apiKey = context.options.apiKey ? String(context.options.apiKey) : await promptForApiKey({ input: context.stdin, output: context.stdout });
            writeCredentialsFile(apiKey, context.config.credentialsPath);
            return renderRecord("Credentials saved", {
              saved: true,
              source: context.options.apiKey ? "--api-key" : "interactive prompt",
            });
          },
        },
        {
          name: "status",
          summary: "Show credential resolution status.",
          requiresAuth: false,
          execute: async (context) =>
            renderRecord("Credential status", {
              apiKey: maskSecret(context.config.apiKey),
              source: context.config.apiKeySource || "not configured",
              baseUrl: context.config.baseUrl,
            }),
        },
        {
          name: "logout",
          summary: "Delete the saved credentials file.",
          requiresAuth: false,
          execute: async (context) =>
            renderRecord("Credentials removed", {
              removed: removeCredentialsFile(context.config.credentialsPath),
            }),
        },
      ],
    },
    {
      name: "config",
      summary: "Show resolved CLI configuration.",
      requiresAuth: false,
      execute: async (context) => renderRecord("Resolved config", {
        baseUrl: context.config.baseUrl || DEFAULT_BASE_URL,
        apiKey: maskSecret(context.config.apiKey),
        apiKeySource: context.config.apiKeySource || "not configured",
      }),
    },
    {
      name: "completion",
      summary: "Print shell completion scripts.",
      args: [{ name: "shell", required: true }],
      requiresAuth: false,
      execute: async (context) => ({
        data: { shell: context.args[0] },
        human: { raw: getCompletionScript(context.args[0]) },
      }),
    },
    {
      name: "agent",
      summary: "Consume console state for agent workflows.",
      requiresAuth: false,
      children: [
        {
          name: "watch",
          summary: "Subscribe to the console state stream.",
          requiresAuth: false,
          options: [
            { name: "session", description: "Explicit console session id.", type: "string" },
            { name: "console-url", description: "Override the console base URL.", type: "string" },
            { name: "source", description: "Agent source shown in the console presence indicator.", type: "string" },
            { name: "verbose", description: "Print full state snapshot payloads.", type: "boolean" },
            { name: "once", description: "Print the next event and exit.", type: "boolean" },
          ],
          execute: async (context) => {
            const sessionId = resolveConsoleSessionId(context.options.session as string | undefined, context.env);
            const consoleUrl = (context.options.consoleUrl as string | undefined) || context.env.INDEXING_CO_CONSOLE_URL;
            const source = resolveAgentSource(context.options.source as string | undefined, context.env);
            const verbose = Boolean(context.options.verbose);
            const once = Boolean(context.options.once);

            if (context.format === "json" && !once) {
              throw new CliError("Streaming JSON output is only supported with --once.", EXIT_CODES.USAGE);
            }

            await new Promise<void>((resolve) => {
              let finished = false;
              let subscription = subscribeConsoleState({
                sessionId,
                consoleUrl,
                source,
                fetchImpl: context.fetchImpl,
                onEvent: (event) => {
                  if (context.format === "json") {
                    context.stdout.write(`${JSON.stringify(event)}\n`);
                  } else {
                    context.stdout.write(`${formatConsoleStateEvent(event, verbose)}\n`);
                  }

                  if (once) {
                    finish();
                  }
                },
                onTransportError: (error, status) => {
                  context.stderr.write(`Console state stream disconnected (${error.message}). Reconnecting in ${status.reconnectInMs}ms.\n`);
                },
              });

              const finish = () => {
                if (finished) {
                  return;
                }
                finished = true;
                subscription.unsubscribe();
                process.off("SIGINT", onSigint);
                resolve();
              };

              const onSigint = () => finish();
              process.on("SIGINT", onSigint);
            });

            return { data: { ok: true } };
          },
        },
        {
          name: "state",
          summary: "Fetch the current console state snapshot.",
          requiresAuth: false,
          options: [
            { name: "session", description: "Explicit console session id.", type: "string" },
            { name: "console-url", description: "Override the console base URL.", type: "string" },
          ],
          execute: async (context) => {
            const sessionId = resolveConsoleSessionId(context.options.session as string | undefined, context.env);
            const consoleUrl = (context.options.consoleUrl as string | undefined) || context.env.INDEXING_CO_CONSOLE_URL;
            const snapshot = await getCurrentUserState({ sessionId, consoleUrl, fetchImpl: context.fetchImpl });
            return {
              data: snapshot,
              human: {
                raw: `${JSON.stringify(snapshot, null, 2)}\n`,
              },
            };
          },
        },
        {
          name: "doctor",
          summary: "Check whether Console pairing is healthy.",
          requiresAuth: false,
          options: [
            { name: "session", description: "Explicit console session id.", type: "string" },
            { name: "console-url", description: "Override the console base URL.", type: "string" },
          ],
          execute: async (context) => {
            const sessionId = resolveConsoleSessionId(context.options.session as string | undefined, context.env);
            const consoleUrl = (context.options.consoleUrl as string | undefined) || context.env.INDEXING_CO_CONSOLE_URL;
            const health = await getAgentPairingHealth({ sessionId, consoleUrl, fetchImpl: context.fetchImpl });

            return {
              data: health,
              human: {
                raw: formatAgentPairingHealth(health),
              },
              exitCode: health.connected ? 0 : 1,
            };
          },
        },
      ],
      execute: async () => ({
        data: { error: "Use a subcommand: watch | state | doctor." },
        human: { raw: "Use a subcommand: watch | state | doctor.\n" },
        exitCode: 2,
      }),
    },
    {
      name: "hint",
      summary: "Emit a presentational hint to a connected console (mock for local dev).",
      requiresAuth: false,
      children: [
        {
          name: "emit",
          summary: "Emit a hint event to the configured hints endpoint.",
          args: [{ name: "type", required: true }],
          options: [
            { name: "target-kind", description: "Target kind (pipeline | filter | transformation).", type: "string" },
            { name: "target-id", description: "Target identifier within the chosen kind.", type: "string" },
            { name: "field", description: "Specific field on the target.", type: "string" },
            { name: "note", description: "Short human note describing what changed (shown in the BYO Agent feed).", type: "string" },
            { name: "ttl-ms", description: "How long the hint should remain visible (ms).", type: "number" },
            { name: "agent", description: "Agent name (e.g. claude-code, codex-cli).", type: "string" },
            { name: "url", description: "Override the hints endpoint URL.", type: "string" },
          ],
          requiresAuth: false,
          execute: async (context: CommandContext) => {
            const url =
              (context.options.url as string | undefined) ||
              process.env.INDEXING_CO_HINTS_URL ||
              `${DEFAULT_CONSOLE_URL}/api/hints/emit`;
            const body: Record<string, unknown> = {
              type: context.args[0],
              ts: new Date().toISOString(),
            };
            const targetKind = context.options.targetKind as string | undefined;
            const targetId = context.options.targetId as string | undefined;
            const field = context.options.field as string | undefined;
            if (targetKind || targetId || field) {
              body.target = compactObject({
                kind: targetKind,
                id: targetId,
                field,
              });
            }
            const ttl = context.options.ttlMs as number | undefined;
            if (ttl !== undefined) body.ttl_ms = ttl;
            const agent = context.options.agent as string | undefined;
            if (agent) body.agent = { name: agent };
            const note = context.options.note as string | undefined;
            if (note) body.note = note;

            const response = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            const text = await response.text();
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch {
              // keep raw text
            }
            return {
              data: { ok: response.ok, status: response.status, response: parsed, sent: body, url },
              human: response.ok
                ? { raw: `Hint sent to ${url} (status ${response.status})${note ? `: ${note}` : ""}.\n` }
                : { raw: `Hint emit failed: ${response.status} ${text}\n` },
              exitCode: response.ok ? 0 : 1,
            };
          },
        },
      ],
      execute: async () => ({
        data: { error: "Use a subcommand: emit." },
        human: { raw: "Use a subcommand: emit.\n" },
        exitCode: 2,
      }),
    },
    {
      name: "__complete",
      summary: "Internal shell completion helper.",
      hidden: true,
      args: [{ name: "word", variadic: true }],
      requiresAuth: false,
      execute: async (context) => {
        const suggestions = getCompletionSuggestions(context.rootCommand, context.args);
        return {
          data: suggestions,
          human: { raw: `${suggestions.join("\n")}\n` },
        };
      },
    },
  ];

  return root;
}

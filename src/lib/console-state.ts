const fs = require("node:fs");
const crypto = require("node:crypto");

import { DEFAULT_CONSOLE_URL, DEFAULT_HTTP_TIMEOUT_MS, DEFAULT_UPDATE_TIMEOUT_MS, getSessionIdPath } from "./constants";
import { CliError, EXIT_CODES } from "./errors";

export interface ConsoleStateSnapshot {
  route?: string;
  builder?: unknown;
  paymentBuilder?: unknown;
  lastFocus?: unknown;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface ConsoleStateEvent<T = unknown> {
  type: string;
  data: T;
  lastEventId?: string;
}

export interface ConsoleStateSubscriptionOptions {
  sessionId: string;
  consoleUrl?: string;
  source?: string;
  onEvent: (event: ConsoleStateEvent) => void;
  onTransportError?: (error: Error, context: { attempt: number; reconnectInMs: number }) => void;
  fetchImpl?: typeof fetch;
  backoffMs?: (attempt: number) => number;
}

export interface ConsoleStateSubscription {
  unsubscribe: () => void;
}

export type AgentActivityEventType =
  | "create_pipeline"
  | "update_pipeline"
  | "delete_pipeline"
  | "create_filter"
  | "update_filter"
  | "delete_filter"
  | "create_transformation"
  | "update_transformation"
  | "delete_transformation"
  | "test_transformation"
  | "deploy_pipeline"
  | "pause_pipeline"
  | "resume_pipeline";

export type AgentActivityTargetType = "pipeline" | "filter" | "transformation";

export interface AgentActivityEventInput {
  type: AgentActivityEventType;
  target: {
    id: string;
    name: string;
    type: AgentActivityTargetType;
  };
  metadata?: Record<string, unknown>;
}

export interface AgentActivityReportOptions extends AgentActivityEventInput {
  sessionId?: string;
  consoleUrl?: string;
  source?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface AgentPresenceSnapshot {
  connected: boolean;
  lastSeenAt: string | null;
  source: string | null;
  warning?: string;
  [key: string]: unknown;
}

export interface AgentEventsSnapshot {
  agentEvents: unknown[];
  agentProposals: unknown[];
  state?: unknown;
  [key: string]: unknown;
}

export interface AgentPairingHealth {
  connected: boolean;
  railStatus: string;
  source: string | null;
  lastSeenAt: string | null;
  warnings: string[];
  presence: AgentPresenceSnapshot;
  currentState: ConsoleStateSnapshot | null;
  events: AgentEventsSnapshot | null;
}

type Subscriber = {
  id: number;
  onEvent: (event: ConsoleStateEvent) => void;
  onTransportError?: (error: Error, context: { attempt: number; reconnectInMs: number }) => void;
};

type SharedConnection = {
  abortController: AbortController | null;
  attempt: number;
  connectPromise: Promise<void> | null;
  fetchImpl: typeof fetch;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  key: string;
  sessionId: string;
  source: string;
  stopped: boolean;
  subscribers: Map<number, Subscriber>;
  url: string;
  backoffMs: (attempt: number) => number;
};

let nextSubscriberId = 1;
const sharedConnections = new Map<string, SharedConnection>();
const PRESENCE_HEARTBEAT_MS = 10_000;
const DEFAULT_AGENT_SOURCE = "indexing-co-cli";
const SAFE_AGENT_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const ACTIVITY_SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/i;

function normalizeConsoleUrl(consoleUrl?: string): string {
  const url = (consoleUrl || process.env.INDEXING_CO_CONSOLE_URL || DEFAULT_CONSOLE_URL).trim();
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function normalizeAgentSource(source?: string): string {
  const value = (source || process.env.INDEXING_CO_AGENT_SOURCE || DEFAULT_AGENT_SOURCE).trim();
  return SAFE_AGENT_SOURCE_PATTERN.test(value) ? value : DEFAULT_AGENT_SOURCE;
}

function assertSafeSessionId(sessionId: string): string {
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new CliError(
      "Invalid console session id. Pass the session id shown in the console BYO Agent panel.",
      EXIT_CODES.USAGE,
    );
  }
  return sessionId;
}

function buildConsoleUrl(consoleUrl: string, pathName: string): string {
  return `${normalizeConsoleUrl(consoleUrl)}${pathName.startsWith("/") ? pathName : `/${pathName}`}`;
}

function defaultBackoffMs(attempt: number): number {
  return Math.min(1000 * (2 ** Math.max(attempt - 1, 0)), 30000);
}

async function sendPresenceHeartbeat(connection: SharedConnection, signal?: AbortSignal): Promise<void> {
  try {
    await connection.fetchImpl(buildConsoleUrl(connection.url, "/api/state/presence"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Session-Id": connection.sessionId,
      },
      body: JSON.stringify({ source: connection.source }),
      signal,
    });
  } catch {
    // Best-effort UI presence: keep streaming even if the heartbeat fails.
  }
}

async function fetchConsoleJson(
  options: {
    consoleUrl?: string;
    pathName: string;
    sessionId: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<unknown> {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS);

  try {
    const response = await fetchImpl(buildConsoleUrl(options.consoleUrl || DEFAULT_CONSOLE_URL, options.pathName), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Session-Id": options.sessionId,
      },
      signal: controller.signal,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new CliError(`Console request failed with status ${response.status}.`, EXIT_CODES.NETWORK, { details: payload });
    }
    return payload;
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new CliError("Console request timed out.", EXIT_CODES.NETWORK);
    }

    if (error instanceof CliError) {
      throw error;
    }

    throw new CliError(asError(error).message, EXIT_CODES.NETWORK);
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMaybeJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function createAbortError(): Error {
  const error = new Error("Subscription aborted.");
  error.name = "AbortError";
  return error;
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: ConsoleStateEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "message";
  let dataLines: string[] = [];
  let lastEventId: string | undefined;

  const emit = () => {
    if (dataLines.length === 0) {
      eventType = "message";
      return;
    }

    onEvent({
      type: eventType,
      data: parseMaybeJson(dataLines.join("\n")),
      lastEventId,
    });
    eventType = "message";
    dataLines = [];
  };

  while (true) {
    if (signal.aborted) {
      throw createAbortError();
    }

    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n");
    while (boundary !== -1) {
      const rawLine = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line === "") {
        emit();
      } else if (!line.startsWith(":")) {
        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        const rawValue = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");

        if (field === "event") {
          eventType = rawValue || "message";
        } else if (field === "data") {
          dataLines.push(rawValue);
        } else if (field === "id") {
          lastEventId = rawValue;
        }
      }

      boundary = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  emit();
}

async function connectSharedConnection(connection: SharedConnection): Promise<void> {
  while (!connection.stopped && connection.subscribers.size > 0) {
    const attempt = connection.attempt + 1;
    connection.attempt = attempt;
    const abortController = new AbortController();
    connection.abortController = abortController;

    try {
      const response = await connection.fetchImpl(buildConsoleUrl(connection.url, "/api/state/stream"), {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Session-Id": connection.sessionId,
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Console state stream failed with status ${response.status}.`);
      }
      if (!response.body) {
        throw new Error("Console state stream did not provide a response body.");
      }

      connection.attempt = 0;
      await sendPresenceHeartbeat(connection, abortController.signal);
      connection.heartbeatInterval = setInterval(() => {
        void sendPresenceHeartbeat(connection, abortController.signal);
      }, PRESENCE_HEARTBEAT_MS);
      await readSseStream(
        response.body,
        (event) => {
          for (const subscriber of connection.subscribers.values()) {
            subscriber.onEvent(event);
          }
        },
        abortController.signal,
      );
    } catch (error) {
      if (connection.stopped || isAbortLikeError(error)) {
        break;
      }

      const reconnectInMs = connection.backoffMs(connection.attempt);
      const resolvedError = asError(error);
      for (const subscriber of connection.subscribers.values()) {
        subscriber.onTransportError?.(resolvedError, { attempt: connection.attempt, reconnectInMs });
      }
      await delay(reconnectInMs);
    } finally {
      if (connection.heartbeatInterval) {
        clearInterval(connection.heartbeatInterval);
        connection.heartbeatInterval = null;
      }
      connection.abortController = null;
    }
  }

  sharedConnections.delete(connection.key);
  connection.connectPromise = null;
}

function getConnectionKey(consoleUrl: string, sessionId: string, source: string): string {
  return `${normalizeConsoleUrl(consoleUrl)}::${sessionId}::${normalizeAgentSource(source)}`;
}

export function readStoredSessionId(env: Record<string, string | undefined> = process.env): string | undefined {
  const sessionIdPath = getSessionIdPath(env);
  try {
    if (!fs.existsSync(sessionIdPath)) {
      return undefined;
    }

    const value = String(fs.readFileSync(sessionIdPath, "utf8")).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function resolveConsoleSessionId(
  explicitSessionId: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const envSessionId = env.INDEXING_CO_SESSION_ID?.trim();
  const sessionId = explicitSessionId || envSessionId || readStoredSessionId(env);
  if (!sessionId) {
    throw new CliError(
      "No session id available. Pass --session <id> explicitly (copy from the console's BYO Agent panel) " +
        "or set the INDEXING_CO_SESSION_ID env var, or place the id at ~/.indexing-co/session-id.",
      EXIT_CODES.USAGE,
    );
  }
  return assertSafeSessionId(sessionId);
}

export function resolveOptionalActivitySessionId(
  explicitSessionId: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const envSessionId = env.INDEXING_CO_SESSION_ID?.trim();
  const sessionId = explicitSessionId || envSessionId || readStoredSessionId(env);
  if (!sessionId) {
    return undefined;
  }
  return ACTIVITY_SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined;
}

export function resolveAgentSource(
  explicitSource: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  return normalizeAgentSource(explicitSource || env.INDEXING_CO_AGENT_SOURCE);
}

export async function reportAgentActivity(options: AgentActivityReportOptions): Promise<boolean> {
  const sessionId = resolveOptionalActivitySessionId(options.sessionId, options.env);
  if (!sessionId) {
    return false;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_UPDATE_TIMEOUT_MS);
  const source = normalizeAgentSource(options.source || options.env?.INDEXING_CO_AGENT_SOURCE);

  const data = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    actor: "agent",
    type: options.type,
    target: options.target,
    metadata: {
      ...(options.metadata || {}),
      agentName: source,
    },
  };

  try {
    const response = await fetchImpl(buildConsoleUrl(options.consoleUrl || DEFAULT_CONSOLE_URL, "/api/session/event"), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Session-Id": sessionId,
      },
      body: JSON.stringify({ type: "agent_event", data }),
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCurrentUserState(options: {
  sessionId: string;
  consoleUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ConsoleStateSnapshot> {
  return await fetchConsoleJson({
    ...options,
    pathName: "/api/state/current",
  }) as ConsoleStateSnapshot;
}

export async function getAgentPairingHealth(options: {
  sessionId: string;
  consoleUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AgentPairingHealth> {
  const presence = await fetchConsoleJson({
    ...options,
    pathName: "/api/state/presence",
  }) as AgentPresenceSnapshot;

  const warnings: string[] = [];
  let currentState: ConsoleStateSnapshot | null = null;
  let events: AgentEventsSnapshot | null = null;

  try {
    currentState = await getCurrentUserState(options);
  } catch (error) {
    warnings.push(`State snapshot unavailable: ${asError(error).message}`);
  }

  try {
    events = await fetchConsoleJson({
      ...options,
      pathName: "/api/agent/events/current",
    }) as AgentEventsSnapshot;
  } catch (error) {
    warnings.push(`Agent activity snapshot unavailable: ${asError(error).message}`);
  }

  const connected = Boolean(presence.connected);
  const proposalCount = Array.isArray(events?.agentProposals) ? events.agentProposals.length : 0;
  const eventCount = Array.isArray(events?.agentEvents) ? events.agentEvents.length : 0;

  if (!connected) {
    warnings.push(
      "Console presence is disconnected. Keep `indexing-co agent watch --session <id> --console-url <url>` running while you work.",
    );
  }
  if (!connected && proposalCount > 0) {
    warnings.push("This session has agent proposals, but the BYO rail will still look disconnected until watch is running.");
  }
  if (!connected && eventCount > 0) {
    warnings.push("This session has agent activity events, but the BYO rail will still look disconnected until watch is running.");
  }

  return {
    connected,
    railStatus: connected
      ? `Agent connected${presence.source ? ` (${presence.source})` : ""}`
      : "BYO Agent setup/disconnected",
    source: connected ? presence.source ?? null : null,
    lastSeenAt: connected ? presence.lastSeenAt ?? null : null,
    warnings,
    presence,
    currentState,
    events,
  };
}

export function subscribeConsoleState(options: ConsoleStateSubscriptionOptions): ConsoleStateSubscription {
  const consoleUrl = normalizeConsoleUrl(options.consoleUrl);
  const source = normalizeAgentSource(options.source);
  const key = getConnectionKey(consoleUrl, options.sessionId, source);
  let connection = sharedConnections.get(key);

  if (!connection) {
    connection = {
      abortController: null,
      attempt: 0,
      connectPromise: null,
      fetchImpl: options.fetchImpl || fetch,
      heartbeatInterval: null,
      key,
      sessionId: options.sessionId,
      source,
      stopped: false,
      subscribers: new Map(),
      url: consoleUrl,
      backoffMs: options.backoffMs || defaultBackoffMs,
    };
    sharedConnections.set(key, connection);
  }

  const id = nextSubscriberId;
  nextSubscriberId += 1;
  connection.subscribers.set(id, {
    id,
    onEvent: options.onEvent,
    onTransportError: options.onTransportError,
  });

  if (!connection.connectPromise) {
    connection.connectPromise = connectSharedConnection(connection);
  }

  return {
    unsubscribe: () => {
      const activeConnection = sharedConnections.get(key);
      if (!activeConnection) {
        return;
      }

      activeConnection.subscribers.delete(id);
      if (activeConnection.subscribers.size === 0) {
        activeConnection.stopped = true;
        activeConnection.abortController?.abort();
        sharedConnections.delete(key);
      }
    },
  };
}

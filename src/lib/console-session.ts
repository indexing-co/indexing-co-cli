const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

import { DEFAULT_CONSOLE_URL, getConfigDirectory, getSessionIdPath } from "./constants";

const SAFE_AGENT_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const ACTIVITY_SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const SAFE_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ACTIVE_SESSION_TTL_MS = 30_000;
const DEFAULT_AGENT_SOURCE = "indexing-co-cli";

export interface ActiveConsoleSession {
  sessionId: string;
  consoleUrl: string;
  source: string;
  scope: string;
  cwd: string;
  lastHeartbeatAt: string;
  expiresAt: string;
  watcherPid: number;
  cliVersion: string;
}

export interface ConsoleSessionContext {
  sessionId?: string;
  consoleUrl: string;
  source: string;
  activeSession?: ActiveConsoleSession;
}

export function normalizeConsoleUrl(consoleUrl?: string): string {
  const url = (consoleUrl || process.env.INDEXING_CO_CONSOLE_URL || DEFAULT_CONSOLE_URL).trim();
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function normalizeAgentSource(source?: string): string {
  const value = (source || process.env.INDEXING_CO_AGENT_SOURCE || DEFAULT_AGENT_SOURCE).trim();
  return SAFE_AGENT_SOURCE_PATTERN.test(value) ? value : DEFAULT_AGENT_SOURCE;
}

export function assertSafeSessionId(sessionId: string): string {
  if (!SAFE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Invalid console session id.");
  }
  return sessionId;
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

export function getConsoleSessionScope(
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): string {
  const explicitScope = env.INDEXING_CO_CONSOLE_SCOPE?.trim();
  if (explicitScope && SAFE_SCOPE_PATTERN.test(explicitScope)) {
    return explicitScope;
  }

  let resolvedCwd = cwd;
  try {
    resolvedCwd = fs.realpathSync(cwd);
  } catch {
    resolvedCwd = path.resolve(cwd);
  }

  return crypto.createHash("sha256").update(resolvedCwd).digest("hex").slice(0, 16);
}

export function getConsoleSessionsDirectory(env: Record<string, string | undefined> = process.env): string {
  return path.join(getConfigDirectory(env), "console-sessions");
}

export function getActiveConsoleSessionPath(options: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  scope?: string;
} = {}): string {
  const env = options.env || process.env;
  const scope = options.scope || getConsoleSessionScope(options.cwd, env);
  return path.join(getConsoleSessionsDirectory(env), `${scope}.json`);
}

function parseActiveConsoleSession(contents: string): ActiveConsoleSession | undefined {
  try {
    const parsed = JSON.parse(contents) as Partial<ActiveConsoleSession>;
    if (!parsed.sessionId || !parsed.consoleUrl || !parsed.expiresAt) {
      return undefined;
    }
    return parsed as ActiveConsoleSession;
  } catch {
    return undefined;
  }
}

export function readActiveConsoleSession(options: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
} = {}): ActiveConsoleSession | undefined {
  const sessionPath = getActiveConsoleSessionPath(options);
  try {
    if (!fs.existsSync(sessionPath)) {
      return undefined;
    }

    const parsed = parseActiveConsoleSession(fs.readFileSync(sessionPath, "utf8"));
    if (!parsed) {
      return undefined;
    }

    const nowMs = (options.now || new Date()).getTime();
    if (Number.isNaN(Date.parse(parsed.expiresAt)) || Date.parse(parsed.expiresAt) <= nowMs) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

export function writeActiveConsoleSession(options: {
  sessionId: string;
  consoleUrl?: string;
  source?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  cliVersion: string;
  now?: Date;
}): ActiveConsoleSession {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const now = options.now || new Date();
  const scope = getConsoleSessionScope(cwd, env);
  const session: ActiveConsoleSession = {
    sessionId: options.sessionId,
    consoleUrl: normalizeConsoleUrl(options.consoleUrl || env.INDEXING_CO_CONSOLE_URL),
    source: normalizeAgentSource(options.source || env.INDEXING_CO_AGENT_SOURCE),
    scope,
    cwd: path.resolve(cwd),
    lastHeartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ACTIVE_SESSION_TTL_MS).toISOString(),
    watcherPid: process.pid,
    cliVersion: options.cliVersion,
  };

  const sessionPath = getActiveConsoleSessionPath({ cwd, env, scope });
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  return session;
}

export function resolveOptionalConsoleSessionContext(options: {
  explicitSessionId?: string;
  explicitConsoleUrl?: string;
  explicitSource?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
} = {}): ConsoleSessionContext {
  const env = options.env || process.env;
  const activeSession = readActiveConsoleSession({ cwd: options.cwd, env });
  const sessionId = (
    options.explicitSessionId ||
    env.INDEXING_CO_CONSOLE_SESSION_ID ||
    env.INDEXING_CO_SESSION_ID ||
    activeSession?.sessionId ||
    readStoredSessionId(env)
  )?.trim();

  return {
    sessionId: sessionId && ACTIVITY_SESSION_ID_PATTERN.test(sessionId) ? sessionId : undefined,
    consoleUrl: normalizeConsoleUrl(options.explicitConsoleUrl || env.INDEXING_CO_CONSOLE_URL || activeSession?.consoleUrl),
    source: normalizeAgentSource(options.explicitSource || env.INDEXING_CO_AGENT_SOURCE || activeSession?.source),
    activeSession,
  };
}

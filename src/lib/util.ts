const fs = require("node:fs");
const path = require("node:path");

import { CliError, EXIT_CODES } from "./errors";

export function compactObject<T extends Record<string, unknown>>(value: T): T {
  const next: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      next[key] = entry;
    }
  }

  return next as T;
}

export function toOptionKey(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function ensureArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function splitCsv(values: string[]): string[] {
  const parts: string[] = [];

  for (const value of values) {
    for (const item of value.split(",")) {
      const trimmed = item.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    }
  }

  return parts;
}

export function parseInteger(name: string, input: unknown): number {
  const value = Number(input);
  if (!Number.isInteger(value)) {
    throw new CliError(`Expected ${name} to be an integer.`, EXIT_CODES.USAGE);
  }
  return value;
}

export function maskSecret(secret: string | undefined): string {
  if (!secret) {
    return "not set";
  }

  if (secret.length <= 8) {
    return "*".repeat(secret.length);
  }

  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function readTextFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

export function resolveFilePath(cwd: string, input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function loadJsonValue(input: string, cwd: string): unknown {
  let source = input;

  if (input.startsWith("@")) {
    source = readTextFile(resolveFilePath(cwd, input.slice(1)));
  } else {
    const maybeFilePath = resolveFilePath(cwd, input);
    if (fileExists(maybeFilePath) && fs.statSync(maybeFilePath).isFile()) {
      source = readTextFile(maybeFilePath);
    }
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new CliError("Expected valid JSON or @path-to-json.", EXIT_CODES.USAGE, { details: error });
  }
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }

  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatRate(count: number, milliseconds: number): string {
  if (milliseconds <= 0) {
    return "0.00/s";
  }

  const perSecond = (count / milliseconds) * 1000;
  return `${perSecond.toFixed(2)}/s`;
}

export function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => stringifyValue(entry)).join(", ");
  }

  return JSON.stringify(value);
}

export function escapeSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

export function escapeSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function flattenListPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      return record.data;
    }
    if (Array.isArray(record.items)) {
      return record.items;
    }
  }

  return [];
}

export function compareVersions(left: string, right: string): number {
  const normalize = (value: string) => value.replace(/^v/, "").split(".").map((part) => Number(part.split("-")[0] || "0"));
  const a = normalize(left);
  const b = normalize(right);
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

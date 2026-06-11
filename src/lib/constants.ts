const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

export const DEFAULT_BASE_URL = "https://app.indexing.co/dw";
export const CONFIG_DIRECTORY_NAME = ".indexing-co";
export const CREDENTIALS_FILE_NAME = "credentials";
export const STATE_FILE_NAME = "state.json";
export const SESSION_ID_FILE_NAME = "session-id";
export const DEFAULT_HTTP_TIMEOUT_MS = 15000;
export const DEFAULT_UPDATE_TIMEOUT_MS = 800;
export const STREAM_CONNECT_TIMEOUT_MS = 10000;
export const DEFAULT_CONSOLE_URL = "https://console.indexing.co";

export interface PackageMetadata {
  name: string;
  version: string;
  description?: string;
}

let packageMetadataCache: PackageMetadata | null = null;

export function getHomeDirectory(env: Record<string, string | undefined> = process.env): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function getConfigDirectory(env: Record<string, string | undefined> = process.env): string {
  return path.join(getHomeDirectory(env), CONFIG_DIRECTORY_NAME);
}

export function getCredentialsPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(getConfigDirectory(env), CREDENTIALS_FILE_NAME);
}

export function getStatePath(env: Record<string, string | undefined> = process.env): string {
  return path.join(getConfigDirectory(env), STATE_FILE_NAME);
}

export function getSessionIdPath(env: Record<string, string | undefined> = process.env): string {
  return path.join(getConfigDirectory(env), SESSION_ID_FILE_NAME);
}

export function getPackageRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

export function readPackageMetadata(): PackageMetadata {
  if (packageMetadataCache) {
    return packageMetadataCache;
  }

  const packagePath = path.join(getPackageRoot(), "package.json");
  const contents = fs.readFileSync(packagePath, "utf8");
  const parsed = JSON.parse(contents);

  packageMetadataCache = {
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
  };

  return packageMetadataCache;
}

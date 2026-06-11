const fs = require("node:fs");
const path = require("node:path");
const readlinePromises = require("node:readline/promises");

import { CliError, EXIT_CODES } from "./errors";
import { getConfigDirectory, getCredentialsPath } from "./constants";

export const API_KEY_GUIDANCE =
  "Sign in to Console, open Account -> API Keys, create or copy an active key, then run \"indexing-co auth login\". " +
  "New accounts include 10,000 free blocks and no card is required. Never paste browser JWTs, bearer headers, destination secrets, or private keys.";

export interface CredentialResolution {
  apiKey?: string;
  source?: "flag" | "env" | "file";
  credentialsPath: string;
}

export interface ResolveApiKeyOptions {
  apiKeyFlag?: string;
  env?: Record<string, string | undefined>;
  credentialsPath?: string;
  required?: boolean;
}

export function parseCredentialsFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    result[key] = value;
  }

  return result;
}

export function resolveApiKey(options: ResolveApiKeyOptions = {}): CredentialResolution {
  const env = options.env || process.env;
  const credentialsPath = options.credentialsPath || getCredentialsPath(env);

  if (options.apiKeyFlag) {
    return { apiKey: options.apiKeyFlag, source: "flag", credentialsPath };
  }

  if (env.INDEXING_CO_API_KEY) {
    return { apiKey: env.INDEXING_CO_API_KEY, source: "env", credentialsPath };
  }

  try {
    if (fs.existsSync(credentialsPath)) {
      const contents = fs.readFileSync(credentialsPath, "utf8");
      const parsed = parseCredentialsFile(contents);
      if (parsed.API_KEY) {
        return { apiKey: parsed.API_KEY, source: "file", credentialsPath };
      }
    }
  } catch (error) {
    throw new CliError("Unable to read the credentials file.", EXIT_CODES.AUTH, { details: error });
  }

  if (options.required) {
    throw new CliError(
      "No API key found.",
      EXIT_CODES.AUTH,
      {
        hint: `${API_KEY_GUIDANCE} You can also set INDEXING_CO_API_KEY or pass --api-key for one command.`,
      },
    );
  }

  return { credentialsPath };
}

export async function promptForApiKey(io: { input?: any; output?: any } = {}): Promise<string> {
  const rl = readlinePromises.createInterface({
    input: io.input || process.stdin,
    output: io.output || process.stdout,
    terminal: Boolean((io.input || process.stdin).isTTY && (io.output || process.stdout).isTTY),
  });

  try {
    const answer = String(await rl.question("Paste your Indexing Co API key from Console -> Account -> API Keys: ")).trim();
    if (!answer) {
      throw new CliError("An API key is required to complete login.", EXIT_CODES.USAGE);
    }
    return answer;
  } finally {
    rl.close();
  }
}

export function writeCredentialsFile(apiKey: string, credentialsPath = getCredentialsPath()): string {
  const directory = path.dirname(credentialsPath);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(credentialsPath, `API_KEY=${apiKey}\n`, { mode: 0o600 });
  return credentialsPath;
}

export function removeCredentialsFile(credentialsPath = getCredentialsPath()): boolean {
  if (!fs.existsSync(credentialsPath)) {
    return false;
  }

  fs.unlinkSync(credentialsPath);
  return true;
}

export function ensureConfigDirectory(env?: Record<string, string | undefined>): string {
  const directory = getConfigDirectory(env);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

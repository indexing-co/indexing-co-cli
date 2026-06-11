const path = require("node:path");

import { resolveApiKey } from "./auth";
import { DEFAULT_BASE_URL, getCredentialsPath, getStatePath, readPackageMetadata } from "./constants";
import { CliError, EXIT_CODES, toCliError } from "./errors";
import { createHttpClient } from "./http";
import { renderHumanResult, renderJsonResult, type CommandResult } from "./output";
import { compareVersions, toOptionKey } from "./util";

export interface OptionDefinition {
  name: string;
  short?: string;
  description: string;
  type: "boolean" | "string" | "number";
  multiple?: boolean;
  hidden?: boolean;
}

export interface ArgDefinition {
  name: string;
  required?: boolean;
  variadic?: boolean;
}

export interface CommandDefinition {
  name: string;
  summary: string;
  description?: string;
  args?: ArgDefinition[];
  options?: OptionDefinition[];
  children?: CommandDefinition[];
  examples?: string[];
  hidden?: boolean;
  requiresAuth?: boolean;
  execute?: (context: CommandContext) => Promise<CommandResult> | CommandResult;
}

export interface CommandContext {
  args: string[];
  options: Record<string, unknown>;
  command: CommandDefinition;
  commandPath: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: { write: (chunk: string) => void; isTTY?: boolean };
  stderr: { write: (chunk: string) => void; isTTY?: boolean };
  stdin: any;
  format: "human" | "json";
  config: {
    apiKey?: string;
    apiKeySource?: string;
    baseUrl: string;
    credentialsPath: string;
    statePath: string;
    packageName: string;
    packageVersion: string;
  };
  http: ReturnType<typeof createHttpClient>;
  fetchImpl: typeof fetch;
  rootCommand: CommandDefinition;
}

export interface RunCliOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: any;
  stdout?: { write: (chunk: string) => void; isTTY?: boolean };
  stderr?: { write: (chunk: string) => void; isTTY?: boolean };
  fetchImpl?: typeof fetch;
}

const GLOBAL_OPTIONS: OptionDefinition[] = [
  { name: "help", short: "h", description: "Show help for the selected command.", type: "boolean" },
  { name: "json", short: "j", description: "Emit structured JSON instead of human-readable output.", type: "boolean" },
  { name: "api-key", description: "Override the API key for this invocation.", type: "string" },
  { name: "base-url", description: "Override the API base URL.", type: "string" },
  { name: "session", description: "Console session id for activity reporting.", type: "string", hidden: true },
  { name: "console-url", description: "Console URL for activity reporting.", type: "string", hidden: true },
  { name: "source", description: "Agent source for activity reporting.", type: "string", hidden: true },
  { name: "no-update-check", description: "Skip the npm version check banner.", type: "boolean" },
  { name: "version", short: "v", description: "Show the CLI version.", type: "boolean" },
];

function write(stream: { write: (chunk: string) => void }, text: string): void {
  stream.write(text);
}

function splitLongOption(token: string): { name: string; inlineValue?: string } {
  const source = token.slice(2);
  const separatorIndex = source.indexOf("=");
  if (separatorIndex === -1) {
    return { name: source };
  }

  return {
    name: source.slice(0, separatorIndex),
    inlineValue: source.slice(separatorIndex + 1),
  };
}

function findChild(command: CommandDefinition, token: string): CommandDefinition | undefined {
  return (command.children || []).find((child) => child.name === token);
}

function extractGlobalOptions(argv: string[]): { commandTokens: string[]; options: Record<string, unknown> } {
  const commandTokens: string[] = [];
  const options: Record<string, unknown> = {};
  const byLong = new Map(GLOBAL_OPTIONS.map((option) => [option.name, option]));
  const byShort = new Map(GLOBAL_OPTIONS.filter((option) => option.short).map((option) => [option.short as string, option]));

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token.startsWith("--")) {
      const { name, inlineValue } = splitLongOption(token);
      const option = byLong.get(name);
      if (!option) {
        commandTokens.push(token);
        continue;
      }

      const key = toOptionKey(option.name);
      if (option.type === "boolean") {
        options[key] = true;
      } else {
        const value = inlineValue !== undefined ? inlineValue : argv[index + 1];
        if (value === undefined) {
          throw new CliError(`Missing value for --${name}.`, EXIT_CODES.USAGE);
        }
        if (inlineValue === undefined) {
          index += 1;
        }
        options[key] = option.type === "number" ? Number(value) : value;
      }
      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      const short = token.slice(1);
      const option = byShort.get(short);
      if (!option) {
        commandTokens.push(token);
        continue;
      }

      const key = toOptionKey(option.name);
      if (option.type === "boolean") {
        options[key] = true;
      } else {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new CliError(`Missing value for -${short}.`, EXIT_CODES.USAGE);
        }
        index += 1;
        options[key] = option.type === "number" ? Number(value) : value;
      }
      continue;
    }

    commandTokens.push(token);
  }

  return { commandTokens, options };
}

function resolveCommand(rootCommand: CommandDefinition, tokens: string[]): { command: CommandDefinition; commandPath: string[]; remainder: string[] } {
  let command = rootCommand;
  const commandPath: string[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token.startsWith("-")) {
      break;
    }

    const child = findChild(command, token);
    if (!child) {
      break;
    }

    command = child;
    commandPath.push(child.name);
    index += 1;
  }

  return {
    command,
    commandPath,
    remainder: tokens.slice(index),
  };
}

function parseCommandTokens(command: CommandDefinition, tokens: string[]): { args: string[]; options: Record<string, unknown> } {
  const options: Record<string, unknown> = {};
  const args: string[] = [];
  const optionDefinitions = [...GLOBAL_OPTIONS, ...(command.options || [])];
  const byLong = new Map(optionDefinitions.map((option) => [option.name, option]));
  const byShort = new Map(optionDefinitions.filter((option) => option.short).map((option) => [option.short as string, option]));

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--") {
      args.push(...tokens.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const { name, inlineValue } = splitLongOption(token);
      const option = byLong.get(name);
      if (!option) {
        throw new CliError(`Unknown option --${name}.`, EXIT_CODES.USAGE);
      }

      const key = toOptionKey(option.name);
      if (option.type === "boolean") {
        options[key] = true;
        continue;
      }

      const nextValue = inlineValue !== undefined ? inlineValue : tokens[index + 1];
      if (nextValue === undefined) {
        throw new CliError(`Missing value for --${name}.`, EXIT_CODES.USAGE);
      }

      if (inlineValue === undefined) {
        index += 1;
      }

      const parsedValue = option.type === "number" ? Number(nextValue) : nextValue;
      if (option.multiple) {
        options[key] = [...(Array.isArray(options[key]) ? (options[key] as unknown[]) : []), parsedValue];
      } else {
        options[key] = parsedValue;
      }
      continue;
    }

    if (token.startsWith("-") && token !== "-") {
      const short = token.slice(1);
      const option = byShort.get(short);
      if (!option) {
        throw new CliError(`Unknown option -${short}.`, EXIT_CODES.USAGE);
      }

      const key = toOptionKey(option.name);
      if (option.type === "boolean") {
        options[key] = true;
        continue;
      }

      const nextValue = tokens[index + 1];
      if (nextValue === undefined) {
        throw new CliError(`Missing value for -${short}.`, EXIT_CODES.USAGE);
      }

      index += 1;
      const parsedValue = option.type === "number" ? Number(nextValue) : nextValue;
      if (option.multiple) {
        options[key] = [...(Array.isArray(options[key]) ? (options[key] as unknown[]) : []), parsedValue];
      } else {
        options[key] = parsedValue;
      }
      continue;
    }

    args.push(token);
  }

  validateArgs(command, args);
  return { args, options };
}

function validateArgs(command: CommandDefinition, args: string[]): void {
  const definitions = command.args || [];
  let requiredCount = 0;
  let variadic = false;

  for (const definition of definitions) {
    if (definition.required) {
      requiredCount += 1;
    }
    if (definition.variadic) {
      variadic = true;
    }
  }

  if (args.length < requiredCount) {
    throw new CliError(`Missing required arguments for "${command.name}".`, EXIT_CODES.USAGE);
  }

  if (!variadic && args.length > definitions.length) {
    throw new CliError(`Too many arguments for "${command.name}".`, EXIT_CODES.USAGE);
  }
}

function usageFor(rootCommand: CommandDefinition, commandPath: string[], command: CommandDefinition): string {
  const segments = [rootCommand.name, ...commandPath];
  if ((command.children || []).length > 0 && !command.execute) {
    segments.push("<subcommand>");
  }
  for (const arg of command.args || []) {
    if (arg.variadic) {
      segments.push(arg.required ? `<${arg.name}...>` : `[${arg.name}...]`);
    } else {
      segments.push(arg.required ? `<${arg.name}>` : `[${arg.name}]`);
    }
  }
  if ([...GLOBAL_OPTIONS, ...(command.options || [])].length > 0) {
    segments.push("[options]");
  }
  return segments.join(" ");
}

export function renderHelp(rootCommand: CommandDefinition, commandPath: string[], command: CommandDefinition): string {
  const sections: string[] = [];
  sections.push(`${command.summary}\n`);
  if (command.description) {
    sections.push(`${command.description}\n`);
  }

  sections.push(`Usage:\n  ${usageFor(rootCommand, commandPath, command)}\n`);

  const visibleChildren = (command.children || []).filter((child) => !child.hidden);
  if (visibleChildren.length > 0) {
    sections.push(
      `Commands:\n${visibleChildren
        .map((child) => `  ${child.name.padEnd(18)}${child.summary}`)
        .join("\n")}\n`,
    );
  }

  const visibleOptions = [...GLOBAL_OPTIONS, ...(command.options || [])].filter((option) => !option.hidden);
  if (visibleOptions.length > 0) {
    sections.push(
      `Options:\n${visibleOptions
        .map((option) => {
          const short = option.short ? `-${option.short}, ` : "    ";
          const suffix = option.type === "boolean" ? "" : ` <${toOptionKey(option.name)}>`;
          return `  ${short}--${option.name}${suffix}`.padEnd(34) + option.description;
        })
        .join("\n")}\n`,
    );
  }

  if (command.examples && command.examples.length > 0) {
    sections.push(`Examples:\n${command.examples.map((example) => `  ${example}`).join("\n")}\n`);
  }

  return sections.join("\n");
}

async function checkForUpdates(
  context: CommandContext,
  options: RunCliOptions,
): Promise<string | null> {
  if (context.format === "json") {
    return null;
  }

  if (!context.stdout.isTTY || context.options.noUpdateCheck) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    const packageName = encodeURIComponent(context.config.packageName);
    const response = await (options.fetchImpl || fetch)(`https://registry.npmjs.org/${packageName}/latest`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    if (!payload?.version) {
      return null;
    }

    if (compareVersions(String(payload.version), context.config.packageVersion) > 0) {
      return `A newer ${context.config.packageName} version is available: ${payload.version} (current ${context.config.packageVersion}).\nRun: npm install -g ${context.config.packageName}\n`;
    }
  } catch {
    return null;
  }

  return null;
}

function buildContext(
  rootCommand: CommandDefinition,
  command: CommandDefinition,
  commandPath: string[],
  parsed: { args: string[]; options: Record<string, unknown> },
  options: RunCliOptions,
): CommandContext {
  const packageMetadata = readPackageMetadata();
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const credentialsPath = getCredentialsPath(env);
  const statePath = getStatePath(env);
  const baseUrl = String(parsed.options.baseUrl || env.INDEXING_CO_BASE_URL || DEFAULT_BASE_URL);
  const credential = resolveApiKey({
    apiKeyFlag: parsed.options.apiKey ? String(parsed.options.apiKey) : undefined,
    env,
    credentialsPath,
    required: command.requiresAuth !== false,
  });

  return {
    args: parsed.args,
    options: parsed.options,
    command,
    commandPath,
    cwd,
    env,
    stdin: options.stdin || process.stdin,
    stdout: options.stdout || process.stdout,
    stderr: options.stderr || process.stderr,
    format: parsed.options.json ? "json" : "human",
    config: {
      apiKey: credential.apiKey,
      apiKeySource: credential.source,
      baseUrl,
      credentialsPath,
      statePath,
      packageName: packageMetadata.name,
      packageVersion: packageMetadata.version,
    },
    http: createHttpClient({
      apiKey: credential.apiKey,
      baseUrl,
      userAgent: `${packageMetadata.name}/${packageMetadata.version}`,
      fetchImpl: options.fetchImpl,
    }),
    fetchImpl: options.fetchImpl || fetch,
    rootCommand,
  };
}

export function getCompletionSuggestions(rootCommand: CommandDefinition, words: string[]): string[] {
  const tokens = words.filter((word) => word.length > 0);
  const commandSelection = resolveCommand(rootCommand, tokens);
  const command = commandSelection.command;
  const pendingToken = words[words.length - 1] || "";
  const remainder = commandSelection.remainder;

  if (pendingToken.startsWith("-")) {
    return [...GLOBAL_OPTIONS, ...(command.options || [])]
      .filter((option) => !option.hidden)
      .map((option) => `--${option.name}`)
      .filter((option) => option.startsWith(pendingToken));
  }

  if (remainder.length === 0 && (command.children || []).length > 0) {
    return (command.children || []).filter((child) => !child.hidden).map((child) => child.name);
  }

  if ((command.children || []).length > 0) {
    return (command.children || [])
      .filter((child) => !child.hidden)
      .map((child) => child.name)
      .filter((name) => name.startsWith(pendingToken));
  }

  return [];
}

export async function runCli(rootCommand: CommandDefinition, argv: string[], options: RunCliOptions = {}): Promise<number> {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;

  try {
    const extracted = extractGlobalOptions(argv);
    const selection = resolveCommand(rootCommand, extracted.commandTokens);

    if (extracted.options.version && selection.commandPath.length === 0) {
      write(stdout, `${readPackageMetadata().version}\n`);
      return EXIT_CODES.SUCCESS;
    }

    const parsed = parseCommandTokens(selection.command, selection.remainder);
    const mergedOptions = { ...parsed.options, ...extracted.options };
    const mergedParsed = { ...parsed, options: mergedOptions };

    if (mergedOptions.help || (!selection.command.execute && selection.commandPath.length === 0 && selection.remainder.length === 0)) {
      write(stdout, renderHelp(rootCommand, selection.commandPath, selection.command));
      return EXIT_CODES.SUCCESS;
    }

    if (!selection.command.execute) {
      write(stderr, renderHelp(rootCommand, selection.commandPath, selection.command));
      return EXIT_CODES.USAGE;
    }

    const context = buildContext(rootCommand, selection.command, selection.commandPath, mergedParsed, options);
    const result = await selection.command.execute(context);
    write(context.format === "json" ? stdout : stdout, context.format === "json" ? renderJsonResult(result) : renderHumanResult(result));

    const updateBanner = await checkForUpdates(context, options);
    if (updateBanner) {
      write(stderr, `\n${updateBanner}`);
    }

    return result.exitCode ?? EXIT_CODES.SUCCESS;
  } catch (error) {
    const cliError = toCliError(error);
    write(stderr, `Error: ${cliError.message}\n`);
    if (cliError.hint) {
      write(stderr, `${cliError.hint}\n`);
    }
    return cliError.exitCode;
  }
}

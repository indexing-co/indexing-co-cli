import { CliError, EXIT_CODES } from "./errors";
import { ensureArray, stringifyValue, unique } from "./util";

interface ParseFrame {
  indent: number;
  container: "object" | "array";
  value: Record<string, unknown> | unknown[];
}

function stripComment(line: string): string {
  let quoted = false;
  let quote = "";
  let output = "";

  for (const char of line) {
    if ((char === "'" || char === "\"") && (!quoted || quote === char)) {
      if (!quoted) {
        quoted = true;
        quote = char;
      } else {
        quoted = false;
        quote = "";
      }
    }

    if (char === "#" && !quoted) {
      break;
    }

    output += char;
  }

  return output;
}

function splitKeyValue(input: string): [string, string] | null {
  let quoted = false;
  let quote = "";

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if ((char === "'" || char === "\"") && (!quoted || quote === char)) {
      if (!quoted) {
        quoted = true;
        quote = char;
      } else {
        quoted = false;
        quote = "";
      }
    }

    if (char === ":" && !quoted) {
      return [input.slice(0, index).trim(), input.slice(index + 1).trim()];
    }
  }

  return null;
}

function parseScalar(input: string): unknown {
  const value = input.trim();
  if (!value) {
    return "";
  }

  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value === "null") {
    return null;
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(",").map((entry) => parseScalar(entry));
  }

  const numeric = Number(value);
  if (!Number.isNaN(numeric) && /^-?\d+(\.\d+)?$/.test(value)) {
    return numeric;
  }

  return value;
}

function ensureParentValue(frame: ParseFrame, key: string, nextContainer: "object" | "array"): Record<string, unknown> | unknown[] {
  if (frame.container !== "object") {
    throw new CliError("Invalid YAML structure.", EXIT_CODES.VALIDATION);
  }

  const objectValue = frame.value as Record<string, unknown>;
  if (!objectValue[key]) {
    objectValue[key] = nextContainer === "object" ? {} : [];
  }

  return objectValue[key] as Record<string, unknown> | unknown[];
}

export function parseSubgraphManifest(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new CliError("The manifest file is empty.", EXIT_CODES.VALIDATION);
  }

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => stripComment(line))
    .filter((line) => line.trim().length > 0);

  const root: Record<string, unknown> = {};
  const stack: ParseFrame[] = [{ indent: -1, container: "object", value: root }];

  let pendingKey: { key: string; indent: number; owner: ParseFrame } | null = null;

  for (const rawLine of lines) {
    const indent = rawLine.match(/^ */)?.[0].length || 0;
    const line = rawLine.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    if (pendingKey && indent > pendingKey.indent) {
      const containerType = line.startsWith("- ") ? "array" : "object";
      const value = ensureParentValue(pendingKey.owner, pendingKey.key, containerType);
      stack.push({
        indent: pendingKey.indent,
        container: containerType,
        value,
      });
      pendingKey = null;
    } else if (pendingKey && indent <= pendingKey.indent) {
      (pendingKey.owner.value as Record<string, unknown>)[pendingKey.key] = null;
      pendingKey = null;
    }

    const frame = stack[stack.length - 1];

    if (line.startsWith("- ")) {
      const arrayFrame = frame.container === "array"
        ? frame
        : stack[stack.length - 1];

      if (arrayFrame.container !== "array") {
        throw new CliError("Unexpected list item in manifest.", EXIT_CODES.VALIDATION);
      }

      const itemSource = line.slice(2).trim();
      const nestedKeyValue = splitKeyValue(itemSource);
      if (!nestedKeyValue) {
        (arrayFrame.value as unknown[]).push(parseScalar(itemSource));
        continue;
      }

      const [key, rest] = nestedKeyValue;
      const nextObject: Record<string, unknown> = {};
      (arrayFrame.value as unknown[]).push(nextObject);

      if (rest) {
        nextObject[key] = parseScalar(rest);
      } else {
        pendingKey = { key, indent, owner: { indent, container: "object", value: nextObject } };
      }

      stack.push({ indent, container: "object", value: nextObject });
      continue;
    }

    const keyValue = splitKeyValue(line);
    if (!keyValue) {
      throw new CliError(`Unsupported manifest syntax: ${line}`, EXIT_CODES.VALIDATION);
    }

    const [key, rest] = keyValue;
    if (frame.container !== "object") {
      throw new CliError("Unexpected object property in list context.", EXIT_CODES.VALIDATION);
    }

    if (rest) {
      (frame.value as Record<string, unknown>)[key] = parseScalar(rest);
      continue;
    }

    pendingKey = { key, indent, owner: frame };
  }

  if (pendingKey) {
    (pendingKey.owner.value as Record<string, unknown>)[pendingKey.key] = null;
  }

  return root;
}

function countHandlers(mapping: Record<string, unknown>): number {
  return ensureArray(mapping.eventHandlers).length + ensureArray(mapping.blockHandlers).length + ensureArray(mapping.callHandlers).length;
}

export function summarizeSubgraphManifest(manifest: unknown, manifestPath: string): Record<string, unknown> {
  if (!manifest || typeof manifest !== "object") {
    throw new CliError("The manifest must parse to an object.", EXIT_CODES.VALIDATION);
  }

  const root = manifest as Record<string, unknown>;
  const dataSources = ensureArray(root.dataSources) as Record<string, unknown>[];
  const templates = ensureArray(root.templates) as Record<string, unknown>[];

  const describeSource = (source: Record<string, unknown>) => {
    const mapping = (source.mapping || {}) as Record<string, unknown>;
    const contract = (source.source || {}) as Record<string, unknown>;
    return {
      name: stringifyValue(source.name),
      kind: stringifyValue(source.kind),
      network: stringifyValue(source.network || contract.network),
      address: stringifyValue(contract.address),
      startBlock: contract.startBlock,
      handlerCount: countHandlers(mapping),
      abiCount: ensureArray(mapping.abis).length,
    };
  };

  return {
    manifestPath,
    specVersion: root.specVersion || null,
    description: root.description || null,
    repository: root.repository || null,
    schema: (root.schema as Record<string, unknown> | undefined)?.file || null,
    networks: unique(
      [...dataSources, ...templates]
        .map((entry) => describeSource(entry).network)
        .filter(Boolean),
    ),
    totals: {
      dataSources: dataSources.length,
      templates: templates.length,
      handlers: [...dataSources, ...templates].reduce((count, entry) => count + describeSource(entry).handlerCount, 0),
    },
    dataSources: dataSources.map(describeSource),
    templates: templates.map(describeSource),
  };
}

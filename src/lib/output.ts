import { stringifyValue } from "./util";

export interface TableColumn {
  key: string;
  label?: string;
}

export interface TableOutput {
  columns: TableColumn[];
  rows: Record<string, unknown>[];
}

export interface HumanOutput {
  intro?: string;
  lines?: string[];
  table?: TableOutput;
  raw?: string;
}

export interface CommandResult<T = unknown> {
  data: T;
  human?: HumanOutput | string;
  exitCode?: number;
}

function renderTable(table: TableOutput): string {
  const headers = table.columns.map((column) => column.label || column.key);
  const rows = table.rows.map((row) => table.columns.map((column) => stringifyValue(row[column.key])));
  const widths = headers.map((header, columnIndex) =>
    Math.max(
      header.length,
      ...rows.map((row) => row[columnIndex].length),
    ),
  );

  const pad = (value: string, width: number) => `${value}${" ".repeat(Math.max(width - value.length, 0))}`;
  const lines: string[] = [];
  lines.push(headers.map((header, index) => pad(header, widths[index])).join("  "));
  lines.push(widths.map((width) => "-".repeat(width)).join("  "));

  for (const row of rows) {
    lines.push(row.map((value, index) => pad(value, widths[index])).join("  "));
  }

  return lines.join("\n");
}

function normalizeHumanOutput(human?: HumanOutput | string): HumanOutput | undefined {
  if (!human) {
    return undefined;
  }

  return typeof human === "string" ? { raw: human } : human;
}

export function renderHumanResult(result: CommandResult): string {
  const human = normalizeHumanOutput(result.human);

  if (!human) {
    return "";
  }

  if (human.raw !== undefined) {
    return human.raw.endsWith("\n") ? human.raw : `${human.raw}\n`;
  }

  const segments: string[] = [];
  if (human.intro) {
    segments.push(human.intro);
  }
  if (human.lines && human.lines.length > 0) {
    segments.push(human.lines.join("\n"));
  }
  if (human.table) {
    segments.push(renderTable(human.table));
  }

  return segments.filter(Boolean).join("\n\n") + "\n";
}

export function renderJsonResult(result: CommandResult): string {
  return `${JSON.stringify(result.data, null, 2)}\n`;
}

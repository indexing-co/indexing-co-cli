const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';
const BRIGHT_YELLOW = '\x1b[93m';

// ── Sparkline ────────────────────────────────────────────────────────────────

const SPARK_CHARS = '▁▂▃▄▅▆▇█';

export interface SparklineOpts {
  min?: number;
  max?: number;
  color?: string;
}

export function sparkline(values: number[], opts?: SparklineOpts): string {
  if (values.length === 0) return '';

  const min = opts?.min ?? Math.min(...values);
  const max = opts?.max ?? Math.max(...values);
  const range = max - min || 1;
  const color = opts?.color ?? CYAN;

  const chars = values.map((v) => {
    const level = Math.round(((v - min) / range) * 7);
    return SPARK_CHARS[Math.max(0, Math.min(7, level))];
  });

  return `${color}${chars.join('')}${RESET}`;
}

// ── Line Chart ───────────────────────────────────────────────────────────────

export interface LineChartOpts {
  title?: string;
  width?: number;
  height?: number;
}

export function lineChart(values: number[], opts?: LineChartOpts): string {
  if (values.length === 0) return '';

  const width = opts?.width ?? 60;
  const height = opts?.height ?? 15;
  const title = opts?.title;

  // Downsample if needed
  const plotWidth = width - 10; // room for Y-axis labels
  const sampled = downsample(values, plotWidth);

  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const range = max - min || 1;

  // Build grid
  const grid: string[][] = Array.from({ length: height }, () =>
    Array.from({ length: plotWidth }, () => ' ')
  );

  // Plot points
  const yPositions = sampled.map((v) => {
    return Math.round(((v - min) / range) * (height - 1));
  });

  for (let x = 0; x < sampled.length; x++) {
    const y = height - 1 - yPositions[x];
    grid[y][x] = '●';

    // Connect to next point
    if (x < sampled.length - 1) {
      const nextY = height - 1 - yPositions[x + 1];
      if (nextY !== y) {
        const step = nextY > y ? 1 : -1;
        for (let cy = y + step; cy !== nextY; cy += step) {
          if (grid[cy][x] === ' ') grid[cy][x] = '│';
        }
        // Corner characters
        if (step > 0) {
          if (grid[y][x] === '●') grid[y][x] = '●';
          else grid[y][x] = '╮';
        } else {
          if (grid[y][x] === '●') grid[y][x] = '●';
          else grid[y][x] = '╰';
        }
      }
    }
  }

  // Render with Y-axis labels
  const lines: string[] = [];

  if (title) {
    lines.push(`${BOLD}${WHITE}  ${title}${RESET}`);
  }

  for (let row = 0; row < height; row++) {
    const yVal = max - (row / (height - 1)) * range;
    const label = formatAxisLabel(yVal).padStart(8);
    const rowStr = grid[row].join('');
    lines.push(`${DIM}${label}${RESET} ${CYAN}${rowStr}${RESET}`);
  }

  // X-axis
  lines.push(`${DIM}${'─'.repeat(9)}${'─'.repeat(plotWidth)}${RESET}`);

  return lines.join('\n');
}

// ── Bar Chart ────────────────────────────────────────────────────────────────

export interface BarChartOpts {
  title?: string;
  width?: number;
  color?: string;
}

export function barChart(data: { label: string; value: number }[], opts?: BarChartOpts): string {
  if (data.length === 0) return '';

  const width = opts?.width ?? 60;
  const title = opts?.title;
  const color = opts?.color ?? CYAN;

  const maxLabel = Math.max(...data.map((d) => d.label.length), 0);
  const maxVal = Math.max(...data.map((d) => d.value), 0);
  const barMaxWidth = width - maxLabel - 12; // label + gap + value

  const lines: string[] = [];

  if (title) {
    lines.push(`${BOLD}${WHITE}  ${title}${RESET}`);
  }

  for (const { label, value } of data) {
    const barLen = maxVal > 0 ? Math.round((value / maxVal) * barMaxWidth) : 0;
    const bar = '█'.repeat(Math.max(0, barLen));
    const paddedLabel = label.padEnd(maxLabel);
    lines.push(`  ${DIM}${paddedLabel}${RESET}  ${color}${bar}${RESET} ${BRIGHT_YELLOW}${value}${RESET}`);
  }

  return lines.join('\n');
}

// ── Histogram ────────────────────────────────────────────────────────────────

export interface HistogramOpts {
  bins?: number;
  title?: string;
  width?: number;
}

export function histogram(values: number[], opts?: HistogramOpts): string {
  if (values.length === 0) return '';

  const bins = opts?.bins ?? 10;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const binWidth = range / bins;

  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1);
    counts[idx]++;
  }

  const data = counts.map((count, i) => {
    const lo = min + i * binWidth;
    const hi = lo + binWidth;
    return { label: `${formatNum(lo)}-${formatNum(hi)}`, value: count };
  });

  return barChart(data, { title: opts?.title, width: opts?.width });
}

// ── Table ────────────────────────────────────────────────────────────────────

export interface TableOpts {
  title?: string;
  maxWidth?: number;
}

export function table(columns: string[], rows: Record<string, unknown>[], opts?: TableOpts): string {
  if (columns.length === 0) return '';

  // Compute column widths
  const colWidths = columns.map((col) => {
    const headerLen = col.length;
    const maxCell = rows.reduce((max, row) => {
      const cellLen = String(row[col] ?? '').length;
      return Math.max(max, cellLen);
    }, 0);
    return Math.max(headerLen, maxCell);
  });

  // Detect numeric columns
  const isNumeric = columns.map((col) =>
    rows.length > 0 && rows.every((row) => row[col] === null || row[col] === undefined || typeof row[col] === 'number' || /^-?\d+(\.\d+)?$/.test(String(row[col])))
  );

  function pad(val: string, width: number, rightAlign: boolean): string {
    return rightAlign ? val.padStart(width) : val.padEnd(width);
  }

  const lines: string[] = [];

  if (opts?.title) {
    lines.push(`${BOLD}${WHITE}  ${opts.title}${RESET}`);
  }

  // Header
  const header = columns.map((col, i) => `${BOLD}${WHITE}${pad(col, colWidths[i], isNumeric[i])}${RESET}`).join('  ');
  lines.push(`  ${header}`);

  // Separator
  const sep = colWidths.map((w) => '─'.repeat(w)).join('──');
  lines.push(`  ${DIM}${sep}${RESET}`);

  // Rows
  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const val = String(row[col] ?? '');
      return pad(val, colWidths[i], isNumeric[i]);
    });
    lines.push(`  ${cells.join('  ')}`);
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function downsample(values: number[], maxLen: number): number[] {
  if (values.length <= maxLen) return values;
  const step = values.length / maxLen;
  const result: number[] = [];
  for (let i = 0; i < maxLen; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    let sum = 0;
    for (let j = start; j < end; j++) sum += values[j];
    result.push(sum / (end - start));
  }
  return result;
}

function formatAxisLabel(val: number): string {
  if (Math.abs(val) >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (Math.abs(val) >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  if (Number.isInteger(val)) return String(val);
  return val.toFixed(1);
}

function formatNum(val: number): string {
  if (Number.isInteger(val)) return String(val);
  return val.toFixed(1);
}

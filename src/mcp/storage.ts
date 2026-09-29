const fs = require("node:fs");
const path = require("node:path");

// Event store for the MCP server, on Node's built-in SQLite (node:sqlite) rather than a native
// addon, so installing the CLI never compiles anything. node:sqlite is unflagged from Node 22.13.

export interface StoredEvent {
  id: number;
  channel: string;
  data: Record<string, unknown>;
  received_at: string;
}

export interface EventStore {
  path: string;
  insertEvents(channel: string, payloads: Record<string, unknown>[]): void;
  getEvents(channel?: string, limit?: number, offset?: number): StoredEvent[];
  getStats(): { channel: string; count: number; latest: string | null }[];
  runQuery(sql: string): { columns: string[]; rows: unknown[] };
  describeData(channel: string): {
    channel: string;
    totalEvents: number;
    sampleKeys: { key: string; type: string; example: unknown }[];
  };
  clearEvents(channel?: string): number;
  close(): void;
}

export function loadSqlite(): { DatabaseSync: any } {
  try {
    return require("node:sqlite");
  } catch {
    throw new Error(
      `indexing-co mcp needs Node.js 22.13 or newer for its built-in SQLite store (running ${process.version}).`,
    );
  }
}

export function openEventStore(dbPath: string): EventStore {
  const { DatabaseSync } = loadSqlite();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      data JSON NOT NULL,
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channel);
    CREATE INDEX IF NOT EXISTS idx_events_received ON events(received_at);
  `);

  const insert = db.prepare("INSERT INTO events (channel, data) VALUES (?, ?)");

  return {
    path: dbPath,

    insertEvents(channel, payloads) {
      db.exec("BEGIN");
      try {
        for (const item of payloads) {
          insert.run(channel, JSON.stringify(item));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    getEvents(channel, limit = 50, offset = 0) {
      let sql = "SELECT id, channel, data, received_at FROM events";
      const params: (string | number)[] = [];
      if (channel) {
        sql += " WHERE channel = ?";
        params.push(channel);
      }
      sql += " ORDER BY id DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params) as { id: number; channel: string; data: string; received_at: string }[];
      return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
    },

    getStats() {
      return db
        .prepare(
          `SELECT channel, COUNT(*) as count, MAX(received_at) as latest
           FROM events GROUP BY channel ORDER BY count DESC`,
        )
        .all() as { channel: string; count: number; latest: string | null }[];
    },

    runQuery(sql) {
      const trimmed = sql.trim();
      if (!/^SELECT\b/i.test(trimmed)) {
        throw new Error("Only SELECT queries are allowed");
      }

      const stmt = db.prepare(trimmed);
      const rows = stmt.all() as Record<string, unknown>[];
      // StatementSync#columns() only exists from Node 22.16; fall back to the first row's keys.
      const columns: string[] =
        typeof stmt.columns === "function"
          ? stmt.columns().map((column: { name: string }) => column.name)
          : Object.keys(rows[0] || {});
      return { columns, rows: rows.map((row) => ({ ...row })) };
    },

    describeData(channel) {
      const countRow = db.prepare("SELECT COUNT(*) as cnt FROM events WHERE channel = ?").get(channel) as { cnt: number };
      const sampleRows = db
        .prepare("SELECT data FROM events WHERE channel = ? ORDER BY id DESC LIMIT 10")
        .all(channel) as { data: string }[];

      const keyMap = new Map<string, { types: Set<string>; example: unknown }>();
      for (const row of sampleRows) {
        collectKeys(JSON.parse(row.data) as Record<string, unknown>, "", keyMap);
      }

      return {
        channel,
        totalEvents: countRow.cnt,
        sampleKeys: [...keyMap.entries()].map(([key, info]) => ({
          key,
          type: [...info.types].join(" | "),
          example: info.example,
        })),
      };
    },

    clearEvents(channel) {
      const result = channel
        ? db.prepare("DELETE FROM events WHERE channel = ?").run(channel)
        : db.prepare("DELETE FROM events").run();
      return Number(result.changes);
    },

    close() {
      db.close();
    },
  };
}

function collectKeys(
  obj: Record<string, unknown>,
  prefix: string,
  keyMap: Map<string, { types: Set<string>; example: unknown }>,
) {
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const type = val === null ? "null" : Array.isArray(val) ? "array" : typeof val;

    if (!keyMap.has(fullKey)) {
      keyMap.set(fullKey, { types: new Set(), example: type === "object" ? "[object]" : val });
    }
    keyMap.get(fullKey)!.types.add(type);

    if (type === "object" && val !== null && !Array.isArray(val)) {
      collectKeys(val as Record<string, unknown>, fullKey, keyMap);
    }
  }
}

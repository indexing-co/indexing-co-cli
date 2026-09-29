import type { StreamClient } from './stream';
import type { ApiClient } from './api';
import type { EventStore } from './storage';
import { sparkline, lineChart, barChart, histogram, table } from './charts';

// Loaded lazily with the SDK so the rest of the CLI never pays for it.
type McpServer = any;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function json(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function error(msg: string): ToolResult {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

export function registerTools(server: McpServer, stream: StreamClient, api: ApiClient, store: EventStore) {
  const { z } = require('zod');
  const tool = (name: string, description: string, schema: Record<string, unknown>, handler: (args: any) => Promise<ToolResult>): void => {
    server.tool(name, description, schema, handler);
  };

  // ── Streaming tools (existing) ────────────────────────────────────────

  tool('subscribe', 'Subscribe to a pipeline\'s DIRECT channel. The channel name must match the `table` field of a pipeline with DIRECT adapter. Use list_pipelines to find valid channel names.', { channel: z.string() }, async ({ channel }) => {
    // Validate channel exists as a DIRECT pipeline
    try {
      const res = await api.get('/pipelines') as { data: Array<{ name: string; enabled: boolean; delivery: { adapter: string; table?: string } }> };
      const pipeline = res.data.find(
        (p) => p.delivery?.adapter === 'DIRECT' && p.delivery?.table === channel
      );
      if (!pipeline) {
        const directPipelines = res.data.filter((p) => p.delivery?.adapter === 'DIRECT');
        const available = directPipelines.map((p) => p.delivery.table).filter(Boolean);
        const hint = available.length
          ? `Available DIRECT channels: ${available.join(', ')}`
          : 'No pipelines with DIRECT adapter found. Create one first with create_pipeline.';
        return error(`No DIRECT pipeline found for channel '${channel}'. ${hint}`);
      }
      if (!pipeline.enabled) {
        return error(`Pipeline '${pipeline.name}' exists but is not enabled. Re-create it with enabled: true.`);
      }
    } catch (err) {
      return error(`Failed to validate channel: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Channel is valid — subscribe
    stream.subscribe(channel, (events) => {
      store.insertEvents(channel, events);
      process.stderr.write(`[mcp] Received ${events.length} events on '${channel}'\n`);
    });

    return json(`Subscribed to channel '${channel}'. Events will be stored in SQLite as they arrive.`);
  });

  tool('unsubscribe', 'Stop receiving events for a channel.', { channel: z.string() }, async ({ channel }) => {
    stream.unsubscribe(channel);
    return json(`Unsubscribed from channel '${channel}'.`);
  });

  tool('get_subscriptions', 'List active channels, connection status, and event counts.', {}, async () => {
    const subs = stream.getSubscriptions();
    const stats = store.getStats();

    return json({
      connection: {
        connected: subs.connected,
        uptimeSeconds: subs.uptime,
      },
      channels: subs.channels.map((ch) => {
        const stat = stats.find((s) => s.channel === ch);
        return { channel: ch, storedEvents: stat?.count || 0, latestEvent: stat?.latest || null };
      }),
    });
  });

  tool(
    'get_events',
    'Get recent raw events. Returns JSON payloads as-is.',
    { channel: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() },
    async ({ channel, limit, offset }) => {
      const events = store.getEvents(channel, limit ?? 50, offset ?? 0);
      return json(events);
    }
  );

  tool(
    'describe_data',
    'Auto-discover data shape: sample keys, types, and value examples from stored events.',
    { channel: z.string() },
    async ({ channel }) => {
      return json(store.describeData(channel));
    }
  );

  tool(
    'query',
    'Run a read-only SQL query against stored events. Use json_extract(data, \'$.key\') to query event fields.',
    { sql: z.string() },
    async ({ sql }) => {
      try {
        return json(store.runQuery(sql));
      } catch (err) {
        return error(`Query error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  tool(
    'clear_events',
    'Delete stored events (all or by channel).',
    { channel: z.string().optional() },
    async ({ channel }) => {
      const deleted = store.clearEvents(channel);
      const scope = channel ? `channel '${channel}'` : 'all channels';
      return json(`Cleared ${deleted} events from ${scope}.`);
    }
  );

  tool(
    'chart',
    'Run a SQL query and render the results as an ASCII chart. Types: sparkline, line, bar, histogram, table.',
    {
      type: z.enum(['sparkline', 'line', 'bar', 'histogram', 'table']),
      sql: z.string(),
      options: z
        .object({
          title: z.string().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          bins: z.number().optional(),
        })
        .optional(),
    },
    async ({ type, sql, options }) => {
      try {
        const result = store.runQuery(sql);
        const { columns, rows } = result;
        const records = rows as Record<string, unknown>[];

        switch (type) {
          case 'sparkline': {
            const col = findNumericColumn(columns, records);
            if (!col) return error('No numeric column found for sparkline');
            const values = records.map((r) => Number(r[col]));
            return json(sparkline(values));
          }
          case 'line': {
            const col = findNumericColumn(columns, records);
            if (!col) return error('No numeric column found for line chart');
            const values = records.map((r) => Number(r[col]));
            return json(lineChart(values, { title: options?.title, width: options?.width, height: options?.height }));
          }
          case 'bar': {
            if (columns.length < 2) return error('Bar chart requires at least 2 columns (label, value)');
            const labelCol = columns[0];
            const valueCol = columns[1];
            const data = records.map((r) => ({ label: String(r[labelCol] ?? ''), value: Number(r[valueCol] ?? 0) }));
            return json(barChart(data, { title: options?.title, width: options?.width }));
          }
          case 'histogram': {
            const col = findNumericColumn(columns, records);
            if (!col) return error('No numeric column found for histogram');
            const values = records.map((r) => Number(r[col]));
            return json(histogram(values, { title: options?.title, width: options?.width, bins: options?.bins }));
          }
          case 'table': {
            return json(table(columns, records, { title: options?.title }));
          }
        }
        return error(`Unknown chart type '${type}'`);
      } catch (err) {
        return error(`Chart error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  tool('get_status', 'WebSocket state, channels, event counts, and uptime.', {}, async () => {
    const subs = stream.getSubscriptions();
    const stats = store.getStats();

    return json({
      websocket: {
        connected: subs.connected,
        uptimeSeconds: subs.uptime,
      },
      channels: subs.channels,
      eventCounts: stats,
      storage: {
        enabled: true,
      },
    });
  });

  // ── Pipeline tools ────────────────────────────────────────────────────

  tool('list_pipelines', 'List all pipelines. For DIRECT streaming pipelines, the delivery.table field is the channel name to use with subscribe.', {}, async () => {
    try {
      return json(await api.get('/pipelines'));
    } catch (err) {
      return error(`Failed to list pipelines: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  tool(
    'get_pipeline',
    'Get a pipeline by name.',
    { name: z.string() },
    async ({ name }) => {
      try {
        return json(await api.get(`/pipelines/${encodeURIComponent(name)}`));
      } catch (err) {
        return error(`Failed to get pipeline: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  tool(
    'create_pipeline',
    'Create or update a pipeline. Adapter types: POSTGRES (with connectionUri, table, uniqueKeys), HTTP (for webhooks — do NOT use "webhook"), WEBSOCKET, DIRECT (stream to MCP via connectionUri channel name).',
    {
      name: z.string(),
      transformation: z.string(),
      networks: z.array(z.string()),
      delivery: z.object({
        adapter: z.enum(['POSTGRES', 'HTTP', 'WEBSOCKET', 'DIRECT']),
        connectionUri: z.string().optional(),
        connection: z.record(z.unknown()).optional(),
        table: z.string().optional(),
        uniqueKeys: z.array(z.string()).optional(),
        tableMap: z.record(z.array(z.string())).optional(),
      }),
      filter: z.string().optional(),
      filterKeys: z.array(z.string()).optional(),
      enabled: z.boolean().optional(),
    },
    async (params) => {
      try {
        return json(await api.post('/pipelines', params));
      } catch (err) {
        return error(`Failed to create pipeline: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  tool(
    'delete_pipeline',
    'Delete a pipeline.',
    { name: z.string() },
    async ({ name }) => {
      try {
        return json(await api.delete(`/pipelines/${encodeURIComponent(name)}`));
      } catch (err) {
        return error(`Failed to delete pipeline: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  tool(
    'backfill',
    'Backfill historical data for a pipeline.',
    {
      pipeline: z.string(),
      network: z.string(),
      beats: z.array(z.number()).optional(),
      beatStart: z.number().optional(),
      beatEnd: z.number().optional(),
      value: z.string().optional(),
    },
    async ({ pipeline, ...body }) => {
      try {
        return json(await api.post(`/pipelines/${encodeURIComponent(pipeline)}/backfill`, body));
      } catch (err) {
        return error(`Failed to backfill: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Filter tools ──────────────────────────────────────────────────────

  tool('list_filters', 'List all filters.', {}, async () => {
    try {
      return json(await api.get('/filters'));
    } catch (err) {
      return error(`Failed to list filters: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  tool(
    'get_filter',
    'Get filter values with optional prefix search and pagination.',
    {
      name: z.string(),
      prefix: z.string().optional(),
      pageToken: z.string().optional(),
    },
    async ({ name, prefix, pageToken }) => {
      try {
        const query: Record<string, string> = {};
        if (prefix) query.prefix = prefix;
        if (pageToken) query.pageToken = pageToken;
        return json(await api.get(`/filters/${encodeURIComponent(name)}`, Object.keys(query).length ? query : undefined));
      } catch (err) {
        return error(`Failed to get filter: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  tool(
    'create_filter',
    'Create a filter or add values to an existing filter.',
    {
      name: z.string(),
      values: z.array(z.string()),
    },
    async ({ name, values }) => {
      try {
        return json(await api.post(`/filters/${encodeURIComponent(name)}`, { name, values }));
      } catch (err) {
        return error(`Failed to create filter: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  tool(
    'delete_filter_values',
    'Remove values from a filter.',
    {
      name: z.string(),
      values: z.array(z.string()),
    },
    async ({ name, values }) => {
      try {
        return json(await api.delete(`/filters/${encodeURIComponent(name)}`, { name, values }));
      } catch (err) {
        return error(`Failed to delete filter values: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // ── Transformation tools ──────────────────────────────────────────────

  tool('list_transformations', 'List all transformations.', {}, async () => {
    try {
      return json(await api.get('/transformations'));
    } catch (err) {
      return error(`Failed to list transformations: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  tool(
    'get_transformation',
    'Get transformation code by name.',
    { name: z.string() },
    async ({ name }) => {
      try {
        return json(await api.get(`/transformations/${encodeURIComponent(name)}`));
      } catch (err) {
        return error(`Failed to get transformation: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  tool(
    'create_transformation',
    'Create or update a transformation.',
    {
      name: z.string(),
      code: z.string(),
    },
    async ({ name, code }) => {
      try {
        return json(await api.post(`/transformations/${encodeURIComponent(name)}`, { name, code }));
      } catch (err) {
        return error(`Failed to create transformation: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  tool(
    'test_transformation',
    'Test transformation code against live blockchain data.',
    {
      code: z.string(),
      network: z.string(),
      beat: z.string().optional(),
      filter: z.string().optional(),
      filterKeys: z.array(z.string()).optional(),
    },
    async (params) => {
      try {
        return json(await api.post('/transformations/test', params));
      } catch (err) {
        return error(`Failed to test transformation: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}

const SKIP_COLUMNS = new Set(['id', 'received_at']);

function findNumericColumn(columns: string[], rows: Record<string, unknown>[]): string | null {
  if (rows.length === 0) return null;
  for (const col of columns) {
    if (SKIP_COLUMNS.has(col)) continue;
    const sample = rows.find((r) => r[col] !== null && r[col] !== undefined);
    if (sample && typeof sample[col] === 'number') return col;
  }
  return null;
}

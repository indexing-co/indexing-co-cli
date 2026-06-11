const fs = require("node:fs");
const path = require("node:path");

export interface StreamSessionRecord {
  pipeline?: string;
  channel: string;
  url: string;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  lastEventAt?: string;
}

export interface AppState {
  recentStreams: StreamSessionRecord[];
}

export function loadState(statePath: string): AppState {
  try {
    if (!fs.existsSync(statePath)) {
      return { recentStreams: [] };
    }

    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      recentStreams: Array.isArray(parsed.recentStreams) ? parsed.recentStreams : [],
    };
  } catch {
    return { recentStreams: [] };
  }
}

export function saveState(statePath: string, state: AppState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function recordStreamSession(statePath: string, record: StreamSessionRecord): void {
  const state = loadState(statePath);
  state.recentStreams = [record, ...state.recentStreams].slice(0, 25);
  saveState(statePath, state);
}

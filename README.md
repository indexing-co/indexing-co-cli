# @indexing/cli

Primary CLI for [Indexing Co](https://www.indexing.co) — manage blockchain data pipelines, filters, transformations, and live event streams from your terminal or AI coding agent.

## Why a CLI

Modern AI coding agents (Claude Code, Codex CLI, Cursor, etc.) all have shell tool use. A CLI is the lowest-friction surface for any agent to drive Indexing Co — one `npx` command, no per-client config edits, no protocol-specific setup.

The MCP server at [indexing-co/indexing-co-mcp](https://github.com/indexing-co/indexing-co-mcp) remains available as an alternate for agents that prefer structured tool schemas.

## Install

```bash
npx -y @indexing/cli@latest --help
npm install -g @indexing/cli
```

Temporary fallback until the npm package is public:

```bash
npx -y github:indexing-co/indexing-co-cli --help
```

## Usage

```bash
indexing-co --help
indexing-co pipeline list
indexing-co pipeline list --json
```

## Auth

```bash
indexing-co auth login
```

Create or copy an API key in Console: sign in, open Account -> API Keys, then paste the active key into `indexing-co auth login`. New accounts include 10,000 free blocks and no card is required.

Resolution order:

1. `--api-key`
2. `INDEXING_CO_API_KEY`
3. `~/.indexing-co/credentials`

Watching a live Console session with `agent watch`, `agent state`, or `agent doctor` does not require an API key. Live block tests, deploys, pipeline mutations, and direct API calls do require an account API key. Never use browser JWTs, bearer headers, destination secrets, or private keys as CLI credentials.

## Commands

```
indexing-co pipeline    list | get | create | delete | backfill | networks
indexing-co filter      list | get | create | add | remove
indexing-co transformation  list | get | register | test
indexing-co stream      <pipeline> | subscriptions | status
indexing-co agent       watch | state | doctor
indexing-co query       <sql>
indexing-co events      get
indexing-co data        describe
indexing-co subgraph    parse
indexing-co stablecoin  list
indexing-co auth        login | status | logout
```

Run `indexing-co <command> --help` for usage.

## Output formats

Default: human-readable table. Pass `--json` for structured output (recommended for agents).

## Streaming

`indexing-co stream <pipeline>` resolves DIRECT pipelines and opens a websocket stream. `Ctrl+C` prints a summary with event count, duration, and throughput.

The CLI also exposes:

```bash
indexing-co stream subscriptions
indexing-co stream status
```

## Console State

Use the console state channel when an agent needs to follow what the user is viewing in the console app:

```bash
indexing-co agent watch
indexing-co agent watch --session <id> --once
indexing-co agent state --session <id> --json
indexing-co agent doctor --session <id>
```

Resolution order for the session id:

1. `--session`
2. `INDEXING_CO_SESSION_ID`
3. `~/.indexing-co/session-id`

Console URL resolution order:

1. `--console-url`
2. `INDEXING_CO_CONSOLE_URL`
3. `https://console.indexing.co`

For staging or local development, pass an explicit override:

```bash
indexing-co agent watch --session <id> --console-url https://staging.console.indexing.co
indexing-co agent doctor --session <id> --console-url https://staging.console.indexing.co --json
INDEXING_CO_CONSOLE_URL=http://localhost:5173 indexing-co agent watch --session <id>
```

Library usage:

```ts
import { getCurrentUserState, subscribeConsoleState } from "@indexing/cli";

const subscription = subscribeConsoleState({
  sessionId: "session-id",
  onEvent: (event) => console.log(event.type, event.data),
});

const snapshot = await getCurrentUserState({ sessionId: "session-id" });
subscription.unsubscribe();
```

## Completions

```bash
indexing-co completion bash
indexing-co completion zsh
indexing-co completion fish
```

## Development

```bash
npm run build
npm run typecheck
npm test
```

`INDEXING_CO_STAGING_API_KEY` enables the optional live integration test:

```bash
INDEXING_CO_STAGING_API_KEY=... npm run test:integration
```

## Notes

- The documented REST API covers pipelines, filters, and transformations directly. The CLI wraps those endpoints as-is.
- Data query, streaming URL resolution, and stablecoin lookup use defensive endpoint fallbacks because those surfaces are not fully documented in the public REST reference yet.

## License

MIT

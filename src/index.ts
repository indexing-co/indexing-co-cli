export {
  getAgentPairingHealth,
  getCurrentUserState,
  reportAgentActivity,
  resolveConsoleSessionId,
  resolveOptionalActivitySessionId,
  subscribeConsoleState,
} from "./lib/console-state";
export {
  getActiveConsoleSessionPath,
  getConsoleSessionScope,
  readActiveConsoleSession,
  readStoredSessionId,
  resolveOptionalConsoleSessionContext,
  writeActiveConsoleSession,
} from "./lib/console-session";
export type {
  AgentActivityEventInput,
  AgentActivityReportOptions,
  AgentEventsSnapshot,
  AgentPairingHealth,
  AgentPresenceSnapshot,
  ConsoleStateEvent,
  ConsoleStateSnapshot,
  ConsoleStateSubscription,
  ConsoleStateSubscriptionOptions,
} from "./lib/console-state";
export type {
  ActiveConsoleSession,
  ConsoleSessionContext,
} from "./lib/console-session";

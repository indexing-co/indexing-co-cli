export {
  getAgentPairingHealth,
  getCurrentUserState,
  readStoredSessionId,
  reportAgentActivity,
  resolveConsoleSessionId,
  resolveOptionalActivitySessionId,
  subscribeConsoleState,
} from "./lib/console-state";
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

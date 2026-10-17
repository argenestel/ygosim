import type { Player } from './types.js';

/**
 * The Antigravity CLI reads this file from $HOME/.gemini/config.  Keep the
 * names explicit: copying the whole Antigravity profile also copies unrelated
 * conversations, extensions, and browser state into a game sandbox.
 */
export const AGY_AUTH_KEYS = [
  'antigravityAuthStatus',
  'antigravityUnifiedStateSync.oauthToken',
] as const;

export interface AgyEventMetadata {
  conversationId?: string;
  model?: string;
  effort?: string;
}

export interface AgyCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const result = record(value)?.[key];
  return typeof result === 'string' && result.length > 0 ? result : undefined;
}

/**
 * Build the non-interactive command used for a scored Antigravity seat.
 *
 * MCP details are passed through the environment and materialized by the
 * private sandbox home.  In particular, the bearer token never appears in
 * argv, where it would be visible in process listings and failure reports.
 */
export function agyCommand(
  player: Player,
  url: string,
  workdir: string,
  prompt: string,
  sessionId: string,
  resume: boolean,
  authorization?: string,
  _customDecks = false,
): AgyCommand {
  if (player.cli !== 'agy') throw new Error('agyCommand requires an agy player');
  const keys = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
  // agy otherwise insists on the host Secret Service.  The sandbox provides
  // an isolated file token instead, and this marker selects that documented
  // headless storage path without exposing the host D-Bus session bus.
  env.SSH_CONNECTION = 'ygosim-isolated';
  env.AGY_MCP_URL = url;
  if (authorization) env.YGOSIM_MCP_TOKEN = authorization.replace(/^Bearer\s+/i, '');

  const args = [
    '--model', player.model,
    '--effort', player.effort ?? 'high',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--print-timeout', '0',
    '--sandbox',
    '--add-dir', workdir,
  ];
  if (resume) {
    if (!sessionId) throw new Error('Cannot resume agy without a conversation id');
    args.push('--conversation', sessionId);
  }
  // agy requires the print prompt to be attached to the flag.  A separate
  // argv entry is interpreted as the prompt and consumes the following flag.
  args.push(`--print=${prompt}`);
  return { command: 'agy', args, env };
}

/**
 * Materialize the only MCP configuration that belongs in an agy game home.
 * The caller writes this object with mode 0600 after checking the path.
 */
export function agyMcpConfig(url: string, authorization?: string): {
  mcpServers: { ygosim: { url: string; headers?: { Authorization: string } } };
} {
  return {
    mcpServers: {
      ygosim: {
        url,
        ...(authorization ? { headers: { Authorization: authorization } } : {}),
      },
    },
  };
}

/** Return the private MCP configuration path below an isolated HOME. */
export function agyMcpConfigPath(home: string): string {
  return `${home}/.gemini/config/mcp_config.json`;
}

/**
 * Extract only metadata emitted by the native stream-json protocol.
 * Current agy output uses init.conversation_id and init.model; result events
 * repeat conversation_id.  Unknown event shapes are deliberately ignored so
 * telemetry cannot be fabricated from user text or tool payloads.
 */
export function agyEventMetadata(event: unknown): AgyEventMetadata {
  const root = record(event);
  if (!root) return {};
  const init = record(root.init);
  const result = record(root.result);
  const conversationId = stringField(root, 'conversation_id')
    ?? stringField(root, 'conversationId')
    ?? stringField(init, 'conversation_id')
    ?? stringField(result, 'conversation_id');
  const model = stringField(init, 'model');
  const effort = stringField(init, 'effort') ?? stringField(root, 'effort');
  return { ...(conversationId ? { conversationId } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

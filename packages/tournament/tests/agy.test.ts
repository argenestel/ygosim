import { describe, expect, it, vi } from 'vitest';
import { AGY_AUTH_KEYS, agyCommand, agyEventMetadata, agyMcpConfig, agyMcpConfigPath } from '../src/agy.js';
import { getRosterPlayer } from '../src/roster.js';

describe('native Antigravity adapter', () => {
  it('uses print stream-json syntax and keeps MCP bearer credentials out of argv', () => {
    vi.stubEnv('PATH', '/fixture/bin');
    vi.stubEnv('HOME', '/fixture/home');
    vi.stubEnv('OPENAI_API_KEY', 'must-not-be-forwarded');
    const player = getRosterPlayer('agy-gemini-flash')!;
    const command = agyCommand(player, 'http://127.0.0.1:4123/mcp', '/fixture/game', 'Play now', '', false,
      'Bearer synthetic-agy-token');
    expect(command.command).toBe('agy');
    expect(command.args).toEqual([
      '--model', 'gemini-3.8-flash-high', '--effort', 'high', '--output-format', 'stream-json',
      '--disable-slash-commands', '--print-timeout', '0', '--sandbox', '--add-dir', '/fixture/game', '--print=Play now',
    ]);
    expect(command.env).toMatchObject({ PATH: '/fixture/bin', HOME: '/fixture/home', AGY_MCP_URL: 'http://127.0.0.1:4123/mcp',
      YGOSIM_MCP_TOKEN: 'synthetic-agy-token', SSH_CONNECTION: 'ygosim-isolated' });
    expect(command.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(command.args.join(' ')).not.toContain('synthetic-agy-token');
  });

  it('uses the native conversation id for resumptions and rejects an empty id', () => {
    const player = getRosterPlayer('agy-gemini-flash')!;
    const command = agyCommand(player, 'url', '/fixture/game', 'continue', 'conversation-fixture', true);
    expect(command.args.slice(-3)).toEqual(['--conversation', 'conversation-fixture', '--print=continue']);
    expect(() => agyCommand(player, 'url', '/fixture/game', 'continue', '', true)).toThrow('conversation id');
  });

  it('writes the documented streamable HTTP MCP shape and private path', () => {
    expect(agyMcpConfig('https://game.example/mcp', 'Bearer fixture-token')).toEqual({
      mcpServers: { ygosim: { url: 'https://game.example/mcp', headers: { Authorization: 'Bearer fixture-token' } } },
    });
    expect(agyMcpConfig('https://game.example/mcp')).toEqual({
      mcpServers: { ygosim: { url: 'https://game.example/mcp' } },
    });
    expect(agyMcpConfigPath('/private/home')).toBe('/private/home/.gemini/config/mcp_config.json');
    expect(AGY_AUTH_KEYS).toEqual(['antigravityAuthStatus', 'antigravityUnifiedStateSync.oauthToken']);
  });

  it('extracts only native init and result metadata', () => {
    expect(agyEventMetadata({
      event: 'init', conversation_id: 'conversation-fixture', init: { model: 'gemini-3.8-flash-high', effort: 'high' },
    })).toEqual({ conversationId: 'conversation-fixture', model: 'gemini-3.8-flash-high', effort: 'high' });
    expect(agyEventMetadata({ event: 'result', result: { conversation_id: 'conversation-fixture', response: 'user text' } }))
      .toEqual({ conversationId: 'conversation-fixture' });
    expect(agyEventMetadata({ event: 'message', message: { model: 'invented-model', effort: 'invented-effort' } })).toEqual({});
    expect(agyEventMetadata('not an event')).toEqual({});
  });
});

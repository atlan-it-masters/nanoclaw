import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Several vendor APIs here cannot be scoped read-only at the credential
// (NinjaOne, IT Glue, CIPP), so read-only access is enforced on the NanoClaw
// side: every mutating tool is listed in the server's `deniedTools` and has to
// reach the SDK as an exact `mcp__<server>__<tool>` disallowedTools entry.
//
// This guards the WIRING, not the helper that builds the patterns. A refactor
// that keeps the helper but stops feeding its output into the query options
// would re-enable device reboots, user disables and password resets against
// real client tenants — silently, with every other test still green.
//
// It also pins the denylist as a DENYlist: a narrower allowedTools list does
// not hide a server's other tools from the model (verified against this SDK),
// so absence from allowedTools is not a permission boundary and must never be
// mistaken for one.

let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-deny' };
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  lastOptions = undefined;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-denylist-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drive(mcpServers: Record<string, unknown>): Promise<void> {
  const provider = new ClaudeProvider({ mcpServers } as ConstructorParameters<typeof ClaudeProvider>[0]);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _ of q.events) {
    /* drain */
  }
}

function stdio(deniedTools?: string[]): Record<string, unknown> {
  return { type: 'stdio', command: 'true', args: [], ...(deniedTools ? { deniedTools } : {}) };
}

// A representative mutating tool from each vendor that genuinely cannot be
// scoped read-only at the credential.
const REAL_DENIED: Array<[server: string, tool: string]> = [
  ['ninjaone', 'ninjaone_devices_reboot'],
  ['ninjaone', 'ninjaone_tickets_create'],
  ['itglue', 'create_document'],
  ['cipp', 'cipp_reset_password'],
  ['cipp', 'cipp_disable_user'],
];

describe('deniedTools reaches the SDK as real disallowedTools entries', () => {
  it('every configured denied tool arrives as an exact mcp__server__tool entry', async () => {
    await drive({
      ninjaone: stdio(['ninjaone_devices_reboot', 'ninjaone_tickets_create']),
      itglue: stdio(['create_document']),
      cipp: stdio(['cipp_reset_password', 'cipp_disable_user']),
    });
    const disallowed = lastOptions?.disallowedTools as string[];
    for (const [server, tool] of REAL_DENIED) {
      expect(disallowed).toContain(`mcp__${server}__${tool}`);
    }
  });

  it('still allowlists the server wildcard so non-denied tools keep working', async () => {
    await drive({ ninjaone: stdio(['ninjaone_devices_reboot']) });
    expect(lastOptions?.allowedTools as string[]).toContain('mcp__ninjaone__*');
  });

  it('blocks by denylist, not by omission from the allowlist', async () => {
    await drive({ ninjaone: stdio(['ninjaone_devices_reboot']) });
    const allowed = lastOptions?.allowedTools as string[];
    const disallowed = lastOptions?.disallowedTools as string[];
    // The wildcard necessarily "allows" the denied tool; only the explicit
    // disallowedTools entry actually removes it.
    expect(allowed).toContain('mcp__ninjaone__*');
    expect(disallowed).toContain('mcp__ninjaone__ninjaone_devices_reboot');
  });

  it('adds no deny entries for a server that has none configured', async () => {
    await drive({ learn: stdio() });
    const disallowed = (lastOptions?.disallowedTools as string[]).filter((t) => t.startsWith('mcp__learn__'));
    expect(disallowed).toEqual([]);
  });

  it('sanitizes server names identically in the allow and deny patterns', async () => {
    // The SDK rewrites any char outside [A-Za-z0-9_-] to '_'. If the deny
    // pattern sanitized differently from the allow pattern the tool would be
    // allowlisted under one name and denied under a name that never matches.
    await drive({ 'ninja.one': stdio(['ninjaone_devices_reboot']) });
    expect(lastOptions?.allowedTools as string[]).toContain('mcp__ninja_one__*');
    expect(lastOptions?.disallowedTools as string[]).toContain('mcp__ninja_one__ninjaone_devices_reboot');
  });
});

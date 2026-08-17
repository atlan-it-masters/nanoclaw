/**
 * Integration tests for the trusted-auto-provision path (TEAMS_AUTO_PROVISION_DM).
 *
 * Covers:
 *  - Flag off (default): a first-time Teams DM still gets the owner-approval
 *    card, unchanged from the existing channel-registration flow.
 *  - Flag on: a first-time Teams DM skips the card, gets its own new agent
 *    group, is wired in, admitted as a member, and the triggering message
 *    replays (wakes the container) — no pending_channel_approvals row.
 *  - Flag on but the sender is in a group/channel (not a DM): still goes
 *    through the manual card — auto-provision is DM-only.
 *  - Flag on but the channel is not Teams: still goes through the manual
 *    card — auto-provision is Teams-only.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import type { ChannelDefaults } from '../../channels/adapter.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

const teamsDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('teams', { factory: () => null, defaults: teamsDefaults });

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    const row = getDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
    return row;
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-trusted-auto-provision',
    GROUPS_DIR: '/tmp/nanoclaw-test-trusted-auto-provision/groups',
  };
});

const { envOverride } = vi.hoisted(() => ({ envOverride: { current: {} as Record<string, string> } }));
vi.mock('../../env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const result: Record<string, string> = {};
    for (const key of keys) {
      if (envOverride.current[key] !== undefined) result[key] = envOverride.current[key];
    }
    return result;
  }),
}));

const TEST_DIR = '/tmp/nanoclaw-test-trusted-auto-provision';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  envOverride.current = {};
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  await import('./index.js'); // register hooks

  createAgentGroup({ id: 'ag-owner', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });

  upsertUser({ id: 'teams:owner', kind: 'teams', display_name: 'Owner', created_at: now() });
  grantRole({ user_id: 'teams:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

  createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'teams',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { getDb } = await import('../../db/connection.js');
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('teams:owner', 'teams', 'mg-dm-owner', now());

  deliverMock.mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function teamsDm(platformId: string, isGroup = false) {
  return {
    channelType: 'teams',
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: '29:colleague', senderName: 'Colleague', text: 'hi' }),
      timestamp: now(),
      isMention: true,
      isGroup,
    },
  };
}

describe('trusted auto-provision (TEAMS_AUTO_PROVISION_DM)', () => {
  it('flag off: still delivers the owner-approval card', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(teamsDm('dm-new-colleague'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const { getDb } = await import('../../db/connection.js');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('flag on: auto-provisions a new agent group, wires it, admits the sender, replays — no card', async () => {
    envOverride.current = { TEAMS_AUTO_PROVISION_DM: 'true' };
    const { routeInbound } = await import('../../router.js');
    const { wakeContainer } = await import('../../container-runner.js');

    await routeInbound(teamsDm('dm-new-colleague-2'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();

    const { getDb } = await import('../../db/connection.js');
    const pendingCount = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_channel_approvals').get() as { c: number })
      .c;
    expect(pendingCount).toBe(0);

    const agentGroups = getDb().prepare('SELECT * FROM agent_groups WHERE id != ?').all('ag-owner') as Array<{
      id: string;
      name: string;
    }>;
    expect(agentGroups).toHaveLength(1);
    expect(agentGroups[0].name).toBe('Atlan Assistant (Colleague)');

    const mga = getDb()
      .prepare('SELECT * FROM messaging_group_agents WHERE agent_group_id = ?')
      .get(agentGroups[0].id) as { engage_mode: string; engage_pattern: string | null; sender_scope: string };
    expect(mga).toBeDefined();
    expect(mga.engage_mode).toBe('pattern');
    expect(mga.engage_pattern).toBe('.');
    expect(mga.sender_scope).toBe('known');

    // Teams sender ids already carry a colon (e.g. "29:xxx"), so
    // extractAndUpsertUser does not add a "teams:" prefix — see the
    // "Some platforms already include a colon" comment above it.
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('29:colleague', agentGroups[0].id);
    expect(member).toBeDefined();

    expect(wakeContainer).toHaveBeenCalled();
  });

  it('flag on but group/channel context: still delivers the card', async () => {
    envOverride.current = { TEAMS_AUTO_PROVISION_DM: 'true' };
    const { routeInbound } = await import('../../router.js');
    await routeInbound(teamsDm('dm-new-colleague-group', true));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('flag on but a non-Teams channel: still delivers the card', async () => {
    envOverride.current = { TEAMS_AUTO_PROVISION_DM: 'true' };
    registerChannelAdapter('telegram-tap', {
      factory: () => null,
      defaults: teamsDefaults,
    });
    const { routeInbound } = await import('../../router.js');
    await routeInbound({
      channelType: 'telegram-tap',
      platformId: 'dm-new-colleague-telegram',
      threadId: null,
      message: {
        id: 'msg-tg-1',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'stranger', senderName: 'Stranger', text: 'hi' }),
        timestamp: now(),
        isMention: true,
        isGroup: false,
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
  });
});

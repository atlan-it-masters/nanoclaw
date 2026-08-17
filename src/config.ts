import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';
import type { McpServerConfig } from './container-config.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'DEFAULT_AGENT_PROVIDER',
  'CONTAINER_CPU_LIMIT',
  'CONTAINER_MEMORY_LIMIT',
  'CONTAINER_PIDS_LIMIT',
  'NANOCLAW_EGRESS_LOCKDOWN',
  'NANOCLAW_EGRESS_NETWORK',
  'ONECLI_GATEWAY_CONTAINER',
  'NINJAONE_CLIENT_ID',
  'NINJAONE_CLIENT_SECRET',
  'NINJAONE_REGION',
  'ITGLUE_API_KEY',
  'ITGLUE_REGION',
  'MS365_MAIL_TENANT_ID',
  'MS365_MAIL_CLIENT_ID',
  'MS365_MAIL_CLIENT_SECRET',
  'SENTINELONE_CONSOLE_BASE_URL',
  'SENTINELONE_API_TOKEN',
]);

/**
 * @deprecated WhatsApp adapter copies now read the ASSISTANT_NAME .env key
 * directly. Re-export retained one release for stale adapter copies
 * (origin/channels whatsapp.ts:42 imports it); scheduled for deletion.
 */
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';

// Instance-wide default agent provider for newly created groups. `claude` (the
// built-in provider) when unset, so existing installs are unaffected on upgrade.
// Applied only at group-creation time (stamped onto the config row) — never in
// provider resolution — so existing groups are never retroactively flipped.
// Per-group `ncl groups config update --provider` still overrides it.
export const DEFAULT_AGENT_PROVIDER = (
  process.env.DEFAULT_AGENT_PROVIDER ||
  envConfig.DEFAULT_AGENT_PROVIDER ||
  'claude'
).toLowerCase();

/**
 * @deprecated WhatsApp adapter copies now read the ASSISTANT_HAS_OWN_NUMBER
 * .env key directly. Re-export retained one release for stale adapter copies
 * (origin/channels whatsapp.ts:42 imports it); scheduled for deletion.
 */
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
// Local agent-template library. Committed but ships empty (+ README). Resolved
// once at load. Override to another LOCAL path via NANOCLAW_TEMPLATES_DIR; never
// a remote URL, never an ncl flag, never runtime-mutable.
export const TEMPLATES_DIR = process.env.NANOCLAW_TEMPLATES_DIR
  ? path.resolve(process.env.NANOCLAW_TEMPLATES_DIR)
  : path.resolve(PROJECT_ROOT, 'templates');

// Per-checkout image tag so two installs on the same host don't share
// `nanoclaw-agent:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `nanoclaw-install=${INSTALL_SLUG}`;
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY = process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
// Per-container resource caps, passed through to `docker run`. Default empty =
// no flag added = today's unbounded behavior (don't OOM existing OSS workloads).
// Operators opt in: CONTAINER_CPU_LIMIT=2, CONTAINER_MEMORY_LIMIT=8g.
export const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || '';
export const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || '';

// Fork-bomb backstop. cgroups v2 counts THREADS, not processes, and Chromium is
// thread-hungry — a browsing agent with several tabs open runs into the high
// hundreds. Keep well above that; too low a cap kills the container mid-turn or
// blocks it from spawning subprocesses, and neither is reported as a PID limit.
// Empty = no cap.
export const CONTAINER_PIDS_LIMIT = process.env.CONTAINER_PIDS_LIMIT ?? envConfig.CONTAINER_PIDS_LIMIT ?? '2048';

// Egress lockdown — force all agent traffic through the OneCLI gateway on a
// no-internet Docker network. Off by default; consumed by src/egress-lockdown.ts.
export const EGRESS_LOCKDOWN = (process.env.NANOCLAW_EGRESS_LOCKDOWN || envConfig.NANOCLAW_EGRESS_LOCKDOWN) === 'true';
export const EGRESS_NETWORK =
  process.env.NANOCLAW_EGRESS_NETWORK || envConfig.NANOCLAW_EGRESS_NETWORK || 'nanoclaw-egress';
export const ONECLI_GATEWAY_CONTAINER =
  process.env.ONECLI_GATEWAY_CONTAINER || envConfig.ONECLI_GATEWAY_CONTAINER || 'onecli';

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// Instance-wide default MCP servers stamped onto newly created groups (bare and
// template-based), same "new groups only, never retroactive" contract as
// DEFAULT_AGENT_PROVIDER above. Existing groups need `ncl groups config
// add-mcp-server` / `remove-mcp-server` to change. Empty unless the install has
// configured NinjaOne credentials in .env.
const ninjaoneClientId = process.env.NINJAONE_CLIENT_ID || envConfig.NINJAONE_CLIENT_ID;
const ninjaoneClientSecret = process.env.NINJAONE_CLIENT_SECRET || envConfig.NINJAONE_CLIENT_SECRET;
const ninjaoneRegion = process.env.NINJAONE_REGION || envConfig.NINJAONE_REGION || 'us';
const itglueApiKey = process.env.ITGLUE_API_KEY || envConfig.ITGLUE_API_KEY;
const itglueRegion = process.env.ITGLUE_REGION || envConfig.ITGLUE_REGION || 'us';
const ms365MailTenantId = process.env.MS365_MAIL_TENANT_ID || envConfig.MS365_MAIL_TENANT_ID;
const ms365MailClientId = process.env.MS365_MAIL_CLIENT_ID || envConfig.MS365_MAIL_CLIENT_ID;
const ms365MailClientSecret = process.env.MS365_MAIL_CLIENT_SECRET || envConfig.MS365_MAIL_CLIENT_SECRET;
const sentineloneConsoleBaseUrl = process.env.SENTINELONE_CONSOLE_BASE_URL || envConfig.SENTINELONE_CONSOLE_BASE_URL;
const sentineloneApiToken = process.env.SENTINELONE_API_TOKEN || envConfig.SENTINELONE_API_TOKEN;
export const DEFAULT_MCP_SERVERS: Record<string, McpServerConfig> = {
  // Public, unauthenticated remote server — no credential gating needed.
  learn: {
    type: 'http',
    url: 'https://learn.microsoft.com/api/mcp',
  },
  ...(ninjaoneClientId && ninjaoneClientSecret
    ? {
        ninjaone: {
          command: 'ninjaone-mcp',
          args: [],
          env: {
            NINJAONE_CLIENT_ID: ninjaoneClientId,
            NINJAONE_CLIENT_SECRET: ninjaoneClientSecret,
            NINJAONE_REGION: ninjaoneRegion,
          },
        },
      }
    : {}),
  ...(itglueApiKey
    ? {
        itglue: {
          command: 'itglue-mcp',
          args: [],
          env: {
            ITGLUE_API_KEY: itglueApiKey,
            ITGLUE_REGION: itglueRegion,
          },
        },
      }
    : {}),
  // App-only (client-credentials) Graph auth via the wrapper in
  // container/ms365-mail-mcp-wrapper.js — @softeria/ms-365-mcp-server has no
  // client-credentials mode of its own. Read-only, restricted to the
  // shared-mailbox tools (which hit /users/{id}/... rather than /me/...,
  // the only Graph shape an app-only token can use). Mailbox access itself is
  // scoped at the Exchange Online Application Access Policy layer, not here.
  ...(ms365MailTenantId && ms365MailClientId && ms365MailClientSecret
    ? {
        m365mail: {
          command: '/usr/local/bin/ms365-mail-mcp-wrapper.js',
          args: [
            '--org-mode',
            '--read-only',
            '--enabled-tools',
            '^(list-shared-mailbox-messages|get-shared-mailbox-message|list-shared-mailbox-folder-messages)$',
          ],
          env: {
            MS365_MAIL_TENANT_ID: ms365MailTenantId,
            MS365_MAIL_CLIENT_ID: ms365MailClientId,
            MS365_MAIL_CLIENT_SECRET: ms365MailClientSecret,
          },
        },
      }
    : {}),
  // Multitenant Streamable HTTP wrapper (see container/README notes at
  // ghcr.io/wyre-technology/sentinelone-mcp) running as a standalone
  // companion service on this host, bound to the docker bridge gateway IP —
  // same pattern as the OneCLI gateway container. Credentials ride as HTTP
  // headers per request rather than container env, since the proxy is
  // multi-tenant by design.
  ...(sentineloneConsoleBaseUrl && sentineloneApiToken
    ? {
        sentinelone: {
          type: 'http',
          url: 'http://host.docker.internal:8080/mcp',
          headers: {
            'x-purplemcp-token': sentineloneApiToken,
            'x-purplemcp-base-url': sentineloneConsoleBaseUrl,
          },
        },
      }
    : {}),
};

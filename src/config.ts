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
  'NANOCLAW_NO_PROXY_HOSTS',
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
  'UNIFI_API_KEY',
  'CIPP_BASE_URL',
  'CIPP_TENANT_ID',
  'CIPP_CLIENT_ID',
  'CIPP_CLIENT_SECRET',
  'WAZUH_API_HOST',
  'WAZUH_API_PORT',
  'WAZUH_API_USERNAME',
  'WAZUH_API_PASSWORD',
  'WAZUH_INDEXER_HOST',
  'WAZUH_INDEXER_PORT',
  'WAZUH_INDEXER_USERNAME',
  'WAZUH_INDEXER_PASSWORD',
  'WAZUH_VERIFY_SSL',
  'BOOKSTACK_BASE_URL',
  'BOOKSTACK_TOKEN_ID',
  'BOOKSTACK_TOKEN_SECRET',
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

// Extra hosts (bare hostnames or IPs) that bypass the OneCLI egress proxy,
// on top of the always-exempt host.docker.internal — see container-runner.ts.
// The OneCLI gateway container sits in its own network namespace and can't
// route to a private LAN target (e.g. an on-prem Wazuh/CIPP/whatever host)
// even though the agent container itself can via the host gateway; MITM-
// proxying such a request through OneCLI just fails with a forwarding error.
// Comma-separated, e.g. "10.248.8.112,10.248.8.113".
export const NANOCLAW_NO_PROXY_HOSTS = (process.env.NANOCLAW_NO_PROXY_HOSTS || envConfig.NANOCLAW_NO_PROXY_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

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
const unifiApiKey = process.env.UNIFI_API_KEY || envConfig.UNIFI_API_KEY;
const cippBaseUrl = process.env.CIPP_BASE_URL || envConfig.CIPP_BASE_URL;
const cippTenantId = process.env.CIPP_TENANT_ID || envConfig.CIPP_TENANT_ID;
const cippClientId = process.env.CIPP_CLIENT_ID || envConfig.CIPP_CLIENT_ID;
const cippClientSecret = process.env.CIPP_CLIENT_SECRET || envConfig.CIPP_CLIENT_SECRET;
const wazuhApiHost = process.env.WAZUH_API_HOST || envConfig.WAZUH_API_HOST;
const wazuhApiPort = process.env.WAZUH_API_PORT || envConfig.WAZUH_API_PORT || '55000';
const wazuhApiUsername = process.env.WAZUH_API_USERNAME || envConfig.WAZUH_API_USERNAME;
const wazuhApiPassword = process.env.WAZUH_API_PASSWORD || envConfig.WAZUH_API_PASSWORD;
const wazuhIndexerHost = process.env.WAZUH_INDEXER_HOST || envConfig.WAZUH_INDEXER_HOST;
const wazuhIndexerPort = process.env.WAZUH_INDEXER_PORT || envConfig.WAZUH_INDEXER_PORT || '9200';
const wazuhIndexerUsername = process.env.WAZUH_INDEXER_USERNAME || envConfig.WAZUH_INDEXER_USERNAME;
const wazuhIndexerPassword = process.env.WAZUH_INDEXER_PASSWORD || envConfig.WAZUH_INDEXER_PASSWORD;
const wazuhVerifySsl = process.env.WAZUH_VERIFY_SSL || envConfig.WAZUH_VERIFY_SSL || 'false';
// Strip a trailing slash — bookstack-mcp concatenates BASE_URL + '/api/...'
// verbatim, so a trailing slash produces a double slash (e.g.
// atlan.help//api/books) that 404s. Confirmed directly against the real API.
const bookstackBaseUrl = (process.env.BOOKSTACK_BASE_URL || envConfig.BOOKSTACK_BASE_URL)?.replace(/\/+$/, '');
const bookstackTokenId = process.env.BOOKSTACK_TOKEN_ID || envConfig.BOOKSTACK_TOKEN_ID;
const bookstackTokenSecret = process.env.BOOKSTACK_TOKEN_SECRET || envConfig.BOOKSTACK_TOKEN_SECRET;
export const DEFAULT_MCP_SERVERS: Record<string, McpServerConfig> = {
  // Public, unauthenticated remote server — no credential gating needed.
  learn: {
    type: 'http',
    url: 'https://learn.microsoft.com/api/mcp',
  },
  // NinjaOne's own API token can't be scoped read-only, so the read/write
  // split is enforced here instead: deniedTools blocks every mutating tool
  // (device reboot, org creation, alert resets, ticket create/update/comment)
  // — verified via a real disallowedTools test that this genuinely hides the
  // tool from the model, not just discourages calling it.
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
          deniedTools: [
            'ninjaone_devices_reboot',
            'ninjaone_organizations_create',
            'ninjaone_alerts_reset',
            'ninjaone_alerts_reset_all',
            'ninjaone_tickets_create',
            'ninjaone_tickets_update',
            'ninjaone_tickets_add_comment',
          ],
        },
      }
    : {}),
  // Same reasoning as ninjaone above — IT Glue's API key has no read-only
  // scope either. Blocks create/update/delete/publish/archive on locations
  // and documents. get_password/search_passwords stay reachable (they read,
  // not write) — that's a data-sensitivity question, not a mutation risk.
  ...(itglueApiKey
    ? {
        itglue: {
          command: 'itglue-mcp',
          args: [],
          env: {
            ITGLUE_API_KEY: itglueApiKey,
            ITGLUE_REGION: itglueRegion,
          },
          deniedTools: [
            'create_location',
            'update_location',
            'create_document',
            'create_document_section',
            'update_document_section',
            'delete_document_section',
            'publish_document',
            'archive_document',
            'unarchive_document',
          ],
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
  // PyPI package (unifi-mcp-server), installed into the agent image via uv
  // (see container/Dockerfile) since the base image is Node-only. Pinned to
  // cloud-ea per the operator's request — Early Access API, api.ui.com/ea/*,
  // lower rate limit (100 req/min) than the stable cloud-v1 API.
  ...(unifiApiKey
    ? {
        unifi: {
          command: 'unifi-mcp-server',
          args: [],
          env: {
            UNIFI_API_KEY: unifiApiKey,
            UNIFI_API_TYPE: 'cloud-ea',
          },
        },
      }
    : {}),
  // Built from source into the agent image (see container/Dockerfile) —
  // cipp-mcp isn't published to a package registry yet. OAuth client-
  // credentials against the CIPP Azure Function App backend; CIPP_BASE_URL
  // must be the Function App URL (*.azurewebsites.net), never the SWA/
  // frontend URL.
  ...(cippBaseUrl && cippTenantId && cippClientId && cippClientSecret
    ? {
        cipp: {
          command: 'cipp-mcp',
          args: [],
          env: {
            CIPP_BASE_URL: cippBaseUrl,
            CIPP_TENANT_ID: cippTenantId,
            CIPP_CLIENT_ID: cippClientId,
            CIPP_CLIENT_SECRET: cippClientSecret,
          },
          // CIPP itself marks its mutating tools destructiveHint:true, but
          // that's an MCP annotation — a hint the model can see, not
          // something any client is forced to obey. Blocks every
          // create/edit/disable/reset/revoke/offboard/set_*/delete tool,
          // plus run_standards_check and add_scheduled_item (both trigger
          // backend jobs rather than reading state).
          deniedTools: [
            'cipp_create_user',
            'cipp_edit_user',
            'cipp_disable_user',
            'cipp_reset_password',
            'cipp_reset_mfa',
            'cipp_revoke_sessions',
            'cipp_offboard_user',
            'cipp_create_group',
            'cipp_set_out_of_office',
            'cipp_set_email_forwarding',
            'cipp_create_standard_template',
            'cipp_delete_standard_template',
            'cipp_run_standards_check',
            'cipp_add_scheduled_item',
          ],
        },
      }
    : {}),
  // Prebuilt static binary baked into the image (see container/Dockerfile) —
  // no crates.io/npm/pip distribution exists. Entirely read-only by design
  // (every tool is a get/search/list against the Wazuh manager API or
  // Indexer) — no deniedTools needed. Note: only get_wazuh_alert_summary
  // needs the Indexer (WAZUH_INDEXER_*); every other tool talks to the
  // manager API (WAZUH_API_*) directly.
  ...(wazuhApiHost &&
  wazuhApiUsername &&
  wazuhApiPassword &&
  wazuhIndexerHost &&
  wazuhIndexerUsername &&
  wazuhIndexerPassword
    ? {
        wazuh: {
          command: 'mcp-server-wazuh',
          args: [],
          env: {
            WAZUH_API_HOST: wazuhApiHost,
            WAZUH_API_PORT: wazuhApiPort,
            WAZUH_API_USERNAME: wazuhApiUsername,
            WAZUH_API_PASSWORD: wazuhApiPassword,
            WAZUH_INDEXER_HOST: wazuhIndexerHost,
            WAZUH_INDEXER_PORT: wazuhIndexerPort,
            WAZUH_INDEXER_USERNAME: wazuhIndexerUsername,
            WAZUH_INDEXER_PASSWORD: wazuhIndexerPassword,
            WAZUH_VERIFY_SSL: wazuhVerifySsl,
          },
        },
      }
    : {}),
  // Installed via pnpm (container/cli-tools.json), a plain public npm
  // package. Write tools are genuinely gated at the source — verified by
  // diffing tools/list with BOOKSTACK_ENABLE_WRITE on vs off (20 tools vs
  // 38, not just a documented default) — so BOOKSTACK_ENABLE_WRITE=false is
  // set explicitly here rather than relying on the package's own default.
  ...(bookstackBaseUrl && bookstackTokenId && bookstackTokenSecret
    ? {
        bookstack: {
          command: 'bookstack-mcp',
          args: [],
          env: {
            BOOKSTACK_BASE_URL: bookstackBaseUrl,
            BOOKSTACK_TOKEN_ID: bookstackTokenId,
            BOOKSTACK_TOKEN_SECRET: bookstackTokenSecret,
            BOOKSTACK_ENABLE_WRITE: 'false',
          },
        },
      }
    : {}),
};

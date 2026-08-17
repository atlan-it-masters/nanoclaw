#!/usr/bin/env node
/**
 * Wrapper around @softeria/ms-365-mcp-server for app-only (client-credentials)
 * Microsoft Graph auth. The upstream server has no built-in client-credentials
 * flow — it's built around delegated (interactive user) login, with a
 * bring-your-own-token (BYOT) escape hatch for external token management.
 *
 * This fetches a fresh Graph app-only access token via OAuth2 client
 * credentials on every startup, then execs the real server with
 * MS365_MCP_OAUTH_TOKEN set. A token lasts ~60 minutes; nanoclaw agent
 * containers are recreated well within that window (session absolute
 * ceiling is 30 minutes), so a fresh fetch per container start is enough —
 * no in-process refresh loop needed.
 *
 * Requires: MS365_MAIL_TENANT_ID, MS365_MAIL_CLIENT_ID, MS365_MAIL_CLIENT_SECRET.
 * Any other args/env are forwarded to the real `ms-365-mcp-server` binary
 * unchanged (e.g. --org-mode --read-only --enabled-tools '...').
 */
const { spawnSync } = require('child_process');

async function main() {
  const tenantId = process.env.MS365_MAIL_TENANT_ID;
  const clientId = process.env.MS365_MAIL_CLIENT_ID;
  const clientSecret = process.env.MS365_MAIL_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    console.error(
      'ms365-mail-mcp-wrapper: missing MS365_MAIL_TENANT_ID / MS365_MAIL_CLIENT_ID / MS365_MAIL_CLIENT_SECRET',
    );
    process.exit(1);
  }

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });

  let accessToken;
  try {
    const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`ms365-mail-mcp-wrapper: token request failed (${res.status}): ${body}`);
      process.exit(1);
    }
    const data = await res.json();
    accessToken = data.access_token;
  } catch (err) {
    console.error('ms365-mail-mcp-wrapper: token request errored:', err);
    process.exit(1);
  }

  const child = spawnSync('ms-365-mcp-server', process.argv.slice(2), {
    stdio: 'inherit',
    env: {
      ...process.env,
      MS365_MCP_OAUTH_TOKEN: accessToken,
    },
  });
  process.exit(child.status ?? 1);
}

main();

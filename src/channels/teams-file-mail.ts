/**
 * Teams can't take file attachments — @chat-adapter/teams sends them as
 * inline base64 data URIs, which the Bot Connector API rejects outright
 * (HTTP 400, confirmed 5/5 real attempts). This wraps a Teams ChannelAdapter
 * so any outbound message carrying files is emailed instead, via Microsoft
 * Graph sendMail from the helpdesk@atlan.nl shared mailbox, with the
 * recipient's address resolved from the same Teams conversation through the
 * Bot Framework connector's own members endpoint (the bot's existing
 * TEAMS_APP_ID/TEAMS_APP_PASSWORD credentials — no extra Graph permission
 * needed for this part, unlike sendMail itself).
 */
import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import type { ChannelAdapter, OutboundMessage } from './adapter.js';

const FROM_MAILBOX = 'helpdesk@atlan.nl';

// Both tokens are cached process-wide (this runs on the long-lived host,
// not a short-lived container) with a safety margin before expiry, rather
// than fetched fresh per file — a file send is rare, but a burst of
// several files in one turn (as happened for Mario: 3 files) shouldn't
// mean 3 token round-trips against two different Microsoft endpoints.
let botFrameworkToken: { value: string; expiresAt: number } | null = null;
let graphMailToken: { value: string; expiresAt: number } | null = null;

async function fetchClientCredentialsToken(
  tenantId: string,
  clientId: string,
  clientSecret: string,
  scope: string,
): Promise<{ value: string; expiresAt: number }> {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  // 60s safety margin so a token never expires mid-call.
  return { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
}

/**
 * A Bot Framework connector token, scoped to the bot's OWN tenant (the
 * generic https://login.microsoftonline.com/botframework.com sink tenant
 * only works for legacy MultiTenant bot registrations — this bot is
 * SingleTenant, confirmed by AADSTS700016 when tried against botframework.com).
 */
async function getBotFrameworkToken(env: Record<string, string>): Promise<string> {
  if (botFrameworkToken && botFrameworkToken.expiresAt > Date.now()) return botFrameworkToken.value;
  botFrameworkToken = await fetchClientCredentialsToken(
    env.TEAMS_APP_TENANT_ID,
    env.TEAMS_APP_ID,
    env.TEAMS_APP_PASSWORD,
    'https://api.botframework.com/.default',
  );
  return botFrameworkToken.value;
}

async function getGraphMailToken(env: Record<string, string>): Promise<string> {
  if (graphMailToken && graphMailToken.expiresAt > Date.now()) return graphMailToken.value;
  graphMailToken = await fetchClientCredentialsToken(
    env.MS365_MAIL_TENANT_ID,
    env.MS365_MAIL_CLIENT_ID,
    env.MS365_MAIL_CLIENT_SECRET,
    'https://graph.microsoft.com/.default',
  );
  return graphMailToken.value;
}

function base64UrlDecode(segment: string): string {
  const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
  return Buffer.from(padded, 'base64url').toString('utf-8');
}

/**
 * threadId format is `teams:<base64url(conversationId)>:<base64url(serviceUrl)>`
 * (@chat-adapter/teams's own encoding — decoded here independently rather
 * than reaching into the adapter's internals, since it isn't exported).
 */
function decodeTeamsThreadId(threadId: string): { conversationId: string; serviceUrl: string } | null {
  const parts = threadId.split(':');
  // conversationId itself starts with "a:" or "19:" and was never split on —
  // this whole segment is one base64url blob, so only split on the FIRST and
  // LAST colon: teams : <conv-b64> : <svc-b64>
  if (parts.length < 3 || parts[0] !== 'teams') return null;
  const serviceUrlB64 = parts[parts.length - 1];
  const conversationB64 = parts.slice(1, -1).join(':');
  try {
    return {
      conversationId: base64UrlDecode(conversationB64),
      serviceUrl: base64UrlDecode(serviceUrlB64),
    };
  } catch (err) {
    log.warn('teams-file-mail: failed to decode threadId', { threadId, err });
    return null;
  }
}

interface BotFrameworkMember {
  id: string;
  name?: string;
  email?: string;
  userPrincipalName?: string;
}

/**
 * Resolves the one human recipient in a Teams conversation. Only handles
 * the 1:1 personal-assistant DM shape this bot actually runs in (confirmed:
 * the bot itself does not appear in this endpoint's response for a DM) —
 * a group/channel with more than one human member returns null rather than
 * guessing which one should get the file.
 */
async function resolveTeamsRecipientEmail(
  env: Record<string, string>,
  serviceUrl: string,
  conversationId: string,
): Promise<string | null> {
  const token = await getBotFrameworkToken(env);
  const url = new URL(`v3/conversations/${encodeURIComponent(conversationId)}/members`, serviceUrl);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Bot Framework conversation members request failed (${res.status}): ${await res.text()}`);
  }
  const members = (await res.json()) as BotFrameworkMember[];
  const withEmail = members.filter((m) => m.email || m.userPrincipalName);
  if (withEmail.length !== 1) {
    log.warn('teams-file-mail: expected exactly one human member with an email, skipping email fallback', {
      conversationId,
      memberCount: members.length,
      withEmailCount: withEmail.length,
    });
    return null;
  }
  return withEmail[0].email ?? withEmail[0].userPrincipalName ?? null;
}

// Graph sendMail's practical ceiling for inline (non-upload-session)
// attachments — base64 adds ~33%, and the whole message (headers + body +
// attachments) has to clear Graph's ~4MB request limit. Stay well under it
// rather than finding the exact edge in production.
const MAX_INLINE_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export async function sendFileEmail(
  env: Record<string, string>,
  toEmail: string,
  subjectText: string,
  files: { filename: string; data: Buffer }[],
): Promise<{ sent: string[]; skipped: string[] }> {
  const sent: string[] = [];
  const skipped: string[] = [];
  const attachments = [];
  for (const f of files) {
    if (f.data.byteLength > MAX_INLINE_ATTACHMENT_BYTES) {
      skipped.push(f.filename);
      continue;
    }
    attachments.push({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: f.filename,
      contentBytes: f.data.toString('base64'),
    });
    sent.push(f.filename);
  }
  if (attachments.length === 0) return { sent, skipped };

  const token = await getGraphMailToken(env);
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${FROM_MAILBOX}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: subjectText.slice(0, 200) || 'Files from Atlan Assistant',
        body: { contentType: 'Text', content: subjectText },
        toRecipients: [{ emailAddress: { address: toEmail } }],
        attachments,
      },
      // Every send here is a one-off file delivery on behalf of a Teams
      // conversation, not correspondence anyone needs to find again from
      // the shared mailbox later — keep Sent Items from filling up with
      // them. The Teams conversation itself remains the record.
      saveToSentItems: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`Graph sendMail failed (${res.status}): ${await res.text()}`);
  }
  return { sent, skipped };
}

/**
 * Wraps a Teams ChannelAdapter's deliver() so file-bearing messages go out
 * by email instead of the broken inline-attachment path. Falls through to
 * the original adapter unchanged for anything without files, and for
 * anything with files when MS365 mail isn't configured on this install
 * (readEnvFile returns falsy — same "optional integration" convention as
 * every other credential-gated feature here).
 */
export function withTeamsFileEmailFallback(adapter: ChannelAdapter): ChannelAdapter {
  const originalDeliver = adapter.deliver.bind(adapter);
  return {
    ...adapter,
    async deliver(platformId: string, threadId: string | null, message: OutboundMessage) {
      if (!message.files || message.files.length === 0) {
        return originalDeliver(platformId, threadId, message);
      }

      const env = readEnvFile([
        'TEAMS_APP_ID',
        'TEAMS_APP_PASSWORD',
        'TEAMS_APP_TENANT_ID',
        'MS365_MAIL_TENANT_ID',
        'MS365_MAIL_CLIENT_ID',
        'MS365_MAIL_CLIENT_SECRET',
      ]);
      if (!env.MS365_MAIL_TENANT_ID || !env.MS365_MAIL_CLIENT_ID || !env.MS365_MAIL_CLIENT_SECRET) {
        return originalDeliver(platformId, threadId, message);
      }

      const content = message.content as Record<string, unknown>;
      const text = (content.markdown as string) || (content.text as string) || '';
      const decoded = decodeTeamsThreadId(threadId ?? platformId);

      try {
        if (!decoded) throw new Error('could not decode Teams threadId/platformId');
        const toEmail = await resolveTeamsRecipientEmail(env, decoded.serviceUrl, decoded.conversationId);
        if (!toEmail) throw new Error('could not resolve a single recipient email for this conversation');

        const { sent, skipped } = await sendFileEmail(
          env,
          toEmail,
          text || 'Files from Atlan Assistant',
          message.files,
        );
        if (sent.length === 0)
          throw new Error(`all files exceeded ${MAX_INLINE_ATTACHMENT_BYTES} bytes: ${skipped.join(', ')}`);

        log.info('teams-file-mail: sent file(s) by email', { toEmail, sent, skipped });
        const note =
          `\n\n📎 Sent by email to ${toEmail}: ${sent.join(', ')}` +
          (skipped.length > 0 ? ` (too large to email: ${skipped.join(', ')})` : '');
        return originalDeliver(platformId, threadId, {
          ...message,
          content: { ...content, markdown: undefined, text: (text || '') + note },
          files: undefined,
        });
      } catch (err) {
        log.error('teams-file-mail: email fallback failed, notifying requester instead of silently failing', {
          platformId,
          threadId,
          fileNames: message.files.map((f) => f.filename),
          err,
        });
        const note = `\n\n⚠️ Could not deliver the attached file(s) (${message.files.map((f) => f.filename).join(', ')}) — Teams file delivery is broken and the email fallback failed too. This has been logged.`;
        return originalDeliver(platformId, threadId, {
          ...message,
          content: { ...content, markdown: undefined, text: (text || '') + note },
          files: undefined,
        });
      }
    },
  };
}

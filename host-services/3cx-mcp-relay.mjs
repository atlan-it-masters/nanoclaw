#!/usr/bin/env node
/**
 * Host-side relay for the 3CX V20 (Update 10+) native MCP endpoint.
 *
 * Agents reach this over the docker bridge (http://host.docker.internal:8091/mcp)
 * the same way they reach the SentinelOne companion. The relay:
 *
 *   - holds the 3CX service-principal secret and the OAuth token on the HOST
 *     only (client_credentials, scope "mcp", refreshed before expiry) — agent
 *     containers never see either;
 *   - filters tools: only tools 3CX annotates `readOnlyHint: true` are listed
 *     or callable (or exactly THREECX_ALLOWED_TOOLS when set), so raising the
 *     service principal's 3CX role adds read-only tools, never mutating ones;
 *   - requires a relay token from callers (THREECX_RELAY_TOKEN), so nothing
 *     else on the bridge can use the PBX through it.
 *
 * Config comes from the NanoClaw .env (THREECX_*), read on start. Zero deps.
 * Run: node host-services/3cx-mcp-relay.mjs  (systemd unit alongside).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const env = { ...readEnv(path.join(ROOT, '.env')), ...process.env };
const BASE = (env.THREECX_BASE_URL || '').replace(/\/+$/, '');
const CLIENT_ID = env.THREECX_CLIENT_ID;
const CLIENT_SECRET = env.THREECX_CLIENT_SECRET;
const RELAY_TOKEN = env.THREECX_RELAY_TOKEN;
const HOST = env.THREECX_RELAY_HOST || '172.17.0.1';
const PORT = Number(env.THREECX_RELAY_PORT || 8091);
const EXPLICIT = (env.THREECX_ALLOWED_TOOLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

for (const [k, v] of Object.entries({ BASE, CLIENT_ID, CLIENT_SECRET, RELAY_TOKEN })) {
  if (!v) {
    console.error(`3cx-mcp-relay: missing ${k} (THREECX_* in .env)`);
    process.exit(1);
  }
}

const log = (msg, extra = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// ---- Upstream auth ----------------------------------------------------------

let token = null; // { value, expiresAt }

async function upstreamToken() {
  if (token && Date.now() < token.expiresAt - 120_000) return token.value;
  const res = await fetch(`${BASE}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'mcp',
    }),
  });
  if (!res.ok) throw new Error(`3CX token request failed (${res.status})`);
  const data = await res.json();
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  log('token refreshed', { expiresIn: data.expires_in });
  return token.value;
}

// ---- Tool policy ------------------------------------------------------------

// name → allowed, learned from the upstream tools/list (refreshed every list).
const policy = new Map();

const isAllowed = (tool) =>
  EXPLICIT.length > 0 ? EXPLICIT.includes(tool.name) : tool.annotations?.readOnlyHint === true;

async function ensurePolicy(sessionId) {
  if (policy.size > 0) return;
  const reply = await upstream({ jsonrpc: '2.0', id: '__policy', method: 'tools/list', params: {} }, sessionId);
  for (const t of reply.body?.result?.tools ?? []) policy.set(t.name, isAllowed(t));
}

// ---- Upstream call ----------------------------------------------------------

async function upstream(message, sessionId, retried = false) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await upstreamToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  if (res.status === 401 && !retried) {
    token = null; // revoked or rotated early: refetch once
    return upstream(message, sessionId, true);
  }
  const text = await res.text();
  let body = null;
  if (text) {
    // Streamable HTTP may answer as SSE; the JSON-RPC reply is in a data: line.
    const sse = [...text.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]);
    const candidates = sse.length ? sse : [text];
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c);
        if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) body = parsed;
      } catch {
        /* not JSON — leave body null */
      }
    }
  }
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body };
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleMessage(msg, sessionId) {
  if (msg.method === 'tools/call') {
    await ensurePolicy(sessionId);
    const name = msg.params?.name;
    if (!policy.get(name)) {
      log('blocked tool call', { tool: name });
      return { status: 200, body: rpcError(msg.id, -32601, `Tool "${name}" is not allowed through this relay`) };
    }
  }
  const reply = await upstream(msg, sessionId);
  if (msg.method === 'tools/list' && reply.body?.result?.tools) {
    const all = reply.body.result.tools;
    policy.clear();
    for (const t of all) policy.set(t.name, isAllowed(t));
    reply.body.result.tools = all.filter((t) => policy.get(t.name));
    log('tools listed', { upstream: all.length, exposed: reply.body.result.tools.length });
  }
  if (msg.method === 'tools/call') log('tool call', { tool: msg.params?.name, ok: !reply.body?.error });
  return reply;
}

// ---- HTTP server ------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://relay');
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' });
    if (req.headers.authorization !== `Bearer ${RELAY_TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    // No server-initiated stream: the spec lets a server answer GET with 405.
    if (req.method === 'GET') return send(res, 405, undefined, { Allow: 'POST, DELETE' });
    if (req.method === 'DELETE') return send(res, 200, undefined);
    if (req.method !== 'POST') return send(res, 405, undefined, { Allow: 'POST, DELETE' });

    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) return send(res, 413, { error: 'payload too large' });
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(res, 400, rpcError(null, -32700, 'Parse error'));
    }
    if (Array.isArray(msg)) return send(res, 400, rpcError(null, -32600, 'Batching is not supported'));

    const sessionId = req.headers['mcp-session-id'];
    const reply = await handleMessage(msg, sessionId);
    const headers = reply.sessionId ? { 'Mcp-Session-Id': reply.sessionId } : {};
    if (msg.id === undefined || msg.id === null) return send(res, 202, undefined, headers); // notification
    if (!reply.body) return send(res, 502, rpcError(msg.id, -32603, `3CX returned HTTP ${reply.status}`), headers);
    return send(res, 200, reply.body, headers);
  } catch (err) {
    log('relay error', { error: String(err.message || err) });
    return send(res, 502, rpcError(null, -32603, 'Upstream 3CX error'));
  }
});

server.listen(PORT, HOST, () =>
  log('3cx-mcp-relay listening', {
    host: HOST,
    port: PORT,
    upstream: BASE,
    policy: EXPLICIT.length ? `explicit: ${EXPLICIT.join(',')}` : 'readOnlyHint only',
  }),
);

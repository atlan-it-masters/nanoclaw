#!/usr/bin/env node
/**
 * Read-only MCP server (stdio) for the document libraries of ONE SharePoint
 * site, via app-only (client-credentials) Microsoft Graph auth.
 *
 * Why not @softeria/ms-365-mcp-server (already in the image for m365mail):
 * its SharePoint/drive tools can list and search, but it has no tool that
 * downloads file content, so the agent could find a policy but never read it.
 * This server is purpose-built and has no write tools at all — read-only is
 * also enforced at the Graph layer: the app registration should hold only
 * `Sites.Selected` with a `read` grant on the one site.
 *
 * Scope: every Graph call is resolved under SHAREPOINT_DOCS_SITE_URL's site
 * id; there is no way to address another site or drive through these tools.
 *
 * Requires: SHAREPOINT_DOCS_TENANT_ID, SHAREPOINT_DOCS_CLIENT_ID,
 * SHAREPOINT_DOCS_CLIENT_SECRET, SHAREPOINT_DOCS_SITE_URL
 * (e.g. https://contoso.sharepoint.com/sites/ISO27001).
 *
 * Zero npm deps on purpose: speaks newline-delimited JSON-RPC directly and
 * shells out to `unzip` (Office files) and `pdftotext` (PDF), both from apt.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 60000;
const MAX_LIST_ITEMS = 1500;
const SEARCH_PAGE_SIZE = 25;

const env = {
  tenantId: process.env.SHAREPOINT_DOCS_TENANT_ID,
  clientId: process.env.SHAREPOINT_DOCS_CLIENT_ID,
  clientSecret: process.env.SHAREPOINT_DOCS_CLIENT_SECRET,
  siteUrl: (process.env.SHAREPOINT_DOCS_SITE_URL || '').replace(/\/+$/, ''),
  // Microsoft Search requires a region for app-only calls; the tenant's error
  // message names the valid one ("Only valid regions are EMEA").
  searchRegion: process.env.SHAREPOINT_DOCS_SEARCH_REGION || 'EMEA',
};

// ---- Graph -------------------------------------------------------------------

let token = null; // { value, expiresAt }

function requireEnv() {
  if (!env.tenantId || !env.clientId || !env.clientSecret || !env.siteUrl) {
    throw new Error('sharepoint-docs-mcp: missing SHAREPOINT_DOCS_TENANT_ID / _CLIENT_ID / _CLIENT_SECRET / _SITE_URL');
  }
}

async function getToken() {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  requireEnv();
  const res = await fetch(`https://login.microsoftonline.com/${env.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.clientId,
      client_secret: env.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  });
  if (!res.ok) throw new Error(`token request failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return token.value;
}

async function graph(urlOrPath, { raw = false, body } = {}) {
  const url = urlOrPath.startsWith('https://') ? urlOrPath : GRAPH + urlOrPath;
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) throw new Error(`not found: ${urlOrPath}`);
    throw new Error(`Graph ${res.status} for ${urlOrPath}: ${body.slice(0, 500)}`);
  }
  return raw ? res : res.json();
}

async function graphAll(pathOrUrl, limit) {
  const out = [];
  let next = pathOrUrl;
  while (next && out.length < limit) {
    const page = await graph(next);
    out.push(...(page.value || []));
    next = page['@odata.nextLink'];
  }
  return out.slice(0, limit);
}

let siteCache = null; // { id, drives: [{ id, name, webUrl }] }

async function getSite() {
  if (siteCache) return siteCache;
  requireEnv();
  const u = new URL(env.siteUrl);
  const site = await graph(`/sites/${u.hostname}:${u.pathname}`);
  const drives = (await graphAll(`/sites/${site.id}/drives?$select=id,name,webUrl`, 100)).map((d) => ({
    id: d.id,
    name: d.name,
    webUrl: d.webUrl,
  }));
  siteCache = { id: site.id, drives };
  return siteCache;
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// Graph is inconsistent about URL encoding: drive webUrls come percent-encoded
// ("Gedeelde%20documenten") while search-hit webUrls have literal spaces.
const decodeUrl = (u) => {
  try {
    return decodeURI(u);
  } catch {
    return u; // a literal '%' in a file name
  }
};

// "<Library>/<folder>/<file>" → { drive, rel }. Library match is
// case-insensitive; a single-library site also accepts paths without it.
async function resolvePath(p) {
  const { drives } = await getSite();
  const parts = (p || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { drive: null, rel: '' };
  const drive = drives.find((d) => d.name.toLowerCase() === parts[0].toLowerCase());
  if (drive) return { drive, rel: parts.slice(1).join('/') };
  if (drives.length === 1) return { drive: drives[0], rel: parts.join('/') };
  throw new Error(`unknown library "${parts[0]}". Libraries on this site: ${drives.map((d) => d.name).join(', ')}`);
}

const itemUrl = (drive, rel) => (rel ? `/drives/${drive.id}/root:/${encodePath(rel)}:` : `/drives/${drive.id}/root`);

// parentReference.path looks like "/drives/<id>/root:/Folder/Sub"
function friendlyPath(drive, item) {
  const parent = item.parentReference?.path?.replace(/^\/drives\/[^/]+\/root:?/, '') || '';
  return [drive.name, ...parent.split('/').filter(Boolean).map(decodeURIComponent), item.name].join('/');
}

function describe(drive, item) {
  return {
    path: friendlyPath(drive, item),
    type: item.folder ? 'folder' : 'file',
    ...(item.folder ? { children: item.folder.childCount } : { size: item.size }),
    lastModified: item.lastModifiedDateTime,
    modifiedBy: item.lastModifiedBy?.user?.displayName,
    webUrl: item.webUrl,
  };
}

const SELECT = '$select=id,name,size,folder,file,parentReference,lastModifiedDateTime,lastModifiedBy,webUrl';

// ---- Tools ---------------------------------------------------------------------

async function listDocuments({ path: p = '', recursive = false }) {
  const { drives } = await getSite();
  const { drive, rel } = await resolvePath(p);
  if (!drive) return { libraries: drives.map((d) => d.name) };

  const results = [];
  const queue = [rel];
  while (queue.length && results.length < MAX_LIST_ITEMS) {
    const folder = queue.shift();
    const children = await graphAll(`${itemUrl(drive, folder)}/children?${SELECT}&$top=200`, MAX_LIST_ITEMS);
    for (const c of children) {
      results.push(c);
      if (recursive && c.folder) queue.push(folder ? `${folder}/${c.name}` : c.name);
    }
  }
  const truncated =
    results.length >= MAX_LIST_ITEMS
      ? { truncated: `capped at ${MAX_LIST_ITEMS} items — list a subfolder for the rest` }
      : {};
  // A recursive walk is hundreds of items: one compact line each, relative to
  // `root` ("sub/" for folders, "sub/file | yyyy-mm-dd" for files), keeps it
  // readable in context instead of a multi-hundred-KB JSON dump.
  if (recursive) {
    const root = [drive.name, rel].filter(Boolean).join('/');
    return {
      root,
      items: results.slice(0, MAX_LIST_ITEMS).map((c) => {
        const p = friendlyPath(drive, c).slice(root.length + 1);
        return c.folder ? `${p}/` : `${p} | ${(c.lastModifiedDateTime || '').slice(0, 10)}`;
      }),
      ...truncated,
    };
  }
  return { items: results.slice(0, MAX_LIST_ITEMS).map((c) => describe(drive, c)), ...truncated };
}

// The per-drive `/drives/{id}/root/search(q=...)` endpoint returns a 500
// generalException for app-only tokens on this tenant, so search goes through
// the Microsoft Search API, pinned to the site with a `path:` restriction.
// Hits from any drive that isn't one of this site's libraries are dropped.
async function searchDocuments({ query, offset = 0 }) {
  if (!query || !query.trim()) throw new Error('query is required');
  const { drives } = await getSite();
  const from = Math.max(0, Number(offset) || 0);
  const res = await graph('/search/query', {
    body: {
      requests: [
        {
          entityTypes: ['driveItem'],
          query: { queryString: `${query} path:"${env.siteUrl}"` },
          region: env.searchRegion,
          from,
          size: SEARCH_PAGE_SIZE,
        },
      ],
    },
  });
  const container = res.value?.[0]?.hitsContainers?.[0] || {};
  const results = [];
  for (const hit of container.hits || []) {
    const r = hit.resource || {};
    const drive = drives.find((d) => d.id === r.parentReference?.driveId);
    const base = decodeUrl(drive?.webUrl || '') + '/';
    const url = decodeUrl(r.webUrl || '');
    if (!drive || !url.startsWith(base)) continue;
    results.push({
      path: `${drive.name}/${url.slice(base.length)}`,
      type: r.folder ? 'folder' : 'file',
      lastModified: r.lastModifiedDateTime,
      snippet: decodeXml((hit.summary || '').replace(/<[^>]+>/g, '')).trim(),
      webUrl: encodeURI(url),
    });
  }
  const next = from + (container.hits?.length || 0);
  return {
    query,
    total: container.total,
    results,
    ...(container.moreResultsAvailable ? { nextOffset: next } : {}),
  };
}

function unzipList(file) {
  const r = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
}

function unzipRead(file, entry) {
  const r = spawnSync('unzip', ['-p', file, entry], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const tidy = (s) =>
  s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const byNumber = (a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0);

function wordXmlToText(xml) {
  return decodeXml(
    xml
      .replace(/<w:(instrText|delText)\b[^>]*>[\s\S]*?<\/w:\1>/g, '')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
      // paragraphs inside a table cell join with spaces so a row stays one line
      .replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) => cell.replace(/<\/w:p>/g, ' '))
      .replace(/<\/w:tc>/g, ' | ')
      .replace(/<\/w:(p|tr)>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\s*\|\s*\n/g, '\n');
}

function docxToText(file) {
  const entries = unzipList(file);
  const parts = ['word/document.xml', ...entries.filter((e) => /^word\/(footnotes|endnotes)\.xml$/.test(e))];
  return tidy(parts.map((e) => wordXmlToText(unzipRead(file, e))).join('\n\n'));
}

function pptxToText(file) {
  const slides = unzipList(file)
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e))
    .sort(byNumber);
  return tidy(
    slides
      .map((e, i) => {
        const text = decodeXml(
          unzipRead(file, e)
            .replace(/<\/a:p>/g, '\n')
            .replace(/<a:br\/>/g, '\n')
            .replace(/<[^>]+>/g, ''),
        );
        return `## Slide ${i + 1}\n${text}`;
      })
      .join('\n\n'),
  );
}

// Excel stores dates as day serials (46175 = 2026-06-02); whether a number is
// a date lives only in its cell style's number format. Built-in date formats
// are ids 14-22 and 45-47; custom ones are detected by their d/m/y tokens.
function xlsxDateStyles(stylesXml) {
  const custom = new Map(
    [...stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [
      Number(m[1]),
      decodeXml(m[2]),
    ]),
  );
  const isDateFmt = (id) => {
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47)) return true;
    const code = custom.get(id);
    if (!code) return false;
    const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
    return /[dy]/i.test(bare) || (/m/i.test(bare) && !/[hs]/i.test(bare)); // bare m without h/s = month
  };
  const xfs = stylesXml.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0] || '';
  const flags = [...xfs.matchAll(/<xf\b([^>]*)/g)].map((m) => isDateFmt(Number(m[1].match(/numFmtId="(\d+)"/)?.[1])));
  return (i) => flags[i] === true;
}

function excelSerialToDate(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
  const iso = d.toISOString();
  return n % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

function xlsxToText(file) {
  const entries = unzipList(file);
  const shared = [...unzipRead(file, 'xl/sharedStrings.xml').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map(
    (m) => decodeXml((m[1] || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<[^>]+>/g, '')),
  );
  const isDateStyle = xlsxDateStyles(unzipRead(file, 'xl/styles.xml'));
  const names = [...unzipRead(file, 'xl/workbook.xml').matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) =>
    decodeXml(m[1]),
  );
  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e)).sort(byNumber);
  return tidy(
    sheets
      .map((e, i) => {
        const rows = [...unzipRead(file, e).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) =>
          [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
            .map(([, attrs, body = '']) => {
              const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
              if (/\bt="s"/.test(attrs)) return shared[Number(v)] ?? '';
              if (/\bt="inlineStr"/.test(attrs)) return decodeXml(body.replace(/<[^>]+>/g, ''));
              if (v === undefined) return '';
              const style = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? 0);
              if (isDateStyle(style) && /^\d+(\.\d+)?$/.test(v)) return excelSerialToDate(Number(v));
              return decodeXml(v);
            })
            .join(' | '),
        );
        return `## Sheet: ${names[i] || `sheet${i + 1}`}\n${rows.filter((r) => r.replace(/[ |]/g, '')).join('\n')}`;
      })
      .join('\n\n'),
  );
}

function pdfToText(file) {
  const r = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw new Error('pdftotext is not installed in this image');
  if (r.status !== 0) throw new Error(`pdftotext failed: ${r.stderr}`);
  // -layout keeps table columns apart but pads wide tables with long space
  // runs (a landscape SoA doubles in size); three spaces still reads as a
  // column break.
  return tidy(r.stdout.replace(/^ +/gm, '').replace(/ {3,}/g, '   '));
}

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.ini']);

function extract(file, ext) {
  if (['.docx', '.docm', '.dotx'].includes(ext)) return docxToText(file);
  if (['.pptx', '.pptm'].includes(ext)) return pptxToText(file);
  if (['.xlsx', '.xlsm'].includes(ext)) return xlsxToText(file);
  if (ext === '.pdf') return pdfToText(file);
  if (TEXT_EXT.has(ext)) return fs.readFileSync(file, 'utf8');
  if (['.html', '.htm', '.aspx'].includes(ext)) {
    return tidy(
      decodeXml(
        fs
          .readFileSync(file, 'utf8')
          .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
          .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
          .replace(/<[^>]+>/g, ''),
      ),
    );
  }
  return null;
}

async function readDocument({ path: p, offset = 0, max_chars = DEFAULT_MAX_CHARS }) {
  if (!p) throw new Error('path is required');
  const { drive, rel } = await resolvePath(p);
  if (!drive || !rel) throw new Error('path must point to a file, e.g. "<Library>/<folder>/<file>"');
  const base = itemUrl(drive, rel);
  const item = await graph(`${base}?${SELECT}`);
  if (item.folder) throw new Error(`"${p}" is a folder — use list_documents`);
  const meta = describe(drive, item);
  const ext = path.extname(item.name).toLowerCase();
  if (item.size > MAX_DOWNLOAD_BYTES) {
    return { ...meta, error: `file is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB; open it via webUrl` };
  }
  if (['.doc', '.xls', '.ppt'].includes(ext)) {
    return { ...meta, error: `legacy binary Office format (${ext}) is not supported; open it via webUrl` };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spdocs-'));
  try {
    const res = await graph(`${base}/content`, { raw: true });
    const file = path.join(tmp, `doc${ext}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const text = extract(file, ext);
    if (text === null) return { ...meta, error: `no text extractor for ${ext || 'files without an extension'}` };
    const start = Math.max(0, Number(offset) || 0);
    const chunk = text.slice(start, start + Math.max(1000, Number(max_chars) || DEFAULT_MAX_CHARS));
    const end = start + chunk.length;
    return {
      ...meta,
      totalChars: text.length,
      offset: start,
      ...(end < text.length ? { nextOffset: end, note: 'truncated — call again with offset=nextOffset' } : {}),
      content: chunk,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: 'list_documents',
    description:
      'List folders and files in the SharePoint site. With no path, returns the document libraries. ' +
      'Paths are "<Library>/<folder>/...". recursive=true walks all subfolders and returns one compact line per ' +
      `item relative to "root" ("sub/" for folders, "sub/file | last-modified" for files), capped at ${MAX_LIST_ITEMS} items. ` +
      'Prefer search_documents, or a recursive listing of a specific subfolder, over listing a whole library.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder path, e.g. "Documents/Policies". Empty = list libraries.' },
        recursive: { type: 'boolean', description: 'Include all subfolders.' },
      },
    },
    annotations: READ_ONLY,
    run: listDocuments,
  },
  {
    name: 'search_documents',
    description:
      'Full-text search (file names and contents) across the SharePoint site, ranked by relevance, with a ' +
      `snippet per hit. Returns ${SEARCH_PAGE_SIZE} results per call; pass offset=nextOffset for more. ` +
      'Supports KQL, e.g. filetype:docx, "exact phrase", AND/OR.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (KQL).' },
        offset: { type: 'number', description: 'Result offset for paging (default 0).' },
      },
      required: ['query'],
    },
    annotations: READ_ONLY,
    run: searchDocuments,
  },
  {
    name: 'read_document',
    description:
      'Download a file from the SharePoint site and return its text (docx, xlsx, pptx, pdf, txt/md/csv, html). ' +
      'Long documents are paged: pass offset=nextOffset to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path as returned by list/search, e.g. "Documents/ISMS/Policy.docx".',
        },
        offset: { type: 'number', description: 'Character offset to start from (default 0).' },
        max_chars: { type: 'number', description: `Max characters to return (default ${DEFAULT_MAX_CHARS}).` },
      },
      required: ['path'],
    },
    annotations: READ_ONLY,
    run: readDocument,
  },
];

// ---- JSON-RPC over stdio ---------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    switch (method) {
      case 'initialize':
        return send({
          id,
          result: {
            protocolVersion: params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'sharepoint-docs-mcp', version: '1.0.0' },
          },
        });
      case 'ping':
        return send({ id, result: {} });
      case 'tools/list':
        return send({ id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return send({ id, error: { code: -32602, message: `unknown tool: ${params?.name}` } });
        try {
          const out = await tool.run(params.arguments || {});
          return send({ id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } });
        } catch (err) {
          return send({ id, result: { isError: true, content: [{ type: 'text', text: String(err.message || err) }] } });
        }
      }
      default:
        return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (err) {
    send({ id, error: { code: -32603, message: String(err.message || err) } });
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'parse error' } });
    }
    handle(msg);
  });
}

module.exports = { docxToText, pptxToText, xlsxToText, pdfToText, extract };

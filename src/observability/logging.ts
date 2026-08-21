import { pool } from './db.js';
import { log } from '../log.js';

export interface ToolCallRecord {
  name: string;
  input?: unknown;
}

export interface InteractionLog {
  userId: string;
  userName?: string;
  conversationId?: string;
  channel?: string; // e.g. "teams"

  question: string;
  answer?: string;
  toolsCalled?: ToolCallRecord[];
  toolResults?: unknown;

  model?: string;
  inputTokens?: number;
  outputTokens?: number;

  latencyMs?: number;
  metadata?: Record<string, unknown>;
}

const MAX_FIELD_CHARS = 20_000; // guard against runaway tool results blowing up row size

/**
 * Truncate large text/JSON blobs before they hit the DB.
 *
 * Arrays are truncated by dropping trailing ELEMENTS, not by collapsing the
 * whole thing to a string-wrapped object — a consumer that expects
 * `tools_called` to always be a JSON array (e.g. Grafana's
 * `jsonb_array_elements(tools_called)` in the Tool Usage Frequency panel)
 * gets a hard SQL error ("cannot extract elements from an object") the
 * moment ANY row's array is large enough to hit the old string-truncation
 * path — found live in production (row with a long ToolSearch/mcp tool-call
 * chain), and it silently killed the whole panel's query, not just that row.
 */
export function truncate(value: unknown, max = MAX_FIELD_CHARS): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') {
    if (value.length <= max) return value;
    return value.slice(0, max) + `...[truncated, ${value.length} chars total]`;
  }
  const str = JSON.stringify(value);
  if (str.length <= max) return value;
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    let size = 2; // "[]"
    for (const item of value) {
      const itemSize = JSON.stringify(item).length + 1; // +1 for the separating comma
      if (size + itemSize > max) break;
      kept.push(item);
      size += itemSize;
    }
    if (kept.length < value.length) {
      kept.push({ truncated: true, droppedCount: value.length - kept.length });
    }
    return kept;
  }
  return { truncated: str.slice(0, max) + `...[truncated, ${str.length} chars total]` };
}

/**
 * Fire-and-forget logging of a single bot turn.
 * Never throws into the caller - logging failures are reported but must not
 * break the actual bot response to the user. No-op when DATABASE_URL isn't
 * configured (pool is null) — observability is opt-in per install.
 */
export async function logInteraction(entry: InteractionLog): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO bot_interactions
        (user_id, user_name, conversation_id, channel,
         question, answer, tools_called, tool_results,
         model, input_tokens, output_tokens, latency_ms, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        entry.userId,
        entry.userName ?? null,
        entry.conversationId ?? null,
        entry.channel ?? 'teams',
        entry.question,
        entry.answer ?? null,
        entry.toolsCalled ? JSON.stringify(truncate(entry.toolsCalled)) : null,
        entry.toolResults ? JSON.stringify(truncate(entry.toolResults)) : null,
        entry.model ?? null,
        entry.inputTokens ?? null,
        entry.outputTokens ?? null,
        entry.latencyMs ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    );
  } catch (err) {
    log.error('Failed to log bot interaction', { err });
  }
}

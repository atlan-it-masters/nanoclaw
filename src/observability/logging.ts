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

/** Truncate large text/JSON blobs before they hit the DB. */
export function truncate(value: unknown, max = MAX_FIELD_CHARS): unknown {
  if (value === undefined || value === null) return value;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= max) return value;
  const clipped = str.slice(0, max) + `...[truncated, ${str.length} chars total]`;
  return typeof value === 'string' ? clipped : { truncated: clipped };
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

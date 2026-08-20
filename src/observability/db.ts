import { Pool } from 'pg';
import { log } from '../log.js';
import { DATABASE_URL } from '../config.js';

// Single shared pool for bot-interaction logging. DATABASE_URL is optional —
// when unset, logInteraction() (logging.ts) is a no-op rather than throwing,
// so an install that hasn't set up Postgres/Grafana observability is
// unaffected. Read via config.ts (not raw process.env): the host process
// never loads .env into process.env itself (no dotenv, no systemd
// EnvironmentFile=) — every credential in this codebase goes through
// config.ts's readEnvFile(), and this is no exception.
export const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    })
  : null;

pool?.on('error', (err) => {
  // A logging failure must never crash the bot - just report it.
  log.error('Postgres pool error', { err });
});

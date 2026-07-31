// Schema and pool.
//
// Two things here are load-bearing rather than incidental.
//
// social_post_entries has a unique constraint on (campaign_id, platform).
// That is the last line of defence against a double post: even if the worker
// were somehow to run the same job twice, the second insert fails at the
// database rather than reaching the platform.
//
// jobs.run_after is what makes scheduling durable. A post for 9am is a row
// with run_after set to 9am, not a timer in a process that dies overnight.

const { Pool } = require("pg");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  topics       TEXT[] NOT NULL DEFAULT '{}',
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS social_post_entries (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  caption      TEXT NOT NULL,
  image_width  INTEGER NOT NULL,
  image_height INTEGER NOT NULL,
  image_path   TEXT,
  platform_post_id TEXT,
  permalink    TEXT,
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, platform)
);

CREATE TABLE IF NOT EXISTS jobs (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  campaign_id     TEXT NOT NULL,
  platform        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  attempts        INTEGER NOT NULL DEFAULT 0,
  run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at       TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_claimable ON jobs (status, run_after);

CREATE TABLE IF NOT EXISTS platform_tokens (
  platform    TEXT PRIMARY KEY,
  ciphertext  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           BIGSERIAL PRIMARY KEY,
  signature    TEXT NOT NULL UNIQUE,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

function createPool() {
  return new Pool({ connectionString: process.env.DATABASE_URL });
}

async function migrate(pool) {
  await pool.query(SCHEMA);
}

/** Tokens live in Postgres as ciphertext. The pool never sees a plaintext token. */
function tokenStore(pool) {
  return {
    async get(platform) {
      const { rows } = await pool.query(
        "SELECT ciphertext, expires_at FROM platform_tokens WHERE platform = $1",
        [platform]
      );
      if (!rows.length) return null;
      return { ciphertext: rows[0].ciphertext, expiresAt: new Date(rows[0].expires_at).getTime() };
    },
    async put(platform, { ciphertext, expiresAt }) {
      await pool.query(
        `INSERT INTO platform_tokens (platform, ciphertext, expires_at, updated_at)
         VALUES ($1, $2, to_timestamp($3 / 1000.0), now())
         ON CONFLICT (platform) DO UPDATE
           SET ciphertext = excluded.ciphertext,
               expires_at = excluded.expires_at,
               updated_at = now()`,
        [platform, ciphertext, expiresAt]
      );
    },
  };
}

module.exports = { createPool, migrate, tokenStore, SCHEMA };

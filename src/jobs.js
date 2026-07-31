// The durable queue.
//
// "Post at 9am" is a row with run_after set to 9am. A timer in a process would
// be gone the moment the process is, and the brief asks for a crash mid-batch
// that resumes without double posting, which a timer cannot give you.
//
// claim() takes one job with FOR UPDATE SKIP LOCKED, so several workers can run
// and none of them wait on a row another one already has. Killing a worker
// mid-job leaves the row in "running"; reclaimStale puts it back after the
// lease expires, and the platform's idempotency key is what makes that
// second attempt safe.

const MAX_ATTEMPTS = Number(process.env.JOB_MAX_ATTEMPTS || 4);
const LEASE_SECONDS = Number(process.env.JOB_LEASE_SECONDS || 60);

async function enqueue(pool, { campaignId, platform, runAfter }) {
  const key = `${campaignId}:${platform}`;
  const { rows } = await pool.query(
    `INSERT INTO jobs (idempotency_key, campaign_id, platform, run_after)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [key, campaignId, platform, runAfter || null]
  );

  if (rows.length) return { id: rows[0].id, key, duplicate: false };

  const existing = await pool.query("SELECT id FROM jobs WHERE idempotency_key = $1", [key]);
  return { id: existing.rows[0].id, key, duplicate: true };
}

/** One claimable job, or null. Skips rows another worker is holding. */
async function claim(pool) {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued' AND run_after <= now()
       ORDER BY run_after, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`
  );
  return rows[0] || null;
}

async function succeed(pool, jobId) {
  await pool.query(
    "UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = now() WHERE id = $1",
    [jobId]
  );
}

/**
 * Back off and try again, unless the error was permanent or the attempts are
 * spent. A permanent error is a 422 on the caption: retrying it three more
 * times annoys the platform and changes nothing.
 */
async function fail(pool, job, error, { permanent = false } = {}) {
  const spent = permanent || job.attempts >= MAX_ATTEMPTS;
  if (spent) {
    await pool.query(
      "UPDATE jobs SET status = 'failed', locked_at = NULL, last_error = $2, updated_at = now() WHERE id = $1",
      [job.id, String(error).slice(0, 500)]
    );
    return { retrying: false, reason: permanent ? "permanent" : "attempts exhausted" };
  }

  const delaySeconds = 2 ** job.attempts;
  await pool.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = $2,
                     run_after = now() + ($3 || ' seconds')::interval, updated_at = now()
     WHERE id = $1`,
    [job.id, String(error).slice(0, 500), delaySeconds]
  );
  return { retrying: true, delaySeconds };
}

/**
 * Jobs whose worker died holding them. The lease is what distinguishes a slow
 * job from a dead one, so this cannot be a plain "anything running for a
 * while" sweep without a lease to point at.
 */
async function reclaimStale(pool) {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = now()
     WHERE status = 'running' AND locked_at < now() - ($1 || ' seconds')::interval
     RETURNING id, idempotency_key, attempts`,
    [LEASE_SECONDS]
  );
  return rows;
}

async function stats(pool) {
  const { rows } = await pool.query("SELECT status, COUNT(*)::int AS n FROM jobs GROUP BY status");
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

module.exports = { enqueue, claim, succeed, fail, reclaimStale, stats, MAX_ATTEMPTS, LEASE_SECONDS };

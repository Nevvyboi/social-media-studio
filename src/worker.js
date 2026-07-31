// The worker. Claims a job, publishes it, and stops.
//
// It marks an entry "accepted", never "published". The platform took the post;
// whether it went out is something only the platform knows, and it says so in
// the delivery webhook. Marking it published here would be recording an
// intention as a fact, which is exactly the bug the signed callback exists to
// prevent.

const fs = require("fs/promises");

const { buildPublishers } = require("./publisher/registry");
const { claim, fail, reclaimStale, succeed } = require("./jobs");
const { config } = require("./config");
const { createPool, tokenStore } = require("./db");

function log(message) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function runOne(pool, publishers) {
  const job = await claim(pool);
  if (!job) return false;

  const { rows } = await pool.query(
    "SELECT * FROM social_post_entries WHERE campaign_id = $1 AND platform = $2",
    [job.campaign_id, job.platform]
  );
  const entry = rows[0];
  if (!entry) {
    await fail(pool, job, "no social_post_entry for this job", { permanent: true });
    return true;
  }

  try {
    const image = {
      buffer: await fs.readFile(entry.image_path),
      width: entry.image_width,
      height: entry.image_height,
    };

    const result = await publishers.for(job.platform).publish({
      externalId: job.campaign_id,
      caption: entry.caption,
      image,
      idempotencyKey: job.idempotency_key,
    });

    await pool.query(
      `UPDATE social_post_entries
         SET status = CASE WHEN status = 'published' THEN status ELSE 'accepted' END,
             platform_post_id = $2, last_error = NULL, updated_at = now()
       WHERE campaign_id = $1 AND platform = $3`,
      [job.campaign_id, result.postId, job.platform]
    );
    await succeed(pool, job.id);

    log(
      `${job.idempotency_key} accepted as ${result.postId}` +
        (result.duplicate ? " (platform recognised the idempotency key, no second post)" : "") +
        ` on attempt ${job.attempts}`
    );
  } catch (error) {
    const outcome = await fail(pool, job, error.message, { permanent: Boolean(error.permanent) });
    await pool.query(
      "UPDATE social_post_entries SET last_error = $2, status = CASE WHEN $3 THEN 'failed' ELSE status END, updated_at = now() WHERE campaign_id = $1 AND platform = $4",
      [job.campaign_id, error.message.slice(0, 500), !outcome.retrying, job.platform]
    );

    if (outcome.retrying) {
      log(`${job.idempotency_key} attempt ${job.attempts} failed (${error.message}), retrying in ${outcome.delaySeconds}s`);
    } else {
      log(`ALERT ${job.idempotency_key} failed after ${job.attempts} attempts: ${error.message} [${outcome.reason}]`);
    }
  }

  return true;
}

/**
 * The API creates the schema, and compose starts both at once, so on a cold
 * volume the worker can reach the first query before the tables exist. Waiting
 * is right and crashing is not: a worker that dies on a startup race turns a
 * two second wait into a restart loop, and the same applies to a database that
 * bounces while the worker is running.
 */
async function waitForSchema(pool, attempts = 30) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query("SELECT 1 FROM jobs LIMIT 1");
      return;
    } catch (error) {
      log(`schema not ready yet (${error.message.split("\n")[0]}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("gave up waiting for the schema");
}

async function main() {
  const pool = createPool();
  const publishers = buildPublishers({
    baseUrl: config.platformBaseUrl,
    credentials: config.credentials,
    tokenStore: tokenStore(pool),
    encryptionKey: config.encryptionKey,
    log,
  });

  await waitForSchema(pool);
  log(`worker up, publishing to ${config.platformBaseUrl} for ${publishers.keys().join(" and ")}`);

  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (running) {
    try {
      const reclaimed = await reclaimStale(pool);
      reclaimed.forEach((job) =>
        log(`reclaimed ${job.idempotency_key} from a worker that died holding it, attempt ${job.attempts}`)
      );

      const worked = await runOne(pool, publishers);
      if (!worked) await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    } catch (error) {
      log(`loop error, backing off a second: ${error.message.split("\n")[0]}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  await pool.end();
  log("worker stopped");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runOne };

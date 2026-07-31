// Turning one blog post into a campaign: the artefacts, the rows, the jobs.
//
// Everything expensive happens here, before anything is queued. Rendering the
// variants and composing the captions when the campaign is created rather than
// when the job runs means a caption that cannot satisfy a platform fails at
// the API call, in front of whoever made it, instead of at 9am inside a worker
// with nobody watching.

const fs = require("fs/promises");
const path = require("path");

const { captionsFor } = require("./captions/compose");
const { enqueue } = require("./jobs");
const { platform, platformKeys } = require("./platforms");
const { variantsFor } = require("./images");

async function createCampaign(pool, post, options = {}) {
  const targets = options.platforms || platformKeys();
  targets.forEach(platform);

  const source = await fs.readFile(options.sourceImage);
  const images = await variantsFor(source, targets, {
    focus: options.focus,
    brand: options.brand,
  });
  const captions = await captionsFor(post, targets, { write: options.write });

  await pool.query(
    `INSERT INTO campaigns (id, title, url, topics, body) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET title = excluded.title, url = excluded.url,
                                    topics = excluded.topics, body = excluded.body`,
    [post.id, post.title, post.url, post.topics || [], post.body]
  );

  const mediaDir = path.join(options.mediaDir, post.id);
  await fs.mkdir(mediaDir, { recursive: true });

  const entries = [];
  const warnings = [];

  for (const key of targets) {
    const image = images[key];
    const file = path.join(mediaDir, `${key}.png`);
    await fs.writeFile(file, image.buffer);
    warnings.push(...image.warnings.map((w) => `${key}: ${w}`));

    await pool.query(
      `INSERT INTO social_post_entries
         (campaign_id, platform, status, caption, image_width, image_height, image_path, scheduled_at)
       VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7)
       ON CONFLICT (campaign_id, platform) DO UPDATE
         SET caption = excluded.caption, image_path = excluded.image_path,
             scheduled_at = excluded.scheduled_at, updated_at = now()`,
      [post.id, key, captions[key].caption, image.width, image.height, file, options.scheduledAt || null]
    );

    const job = await enqueue(pool, {
      campaignId: post.id,
      platform: key,
      runAfter: options.scheduledAt || null,
    });

    entries.push({
      platform: key,
      caption: captions[key].caption,
      captionLength: captions[key].caption.length,
      fragments: captions[key].fragments,
      image: { width: image.width, height: image.height, path: file },
      job,
    });
  }

  return { campaignId: post.id, scheduledAt: options.scheduledAt || null, entries, warnings };
}

async function readCampaign(pool, campaignId) {
  const { rows: campaigns } = await pool.query("SELECT * FROM campaigns WHERE id = $1", [campaignId]);
  if (!campaigns.length) return null;

  const { rows: entries } = await pool.query(
    "SELECT * FROM social_post_entries WHERE campaign_id = $1 ORDER BY platform",
    [campaignId]
  );
  const { rows: jobs } = await pool.query(
    "SELECT platform, status, attempts, run_after, last_error FROM jobs WHERE campaign_id = $1 ORDER BY platform",
    [campaignId]
  );

  return { campaign: campaigns[0], entries, jobs };
}

async function listCampaigns(pool) {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.url, c.created_at,
            COUNT(e.*)::int AS posts,
            COUNT(*) FILTER (WHERE e.status = 'published')::int AS published,
            COUNT(*) FILTER (WHERE e.status = 'failed')::int AS failed
     FROM campaigns c LEFT JOIN social_post_entries e ON e.campaign_id = c.id
     GROUP BY c.id ORDER BY c.created_at DESC`
  );
  return rows;
}

module.exports = { createCampaign, readCampaign, listCampaigns };

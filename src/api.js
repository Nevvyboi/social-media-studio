const express = require("express");

const { config } = require("./config");
const { createCampaign, listCampaigns, readCampaign } = require("./campaigns");
const { platformKeys } = require("./platforms");
const { recordDelivery, verify, WebhookRejected } = require("./webhooks");
const { stats } = require("./jobs");
const { renderCampaigns } = require("./view");

function buildApp(pool) {
  const app = express();

  // The webhook route needs the bytes that arrived, not a re-serialised object,
  // so it is mounted before the JSON parser with a raw body parser of its own.
  app.post("/webhooks/platform", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    let signature;
    try {
      signature = verify(req.body, req.headers, config.webhookSecret);
    } catch (error) {
      if (error instanceof WebhookRejected) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }

    const fresh = await recordDelivery(pool, signature);
    if (!fresh) return res.status(200).json({ ok: true, replay: true });

    const event = JSON.parse(req.body.toString("utf8"));
    const status = event.status === "published" ? "published" : "failed";

    const { rowCount } = await pool.query(
      `UPDATE social_post_entries
         SET status = $1, permalink = $2, published_at = CASE WHEN $1 = 'published' THEN now() END,
             updated_at = now()
       WHERE campaign_id = $3 AND platform = $4`,
      [status, event.permalink || null, event.external_id, event.platform]
    );

    res.json({ ok: true, updated: rowCount, status });
  });

  app.use(express.json({ limit: "4mb" }));

  app.get("/health", async (_req, res) => {
    res.json({ ok: true, platforms: platformKeys(), jobs: await stats(pool) });
  });

  app.get("/", async (_req, res) => {
    res.type("html").send(renderCampaigns(await listCampaigns(pool)));
  });

  app.get("/campaigns", async (_req, res) => res.json({ campaigns: await listCampaigns(pool) }));

  app.post("/campaigns", async (req, res, next) => {
    const problems = validate(req.body);
    if (problems.length) return res.status(422).json({ error: "invalid campaign", problems });

    try {
      const result = await createCampaign(pool, req.body.post, {
        platforms: req.body.platforms,
        scheduledAt: req.body.scheduled_at || null,
        focus: req.body.focus,
        brand: req.body.brand ?? config.brand,
        sourceImage: config.sourceImage,
        mediaDir: config.mediaDir,
      });
      res.status(202).location(`/campaigns/${result.campaignId}`).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/campaigns/:id", async (req, res) => {
    const found = await readCampaign(pool, req.params.id);
    if (!found) return res.status(404).json({ error: "no such campaign" });
    res.json(found);
  });

  app.get("/campaigns/:id/media/:platform", async (req, res) => {
    const { rows } = await pool.query(
      "SELECT image_path FROM social_post_entries WHERE campaign_id = $1 AND platform = $2",
      [req.params.id, req.params.platform]
    );
    if (!rows.length || !rows[0].image_path) return res.status(404).json({ error: "no image" });
    res.sendFile(rows[0].image_path);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: error.message });
  });

  return app;
}

function validate(body) {
  const problems = [];
  const post = body?.post;

  if (!post || typeof post !== "object") {
    problems.push("post is required");
    return problems;
  }
  for (const field of ["id", "title", "url", "body"]) {
    if (!post[field] || typeof post[field] !== "string") problems.push(`post.${field} must be a string`);
  }
  if (post.url && !/^https?:\/\//.test(post.url)) problems.push("post.url must be http or https");
  if (post.topics && !Array.isArray(post.topics)) problems.push("post.topics must be an array");

  if (body.platforms) {
    if (!Array.isArray(body.platforms)) {
      problems.push("platforms must be an array");
    } else {
      const known = platformKeys();
      body.platforms
        .filter((p) => !known.includes(p))
        .forEach((p) => problems.push(`unknown platform ${p}, expected one of ${known.join(", ")}`));
    }
  }

  if (body.scheduled_at && Number.isNaN(Date.parse(body.scheduled_at))) {
    problems.push("scheduled_at must be an ISO timestamp");
  }
  if (body.focus && (typeof body.focus.x !== "number" || typeof body.focus.y !== "number")) {
    problems.push("focus must be {x, y} as numbers between 0 and 1");
  }

  return problems;
}

module.exports = { buildApp, validate };

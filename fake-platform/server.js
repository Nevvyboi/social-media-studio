// A stand-in for Instagram and X.
//
// The brief points at a provided starter, starters/challenge-5-social/, which
// is not in my Resources list, so this is written to the behaviours the brief
// names: OAuth, idempotency keys, rate limits with Retry-After, and a signed
// delivery webhook. It is deliberately strict. A sandbox that accepts anything
// teaches you nothing, so this one rejects wrong image dimensions, over-long
// captions, missing idempotency keys and expired tokens, and it refuses to
// publish twice for the same key.
//
// Nothing here ever talks to a real social platform, which is the point.

const crypto = require("crypto");
const express = require("express");

const { PLATFORMS } = require("./specs");

const PORT = Number(process.env.FAKE_PLATFORM_PORT || 4010);
const CLIENT_ID = process.env.FAKE_CLIENT_ID || "studio-local";
const CLIENT_SECRET = process.env.FAKE_CLIENT_SECRET || "studio-local-secret";
const WEBHOOK_SECRET = process.env.PLATFORM_WEBHOOK_SECRET || "webhook-secret";
const WEBHOOK_URL = process.env.STUDIO_WEBHOOK_URL || "http://localhost:4000/webhooks/platform";
const TOKEN_TTL_SECONDS = Number(process.env.FAKE_TOKEN_TTL || 3600);
const DELIVERY_DELAY_MS = Number(process.env.FAKE_DELIVERY_DELAY_MS || 400);

const tokens = new Map();
const posts = new Map();
const byIdempotencyKey = new Map();
const requestLog = new Map();

// Set with POST /_control/chaos. Lets a demo produce a 429 or a 500 on demand
// without waiting for the rate limiter or breaking anything permanently.
let chaos = { failNext: 0, status: 429 };

// Set with POST /_control/latency. A slow platform is what makes a worker
// crash land in the middle of a publish rather than between two of them,
// which is the case the crash-resume demo needs.
let latencyMs = 0;

const app = express();
app.use(express.json({ limit: "12mb" }));

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ error, ...extra });
}

function knownPlatform(req, res, next) {
  const spec = PLATFORMS[req.params.platform];
  if (!spec) return fail(res, 404, `unknown platform ${req.params.platform}`);
  req.spec = spec;
  next();
}

function authenticate(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return fail(res, 401, "missing bearer token");

  const record = tokens.get(token);
  if (!record) return fail(res, 401, "unknown token");
  if (record.expiresAt < Date.now()) {
    tokens.delete(token);
    return fail(res, 401, "token expired");
  }
  req.token = record;
  next();
}

function rateLimit(req, res, next) {
  if (chaos.failNext > 0) {
    chaos.failNext -= 1;
    const retryAfter = 2;
    if (chaos.status === 429) res.set("Retry-After", String(retryAfter));
    return fail(res, chaos.status, `injected ${chaos.status}`, { retry_after: retryAfter });
  }

  const { posts: allowed, perSeconds } = req.spec.rateLimit;
  const windowMs = perSeconds * 1000;
  const now = Date.now();
  const key = req.params.platform;

  const recent = (requestLog.get(key) || []).filter((at) => now - at < windowMs);
  if (recent.length >= allowed) {
    const retryAfter = Math.ceil((windowMs - (now - recent[0])) / 1000);
    res.set("Retry-After", String(Math.max(retryAfter, 1)));
    requestLog.set(key, recent);
    return fail(res, 429, "rate limit exceeded", {
      limit: allowed,
      per_seconds: perSeconds,
      retry_after: retryAfter,
    });
  }

  recent.push(now);
  requestLog.set(key, recent);
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true, platforms: Object.keys(PLATFORMS) }));

app.get("/:platform/spec", knownPlatform, (req, res) => res.json(req.spec));

app.post("/oauth/token", (req, res) => {
  const { client_id: id, client_secret: secret } = req.body || {};
  if (id !== CLIENT_ID || secret !== CLIENT_SECRET) {
    return fail(res, 401, "invalid client credentials");
  }

  const token = crypto.randomBytes(24).toString("hex");
  tokens.set(token, { clientId: id, expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000 });
  res.json({ access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL_SECONDS });
});

app.post("/:platform/media", knownPlatform, authenticate, rateLimit, (req, res) => {
  const { image_base64: image, width, height } = req.body || {};
  if (!image) return fail(res, 400, "image_base64 is required");

  const expected = req.spec.image;
  if (width !== expected.width || height !== expected.height) {
    return fail(res, 422, "image dimensions rejected", {
      expected: `${expected.width}x${expected.height}`,
      received: `${width}x${height}`,
    });
  }

  const mediaId = `media_${crypto.randomBytes(6).toString("hex")}`;
  res.status(201).json({ media_id: mediaId, width, height });
});

app.post("/:platform/posts", knownPlatform, authenticate, rateLimit, (req, res) => {
  const key = req.get("idempotency-key");
  if (!key) return fail(res, 400, "Idempotency-Key header is required");

  const scoped = `${req.params.platform}:${key}`;
  const seen = byIdempotencyKey.get(scoped);
  if (seen) {
    return res.status(200).json({ post_id: seen, duplicate: true, status: "accepted" });
  }

  // The two platforms do not have the same shape, on purpose. Instagram wants
  // media uploaded first and referenced by id, the way the real Graph API
  // wants a container. X takes the image inline on the post. If both accepted
  // the same request there would be nothing for an adapter layer to absorb.
  const { media_id: mediaId, caption, external_id: externalId } = req.body || {};
  const { image_base64: inlineImage, width, height } = req.body || {};

  if (req.params.platform === "x") {
    if (!inlineImage) return fail(res, 400, "image_base64 is required inline on this platform");
    const expected = req.spec.image;
    if (width !== expected.width || height !== expected.height) {
      return fail(res, 422, "image dimensions rejected", {
        expected: `${expected.width}x${expected.height}`,
        received: `${width}x${height}`,
      });
    }
  } else if (!mediaId) {
    return fail(res, 400, "media_id is required, upload to /media first");
  }

  const limits = req.spec.caption;
  if (typeof caption !== "string" || caption.length === 0) {
    return fail(res, 422, "caption is required");
  }
  if (caption.length > limits.maxLength) {
    return fail(res, 422, "caption too long", {
      max_length: limits.maxLength,
      received: caption.length,
    });
  }
  const hashtags = (caption.match(/#[\w]+/g) || []).length;
  if (hashtags > limits.maxHashtags) {
    return fail(res, 422, "too many hashtags", { max: limits.maxHashtags, received: hashtags });
  }

  const postId = `post_${crypto.randomBytes(8).toString("hex")}`;
  posts.set(postId, {
    postId,
    platform: req.params.platform,
    externalId,
    caption,
    mediaId: mediaId || "inline",
    createdAt: new Date().toISOString(),
  });
  byIdempotencyKey.set(scoped, postId);

  scheduleDelivery(posts.get(postId));

  // The post exists here, before the caller has the response. That ordering is
  // the whole reason idempotency keys matter: a caller that dies now has
  // produced a post it has no record of.
  setTimeout(() => {
    res.status(201).json({ post_id: postId, duplicate: false, status: "accepted" });
  }, latencyMs);
});

app.get("/:platform/posts", knownPlatform, (req, res) => {
  const mine = [...posts.values()].filter((p) => p.platform === req.params.platform);
  res.json({ count: mine.length, posts: mine });
});

app.post("/_control/chaos", (req, res) => {
  chaos = { failNext: Number(req.body?.fail_next || 0), status: Number(req.body?.status || 429) };
  res.json(chaos);
});

// Lets a test that fakes its own clock keep this server's clock in step. A
// test that replaces the adapter's sleep has stopped time on one side only,
// and the rate limiter would then see four requests in an instant that the
// adapter believes were spread over twenty seconds.
app.post("/_control/advance", (req, res) => {
  const ms = Number(req.body?.ms || 0);
  for (const [key, times] of requestLog) {
    requestLog.set(key, times.map((at) => at - ms));
  }
  res.json({ advanced_ms: ms });
});

app.post("/_control/latency", (req, res) => {
  latencyMs = Number(req.body?.ms || 0);
  res.json({ latency_ms: latencyMs });
});

app.post("/_control/reset", (_req, res) => {
  posts.clear();
  byIdempotencyKey.clear();
  requestLog.clear();
  chaos = { failNext: 0, status: 429 };
  latencyMs = 0;
  res.json({ ok: true });
});

// The delivery callback. Real platforms accept a post, queue it, and tell you
// later whether it went out, which is why the studio cannot mark anything
// published at the moment it gets a 201.
function scheduleDelivery(post) {
  setTimeout(async () => {
    const body = JSON.stringify({
      post_id: post.postId,
      external_id: post.externalId,
      platform: post.platform,
      status: "published",
      permalink: `https://${post.platform}.example/p/${post.postId}`,
      occurred_at: new Date().toISOString(),
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-timestamp": timestamp,
          "x-signature": `sha256=${signature}`,
        },
        body,
      });
    } catch (error) {
      console.error(`delivery webhook for ${post.postId} failed: ${error.message}`);
    }
  }, DELIVERY_DELAY_MS);
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`fake platform listening on ${PORT}, delivering to ${WEBHOOK_URL}`);
  });
}

module.exports = { app, PLATFORMS };

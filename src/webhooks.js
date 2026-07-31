// Delivery callbacks from the platform, and the reasons to disbelieve one.
//
// A webhook endpoint is a public URL that changes your data. Four things have
// to be true before this one writes anything:
//
//   the signature is present and the right shape
//   it verifies against the raw bytes, not a re-serialised object
//   the timestamp is inside the replay window
//   this exact signature has not been seen before
//
// The raw bytes matter more than they look. JSON.parse followed by
// JSON.stringify can reorder keys and change number formatting, and then a
// signature that was valid stops verifying, or worse, a body that was tampered
// with re-serialises to something that verifies.

const crypto = require("crypto");

const { sameSignature } = require("./crypto");

const REPLAY_WINDOW_SECONDS = Number(process.env.WEBHOOK_REPLAY_WINDOW || 300);

class WebhookRejected extends Error {
  constructor(reason) {
    super(reason);
    this.name = "WebhookRejected";
    this.status = 400;
  }
}

function sign(rawBody, timestamp, secret) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/**
 * @param {Buffer} rawBody exactly the bytes that arrived
 * @throws {WebhookRejected}
 */
function verify(rawBody, headers, secret, { now = Date.now() } = {}) {
  const header = headers["x-signature"];
  const timestamp = headers["x-timestamp"];

  if (!header || !timestamp) throw new WebhookRejected("missing signature or timestamp");
  if (!header.startsWith("sha256=")) throw new WebhookRejected("unsupported signature scheme");

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age)) throw new WebhookRejected("unreadable timestamp");
  if (age > REPLAY_WINDOW_SECONDS) {
    throw new WebhookRejected(`timestamp is ${Math.round(age)}s away, outside the replay window`);
  }

  const expected = sign(rawBody.toString("utf8"), timestamp, secret);
  if (!sameSignature(header.slice(7), expected)) throw new WebhookRejected("signature does not verify");

  return header;
}

/** Returns false when this signature has already been processed. */
async function recordDelivery(pool, signature) {
  const { rows } = await pool.query(
    "INSERT INTO webhook_deliveries (signature) VALUES ($1) ON CONFLICT (signature) DO NOTHING RETURNING id",
    [signature]
  );
  return rows.length > 0;
}

module.exports = { verify, sign, recordDelivery, WebhookRejected, REPLAY_WINDOW_SECONDS };

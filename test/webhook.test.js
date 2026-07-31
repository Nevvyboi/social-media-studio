const assert = require("node:assert/strict");
const { test } = require("node:test");

const { sign, verify, WebhookRejected } = require("../src/webhooks");

const SECRET = "webhook-secret";
const BODY = Buffer.from(JSON.stringify({ post_id: "post_1", status: "published" }));

function headersFor(body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  return {
    "x-timestamp": String(timestamp),
    "x-signature": `sha256=${sign(body.toString("utf8"), String(timestamp), secret)}`,
  };
}

test("a correctly signed delivery verifies", () => {
  assert.doesNotThrow(() => verify(BODY, headersFor(BODY), SECRET));
});

test("a forged signature is rejected", () => {
  const headers = headersFor(BODY);
  headers["x-signature"] = `sha256=${"0".repeat(64)}`;

  assert.throws(() => verify(BODY, headers, SECRET), (error) => {
    assert.ok(error instanceof WebhookRejected);
    assert.equal(error.status, 400);
    assert.match(error.message, /does not verify/);
    return true;
  });
});

test("a body edited after signing is rejected", () => {
  const headers = headersFor(BODY);
  const tampered = Buffer.from(JSON.stringify({ post_id: "post_1", status: "failed" }));

  assert.throws(() => verify(tampered, headers, SECRET), /does not verify/);
});

test("a signature from the wrong secret is rejected", () => {
  assert.throws(() => verify(BODY, headersFor(BODY, { secret: "not-the-secret" }), SECRET), /does not verify/);
});

test("an old but genuine delivery is rejected as a replay", () => {
  const stale = Math.floor(Date.now() / 1000) - 3600;

  assert.throws(() => verify(BODY, headersFor(BODY, { timestamp: stale }), SECRET), /replay window/);
});

test("a delivery with no signature at all is rejected", () => {
  assert.throws(() => verify(BODY, { "x-timestamp": "123" }, SECRET), /missing signature/);
  assert.throws(() => verify(BODY, {}, SECRET), /missing signature/);
});

test("a signature scheme we do not implement is rejected rather than ignored", () => {
  const headers = headersFor(BODY);
  headers["x-signature"] = headers["x-signature"].replace("sha256=", "md5=");

  assert.throws(() => verify(BODY, headers, SECRET), /unsupported signature scheme/);
});

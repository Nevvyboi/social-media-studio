// Publishing tests against the real fake platform, started in this process.
//
// Nothing is stubbed here except the clock: the adapter's sleep is replaced so
// a 429 with Retry-After: 2 does not cost the test two seconds, and so the
// test can assert how long the adapter decided to wait rather than inferring
// it from a stopwatch.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");

const { app: platformApp } = require("../fake-platform/server");
const { buildPublishers } = require("../src/publisher/registry");
const { decrypt } = require("../src/crypto");
const { variantFor } = require("../src/images");

const KEY = "test-encryption-key";
const source = fs.readFileSync(path.join(__dirname, "..", "assets", "source.png"));

let server;
let baseUrl;
let slept;
let tokens;

before(async () => {
  server = platformApp.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function publishers() {
  slept = [];
  tokens = new Map();
  return buildPublishers({
    baseUrl,
    credentials: { client_id: "studio-local", client_secret: "studio-local-secret" },
    tokenStore: {
      async get(key) {
        return tokens.get(key);
      },
      async put(key, value) {
        tokens.set(key, value);
      },
    },
    encryptionKey: KEY,
    // The clock is the only thing stubbed. Advancing the platform's window by
    // the same amount keeps both sides of the test on one clock, so a 429 the
    // adapter believes it waited out is one the platform believes it waited
    // out too.
    sleep: async (ms) => {
      slept.push(ms);
      await advance(ms);
    },
  });
}

async function advance(ms) {
  await fetch(`${baseUrl}/_control/advance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ms }),
  });
}

async function reset() {
  await fetch(`${baseUrl}/_control/reset`, { method: "POST" });
}

async function requestFor(platform, externalId) {
  return {
    externalId,
    caption: "a caption well inside every limit",
    image: await variantFor(source, platform, { focus: { x: 0.62, y: 0.3 } }),
    idempotencyKey: `${externalId}:${platform}`,
  };
}

async function countOn(platform) {
  const body = await fetch(`${baseUrl}/${platform}/posts`).then((r) => r.json());
  return body.count;
}

test("publishing the same post twice yields one post on the platform", async () => {
  for (const platform of ["instagram", "x"]) {
    await reset();
    const registry = publishers();
    const request = await requestFor(platform, `dup-${platform}`);

    const first = await registry.for(platform).publish(request);
    const second = await registry.for(platform).publish(request);

    assert.equal(second.postId, first.postId, `${platform} returned a different post on the retry`);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true, `${platform} did not recognise the idempotency key`);
    assert.equal(await countOn(platform), 1, `${platform} stored more than one post`);
  }
});

// Instagram allows 3 writes per 10 seconds and publishing twice takes 4, so
// this one hits the real limiter rather than an injected failure.
test("a real rate limit is waited out and the post still lands once", async () => {
  await reset();
  const registry = publishers();
  const request = await requestFor("instagram", "throttled-for-real");

  const first = await registry.for("instagram").publish(request);
  const second = await registry.for("instagram").publish(request);

  assert.equal(second.postId, first.postId);
  assert.ok(slept.length >= 1, "the limiter was never hit, so this test proves nothing");
  assert.ok(slept.every((ms) => ms >= 1000), `waits came from Retry-After, got ${JSON.stringify(slept)}`);
  assert.equal(await countOn("instagram"), 1);
});

test("a 429 is waited out for exactly as long as the platform asked", async () => {
  await reset();
  const registry = publishers();
  await fetch(`${baseUrl}/_control/chaos`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fail_next: 1, status: 429 }),
  });

  const result = await registry.for("x").publish(await requestFor("x", "throttled"));

  assert.ok(result.postId, "the publish did not recover from the 429");
  assert.deepEqual(slept, [2000], `expected one 2s wait from Retry-After, got ${JSON.stringify(slept)}`);
  assert.equal(await countOn("x"), 1);
});

test("a permanent refusal is not retried", async () => {
  await reset();
  const registry = publishers();
  const request = await requestFor("x", "too-long");
  request.caption = "a".repeat(300);

  await assert.rejects(() => registry.for("x").publish(request), (error) => {
    assert.equal(error.permanent, true);
    assert.equal(error.details.status, 422);
    assert.match(error.message, /caption too long/);
    return true;
  });

  assert.deepEqual(slept, [], "a 422 was retried, which wastes the retry budget");
  assert.equal(await countOn("x"), 0);
});

test("an image of the wrong size is refused by the platform", async () => {
  await reset();
  const registry = publishers();
  const request = await requestFor("x", "wrong-size");
  request.image = await variantFor(source, "instagram", { focus: { x: 0.5, y: 0.5 } });

  await assert.rejects(() => registry.for("x").publish(request), (error) => {
    assert.match(error.message, /dimensions rejected/);
    assert.equal(error.details.expected, "1600x900");
    return true;
  });
});

test("the stored token is ciphertext and reads back correctly", async () => {
  await reset();
  const registry = publishers();
  await registry.for("x").publish(await requestFor("x", "token-check"));

  const stored = tokens.get("x");
  assert.match(stored.ciphertext, /^v1:/);
  assert.ok(!stored.ciphertext.includes(decrypt(stored.ciphertext, KEY)), "plaintext appears in the stored value");
  assert.equal(decrypt(stored.ciphertext, KEY).length, 48);
});

test("two encryptions of one token differ, so the IV is not reused", async () => {
  await reset();
  const first = publishers();
  await first.for("x").publish(await requestFor("x", "iv-one"));
  const a = tokens.get("x").ciphertext;

  const second = publishers();
  await second.for("x").publish(await requestFor("x", "iv-two"));
  const b = tokens.get("x").ciphertext;

  assert.notEqual(a, b, "the same key and IV produced the same ciphertext twice");
});

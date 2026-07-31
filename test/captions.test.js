const assert = require("node:assert/strict");
const { test } = require("node:test");

const { PER_PLATFORM, SHARED, composePrompt } = require("../src/captions/fragments");
const { PLATFORMS, platformKeys } = require("../src/platforms");
const { captionFor, enforce } = require("../src/captions/compose");

const post = require("../fixtures/post.json");

test("no platform fragment repeats a shared one", () => {
  const shared = Object.values(SHARED).map(normalise);

  for (const [platform, fragments] of Object.entries(PER_PLATFORM)) {
    for (const [name, text] of Object.entries(fragments)) {
      assert.ok(
        !shared.includes(normalise(text)),
        `${platform}.${name} duplicates a shared fragment, so a fix to one would miss the other`
      );
    }
  }
});

test("no two platforms share a fragment that should have been shared", () => {
  const [a, b] = Object.keys(PER_PLATFORM);
  for (const name of Object.keys(PER_PLATFORM[a])) {
    assert.notEqual(
      normalise(PER_PLATFORM[a][name]),
      normalise(PER_PLATFORM[b][name]),
      `${a}.${name} and ${b}.${name} are identical, so they belong in SHARED`
    );
  }
});

test("every platform prompt carries the grounding rule exactly once", () => {
  for (const key of Object.keys(PER_PLATFORM)) {
    const { system, fragments } = composePrompt(post, key);
    const occurrences = system.split(SHARED.grounding).length - 1;

    assert.equal(occurrences, 1, `${key} prompt contains the grounding rule ${occurrences} times`);
    assert.ok(fragments.includes("shared.grounding"));
    assert.ok(fragments.some((f) => f.startsWith(`${key}.`)), `${key} contributed nothing of its own`);
  }
});

test("captions come back inside every platform limit", async () => {
  for (const key of platformKeys()) {
    const limits = PLATFORMS[key].caption;
    const { caption } = await captionFor(post, key);
    const hashtags = (caption.match(/#\w+/g) || []).length;

    assert.ok(caption.length > 0, `${key} caption is empty`);
    assert.ok(caption.length <= limits.maxLength, `${key} caption is ${caption.length}, limit ${limits.maxLength}`);
    assert.ok(hashtags <= limits.maxHashtags, `${key} has ${hashtags} hashtags, limit ${limits.maxHashtags}`);
    assert.ok(caption.includes(post.url), `${key} caption dropped the link`);
  }
});

test("the two platforms do not get the same caption", async () => {
  const [a, b] = await Promise.all([captionFor(post, "instagram"), captionFor(post, "x")]);
  assert.notEqual(a.caption, b.caption);
});

test("a writer that ignores the limit is still cut to it", () => {
  const overlong = "word ".repeat(200);
  const caption = enforce(overlong, PLATFORMS.x, post);

  assert.ok(caption.length <= PLATFORMS.x.caption.maxLength);
  assert.ok(caption.endsWith("…"), "the cut was not marked");
});

test("a writer that ignores the hashtag limit has the extras dropped", () => {
  const tagged = `something worth reading ${Array.from({ length: 12 }, (_, i) => `#tag${i}`).join(" ")}`;
  const caption = enforce(tagged, PLATFORMS.x, post);

  assert.equal((caption.match(/#\w+/g) || []).length, PLATFORMS.x.caption.maxHashtags);
});

test("an empty caption is an error rather than an empty post", () => {
  assert.throws(() => enforce("   ", PLATFORMS.x, post), /came back empty/);
});

function normalise(text) {
  return String(text).replace(/\s+/g, " ").trim().toLowerCase();
}

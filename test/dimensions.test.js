const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const sharp = require("sharp");

const { PLATFORMS, platformKeys } = require("../src/platforms");
const { safeZonePixels, variantFor } = require("../src/images");

const SOURCE = path.join(__dirname, "..", "assets", "source.png");
const source = fs.readFileSync(SOURCE);

// The subject in the generated source, high and right of centre. This is the
// case a centre crop loses, which is why the fixture is not centred.
const FOCUS = { x: 0.62, y: 0.3 };

test("every platform gets exactly the pixel dimensions it asks for", async () => {
  for (const key of platformKeys()) {
    const variant = await variantFor(source, key, { focus: FOCUS });
    const meta = await sharp(variant.buffer).metadata();
    const want = PLATFORMS[key].image;

    assert.equal(meta.width, want.width, `${key} width`);
    assert.equal(meta.height, want.height, `${key} height`);
    assert.equal(variant.width, want.width);
    assert.equal(variant.height, want.height);
  }
});

test("the subject lands inside the safe zone on every platform", async () => {
  for (const key of platformKeys()) {
    const spec = PLATFORMS[key].image;
    const variant = await variantFor(source, key, { focus: FOCUS });
    const zone = safeZonePixels(spec.safeZone, spec.width, spec.height);
    const at = variant.focusLandsAt;

    assert.deepEqual(variant.warnings, [], `${key} reported a warning`);
    assert.ok(at.x >= zone.left && at.x <= zone.right, `${key} subject x ${at.x} outside ${zone.left}..${zone.right}`);
    assert.ok(at.y >= zone.top && at.y <= zone.bottom, `${key} subject y ${at.y} outside ${zone.top}..${zone.bottom}`);
  }
});

test("a subject the crop cannot hold is reported, not silently mangled", async () => {
  const variant = await variantFor(source, "x", { focus: { x: 0.98, y: 0.03 } });

  assert.equal(variant.warnings.length, 1);
  assert.match(variant.warnings[0], /outside the safe zone/);
  // The variant is still produced at the right size. The caller decides what
  // to do about a warning; the pipeline does not refuse on its behalf.
  assert.equal(variant.width, PLATFORMS.x.image.width);
});

test("the brand overlay stays out of the safe zone", async () => {
  const spec = PLATFORMS.instagram.image;
  const plain = await variantFor(source, "instagram", { focus: FOCUS });
  const branded = await variantFor(source, "instagram", { focus: FOCUS, brand: "FLYRANK STUDIO" });

  const zone = safeZonePixels(spec.safeZone, spec.width, spec.height);
  const box = { left: 0, top: zone.top, width: spec.width, height: zone.bottom - zone.top };

  const a = await sharp(plain.buffer).extract(box).raw().toBuffer();
  const b = await sharp(branded.buffer).extract(box).raw().toBuffer();

  assert.ok(a.equals(b), "the overlay changed pixels inside the safe zone");
});

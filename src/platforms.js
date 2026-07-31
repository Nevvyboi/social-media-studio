// The studio's own record of what each platform wants.
//
// These numbers are not imported from the fake platform. They are what this
// service believes, the way a real integration encodes your reading of a
// vendor's docs, and the integration test is what proves the belief is right.
// When they drift, publishing fails with a 422 that names the difference,
// which is the failure you want: loud, early, and specific.

const SAFE_ZONE_MARGIN = 0.08; // fraction of the shorter edge kept clear of the subject

const PLATFORMS = {
  instagram: {
    key: "instagram",
    label: "Instagram",
    image: {
      width: 1080,
      height: 1080,
      aspect: "1:1",
      // Instagram crops the top and bottom of a square in some surfaces, so the
      // subject is kept inside a slightly taller inset than the sides need.
      safeZone: { top: 0.12, bottom: 0.12, left: SAFE_ZONE_MARGIN, right: SAFE_ZONE_MARGIN },
    },
    caption: { maxLength: 2200, maxHashtags: 30, hashtagCount: 6 },
    voice: "warm",
  },
  x: {
    key: "x",
    label: "X",
    image: {
      width: 1600,
      height: 900,
      aspect: "16:9",
      safeZone: { top: 0.1, bottom: 0.1, left: SAFE_ZONE_MARGIN, right: SAFE_ZONE_MARGIN },
    },
    caption: { maxLength: 280, maxHashtags: 4, hashtagCount: 2 },
    voice: "terse",
  },
};

function platform(key) {
  const spec = PLATFORMS[key];
  if (!spec) {
    throw new Error(`unknown platform ${key}, expected one of ${Object.keys(PLATFORMS).join(", ")}`);
  }
  return spec;
}

function platformKeys() {
  return Object.keys(PLATFORMS);
}

module.exports = { PLATFORMS, platform, platformKeys };

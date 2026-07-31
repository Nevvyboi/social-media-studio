// One source image to one variant per platform.
//
// The interesting part is not the resize. It is that each platform crops a
// different shape out of the same picture, and the thing you care about, the
// subject, has to survive that crop and land somewhere the platform's own UI
// will not cover with a caption, an avatar or a play button. That region is
// the safe zone, and honouring it is what separates a variant pipeline from
// a call to resize().

const sharp = require("sharp");

const { platform } = require("./platforms");

/**
 * @param {Buffer} source
 * @param {string} platformKey
 * @param {{ focus?: {x: number, y: number}, brand?: string }} options
 *   focus is where the subject is in the source, as fractions of width and
 *   height. It defaults to the centre, which is what you assume when nobody
 *   has told you anything about the picture.
 */
async function variantFor(source, platformKey, options = {}) {
  const spec = platform(platformKey);
  const { width, height, safeZone } = spec.image;
  const focus = options.focus || { x: 0.5, y: 0.5 };

  const meta = await sharp(source).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("source image has no readable dimensions");
  }

  const crop = cropWindow(meta, { width, height }, focus);
  const landing = project(focus, meta, crop, { width, height });
  const warnings = [];

  const zone = safeZonePixels(safeZone, width, height);
  if (!inside(landing, zone)) {
    warnings.push(
      `subject lands at ${Math.round(landing.x)},${Math.round(landing.y)}, outside the safe zone ` +
        `${zone.left},${zone.top} to ${zone.right},${zone.bottom}. The source is too far from ` +
        `${spec.image.aspect} to hold the subject inside the crop.`
    );
  }

  let pipeline = sharp(source)
    .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
    .resize(width, height, { fit: "fill" });

  if (options.brand) {
    pipeline = pipeline.composite([
      { input: brandOverlay(options.brand, width, height, safeZone), top: 0, left: 0 },
    ]);
  }

  const buffer = await pipeline.png().toBuffer();
  return { platform: spec.key, width, height, buffer, focusLandsAt: landing, warnings };
}

async function variantsFor(source, platformKeys, options = {}) {
  const out = {};
  for (const key of platformKeys) {
    out[key] = await variantFor(source, key, options);
  }
  return out;
}

/**
 * The largest window of the target aspect that fits inside the source, slid so
 * the subject sits in the middle of the safe zone, then clamped to the source
 * edges. Clamping is why a variant can still come back with a warning: past a
 * certain point you cannot both stay inside the picture and centre the subject.
 */
function cropWindow(meta, target, focus) {
  const targetAspect = target.width / target.height;
  const sourceAspect = meta.width / meta.height;

  let cropWidth;
  let cropHeight;
  if (sourceAspect > targetAspect) {
    cropHeight = meta.height;
    cropWidth = Math.round(cropHeight * targetAspect);
  } else {
    cropWidth = meta.width;
    cropHeight = Math.round(cropWidth / targetAspect);
  }
  cropWidth = Math.min(cropWidth, meta.width);
  cropHeight = Math.min(cropHeight, meta.height);

  const left = clamp(Math.round(focus.x * meta.width - cropWidth / 2), 0, meta.width - cropWidth);
  const top = clamp(Math.round(focus.y * meta.height - cropHeight / 2), 0, meta.height - cropHeight);

  return { left, top, width: cropWidth, height: cropHeight };
}

function project(focus, meta, crop, target) {
  return {
    x: ((focus.x * meta.width - crop.left) / crop.width) * target.width,
    y: ((focus.y * meta.height - crop.top) / crop.height) * target.height,
  };
}

function safeZonePixels(safeZone, width, height) {
  return {
    left: Math.round(safeZone.left * width),
    right: Math.round((1 - safeZone.right) * width),
    top: Math.round(safeZone.top * height),
    bottom: Math.round((1 - safeZone.bottom) * height),
  };
}

function inside(point, zone) {
  return point.x >= zone.left && point.x <= zone.right && point.y >= zone.top && point.y <= zone.bottom;
}

// The wordmark sits in the margin the safe zone already reserves, so branding
// never competes with the subject for the same pixels.
function brandOverlay(text, width, height, safeZone) {
  const barHeight = Math.round(safeZone.bottom * height * 0.7);
  const fontSize = Math.round(barHeight * 0.42);
  const padding = Math.round(width * 0.03);
  const escaped = String(text).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
       <rect x="0" y="${height - barHeight}" width="${width}" height="${barHeight}"
             fill="rgba(12,14,18,0.72)"/>
       <text x="${padding}" y="${height - barHeight / 2 + fontSize / 3}"
             font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}"
             font-weight="600" fill="#f4f6f8" letter-spacing="1">${escaped}</text>
     </svg>`
  );
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

module.exports = { variantFor, variantsFor, cropWindow, safeZonePixels };

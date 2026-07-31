// Makes the source image the pipeline crops from.
//
// The brief says generating this with a model is encouraged and that the
// variant spec is what gets graded. There is no image model available in this
// environment, so this draws one: a tall source with the subject deliberately
// off centre and high, which is the case that makes a naive centre crop lose
// it. A crosshair marks the subject so you can see where each variant put it.

const { writeFileSync, mkdirSync } = require("fs");
const path = require("path");

const sharp = require("sharp");

const WIDTH = 1400;
const HEIGHT = 1900;
const FOCUS = { x: 0.62, y: 0.3 };

async function main() {
  const cx = Math.round(FOCUS.x * WIDTH);
  const cy = Math.round(FOCUS.y * HEIGHT);

  const svg = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#12333f"/>
        <stop offset="60%" stop-color="#1d5566"/>
        <stop offset="100%" stop-color="#0d1b21"/>
      </linearGradient>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>
    ${horizonLines()}
    <circle cx="${cx}" cy="${cy}" r="210" fill="#f2b544"/>
    <circle cx="${cx}" cy="${cy}" r="210" fill="none" stroke="#0d1b21" stroke-width="10"/>
    <line x1="${cx - 260}" y1="${cy}" x2="${cx + 260}" y2="${cy}" stroke="#f2b544" stroke-width="4"/>
    <line x1="${cx}" y1="${cy - 260}" x2="${cx}" y2="${cy + 260}" stroke="#f2b544" stroke-width="4"/>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
          font-size="46" font-weight="700" fill="#0d1b21">SUBJECT</text>
    <text x="60" y="${HEIGHT - 70}" font-family="Helvetica, Arial, sans-serif" font-size="40"
          fill="rgba(244,246,248,0.55)">source ${WIDTH}x${HEIGHT} · subject at ${FOCUS.x}, ${FOCUS.y}</text>
  </svg>`;

  const out = path.join(__dirname, "..", "assets");
  mkdirSync(out, { recursive: true });
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  writeFileSync(path.join(out, "source.png"), buffer);
  console.log(`wrote assets/source.png, ${WIDTH}x${HEIGHT}, subject at ${FOCUS.x}, ${FOCUS.y}`);
}

function horizonLines() {
  const lines = [];
  for (let i = 1; i < 9; i += 1) {
    const y = Math.round((HEIGHT / 9) * i);
    lines.push(`<line x1="0" y1="${y}" x2="${WIDTH}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="3"/>`);
  }
  return lines.join("");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { FOCUS, WIDTH, HEIGHT };

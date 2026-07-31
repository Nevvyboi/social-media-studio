const path = require("path");

const ROOT = path.join(__dirname, "..");

const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL,
  platformBaseUrl: process.env.PLATFORM_BASE_URL || "http://localhost:4010",
  credentials: {
    client_id: process.env.PLATFORM_CLIENT_ID || "studio-local",
    client_secret: process.env.PLATFORM_CLIENT_SECRET || "studio-local-secret",
  },
  webhookSecret: process.env.PLATFORM_WEBHOOK_SECRET || "webhook-secret",
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  mediaDir: process.env.MEDIA_DIR || path.join(ROOT, "out", "media"),
  sourceImage: process.env.SOURCE_IMAGE || path.join(ROOT, "assets", "source.png"),
  brand: process.env.BRAND_TEXT || "FLYRANK STUDIO",
  pollIntervalMs: Number(process.env.WORKER_POLL_MS || 1000),
};

module.exports = { config, ROOT };

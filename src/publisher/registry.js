// The only place that knows which class serves which platform.
//
// The worker calls publisherFor("x") and gets something implementing
// SocialPublisher. It never sees InstagramPublisher or XPublisher by name.

const { HttpPlatform } = require("./http-platform");
const { InstagramPublisher } = require("./instagram");
const { XPublisher } = require("./x");
const { SocialPublisher } = require("./publisher");

const IMPLEMENTATIONS = {
  instagram: InstagramPublisher,
  x: XPublisher,
};

function buildPublishers(config) {
  const publishers = new Map();

  for (const [key, Implementation] of Object.entries(IMPLEMENTATIONS)) {
    const http = new HttpPlatform({
      platform: key,
      baseUrl: config.baseUrl,
      credentials: config.credentials,
      tokenStore: config.tokenStore,
      encryptionKey: config.encryptionKey,
      maxAttempts: config.maxAttempts,
      sleep: config.sleep,
      log: config.log,
    });
    const publisher = new Implementation(http);

    if (!(publisher instanceof SocialPublisher)) {
      throw new Error(`${key} publisher does not implement SocialPublisher`);
    }
    publishers.set(key, publisher);
  }

  return {
    for(platformKey) {
      const publisher = publishers.get(platformKey);
      if (!publisher) throw new Error(`no publisher registered for ${platformKey}`);
      return publisher;
    },
    keys: () => [...publishers.keys()],
  };
}

module.exports = { buildPublishers };

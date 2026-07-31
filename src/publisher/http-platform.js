// What the two adapters share: getting a token, keeping it encrypted, sending
// a request, and knowing which failures are worth retrying.
//
// The retry policy here is small and deliberate. A 429 is not a failure, it is
// the platform telling you the rate at which it will accept work, so
// Retry-After is honoured to the second rather than replaced with a guess. A
// 5xx is retried with backoff and jitter. A 4xx that is not 429 is permanent:
// the request was wrong and sending it again wastes the retry budget and the
// platform's patience.

const { PermanentPublishError, TransientPublishError } = require("./publisher");
const { encrypt, decrypt } = require("../crypto");

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

class HttpPlatform {
  constructor({ platform, baseUrl, credentials, tokenStore, encryptionKey, maxAttempts = 4, sleep, log }) {
    this.platformKey = platform;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.credentials = credentials;
    this.tokenStore = tokenStore;
    this.encryptionKey = encryptionKey;
    this.maxAttempts = maxAttempts;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = log || (() => {});
  }

  /**
   * A valid bearer token, from the store if one is there and unexpired,
   * otherwise from the platform. What lands in the store is ciphertext: the
   * plaintext exists in this process and nowhere else.
   */
  async token({ fresh = false } = {}) {
    const stored = fresh ? null : await this.tokenStore.get(this.platformKey);
    if (stored && stored.expiresAt > Date.now() + 30_000) {
      return decrypt(stored.ciphertext, this.encryptionKey);
    }

    const response = await fetch(`${this.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.credentials),
    });
    if (!response.ok) {
      throw new PermanentPublishError(`${this.platformKey} rejected the client credentials`, {
        status: response.status,
      });
    }

    const body = await response.json();
    await this.tokenStore.put(this.platformKey, {
      ciphertext: encrypt(body.access_token, this.encryptionKey),
      expiresAt: Date.now() + body.expires_in * 1000,
    });
    return body.access_token;
  }

  /**
   * One request, with the retry policy applied. `idempotencyKey` is passed
   * through on every attempt including the retries, which is the whole reason
   * a retry after a timeout cannot double post.
   */
  async request(path, { method = "POST", body, idempotencyKey }) {
    let lastError = null;
    let refreshed = false;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${await this.token({ fresh: refreshed })}`,
      };
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

      let response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        lastError = new TransientPublishError(`${this.platformKey} unreachable: ${error.message}`);
        await this.backOff(attempt, lastError.message);
        continue;
      }

      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload;

      // A 401 is not a permanent refusal on the first sight of it. Tokens get
      // revoked, keys rotate, and a platform that restarts forgets what it
      // issued while our copy of it sits in the database looking unexpired.
      // Refresh once and try again; a second 401 means the credentials are
      // genuinely wrong and no amount of retrying fixes that.
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.log(`${this.platformKey} rejected the stored token, fetching a new one`);
        attempt -= 1;
        continue;
      }

      if (!RETRYABLE_STATUSES.has(response.status)) {
        throw new PermanentPublishError(
          `${this.platformKey} refused: ${payload.error || response.status}`,
          { status: response.status, ...payload }
        );
      }

      lastError = new TransientPublishError(`${this.platformKey} returned ${response.status}`, {
        status: response.status,
        ...payload,
      });

      if (attempt === this.maxAttempts) break;
      await this.backOff(attempt, lastError.message, response.headers.get("retry-after"));
    }

    throw lastError;
  }

  async backOff(attempt, why, retryAfter) {
    let waitMs;
    if (retryAfter) {
      // The platform named a number. Use it rather than a guess that is either
      // rude or slow.
      waitMs = Number(retryAfter) * 1000;
      this.log(`${why}, waiting the ${retryAfter}s the platform asked for`);
    } else {
      waitMs = 2 ** attempt * 100 + Math.random() * 200;
      this.log(`${why}, backing off ${Math.round(waitMs)}ms before attempt ${attempt + 1}`);
    }
    await this.sleep(waitMs);
  }
}

module.exports = { HttpPlatform, RETRYABLE_STATUSES };

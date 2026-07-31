// The one interface the rest of the application is allowed to know about.
//
// Nothing outside src/publisher/ imports a platform module, constructs a
// request, or knows that Instagram needs two round trips and X needs one. The
// worker asks a SocialPublisher to publish and gets back a post id. Adding a
// third platform is a new file in this directory and a line in the registry.

class SocialPublisher {
  /** @returns {string} the platform key, matching src/platforms.js */
  get platform() {
    throw new Error("not implemented");
  }

  /**
   * Publish one post. Must be idempotent on idempotencyKey: calling it twice
   * with the same key, whether because the caller retried or because the first
   * response was lost, produces one post on the platform.
   *
   * @param {{
   *   externalId: string,
   *   caption: string,
   *   image: { buffer: Buffer, width: number, height: number },
   *   idempotencyKey: string
   * }} request
   * @returns {Promise<{ postId: string, duplicate: boolean }>}
   */
  // eslint-disable-next-line no-unused-vars
  async publish(request) {
    throw new Error("not implemented");
  }
}

/**
 * Raised when the platform said no in a way that retrying will not fix: a
 * caption over the limit, an image of the wrong size, a rejected token. The
 * worker fails these immediately instead of spending its retry budget.
 */
class PermanentPublishError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PermanentPublishError";
    this.details = details;
    this.permanent = true;
  }
}

/** Raised when the platform said no in a way that retrying might fix. */
class TransientPublishError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TransientPublishError";
    this.details = details;
    this.permanent = false;
  }
}

module.exports = { SocialPublisher, PermanentPublishError, TransientPublishError };

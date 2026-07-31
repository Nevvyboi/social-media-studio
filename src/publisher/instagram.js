// Instagram: upload the media, then reference it by id when creating the post.
//
// Two round trips, mirroring the container step in the real Graph API. The
// idempotency key goes on the post, not the upload: uploading the same bytes
// twice costs a media id and nothing else, but creating the post twice is the
// bug this whole layer exists to prevent.

const { SocialPublisher } = require("./publisher");

class InstagramPublisher extends SocialPublisher {
  constructor(http) {
    super();
    this.http = http;
  }

  get platform() {
    return "instagram";
  }

  async publish({ externalId, caption, image, idempotencyKey }) {
    const media = await this.http.request("/instagram/media", {
      body: {
        image_base64: image.buffer.toString("base64"),
        width: image.width,
        height: image.height,
      },
    });

    const post = await this.http.request("/instagram/posts", {
      idempotencyKey,
      body: { media_id: media.media_id, caption, external_id: externalId },
    });

    return { postId: post.post_id, duplicate: Boolean(post.duplicate) };
  }
}

module.exports = { InstagramPublisher };

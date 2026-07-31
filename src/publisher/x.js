// X: one request, image inline.
//
// Different enough from Instagram that the two cannot share an implementation,
// which is the point of having an interface rather than a switch statement.
// The caller does not know or care which of these two shapes it got.

const { SocialPublisher } = require("./publisher");

class XPublisher extends SocialPublisher {
  constructor(http) {
    super();
    this.http = http;
  }

  get platform() {
    return "x";
  }

  async publish({ externalId, caption, image, idempotencyKey }) {
    const post = await this.http.request("/x/posts", {
      idempotencyKey,
      body: {
        image_base64: image.buffer.toString("base64"),
        width: image.width,
        height: image.height,
        caption,
        external_id: externalId,
      },
    });

    return { postId: post.post_id, duplicate: Boolean(post.duplicate) };
  }
}

module.exports = { XPublisher };

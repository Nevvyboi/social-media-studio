// What this platform accepts. The studio keeps its own copy of these numbers
// in src/platforms.js rather than importing this file, because in reality you
// read a vendor's documentation and encode your understanding of it. Sharing
// one constant would make the dimension test circular: it would prove the
// studio agrees with itself. The integration test proves they agree by
// publishing and seeing whether this server accepts it.

const PLATFORMS = {
  instagram: {
    image: { width: 1080, height: 1080 },
    caption: { maxLength: 2200, maxHashtags: 30 },
    rateLimit: { posts: 3, perSeconds: 10 },
  },
  x: {
    image: { width: 1600, height: 900 },
    caption: { maxLength: 280, maxHashtags: 4 },
    rateLimit: { posts: 2, perSeconds: 10 },
  },
};

module.exports = { PLATFORMS };

// From a blog post to a caption each platform will accept.
//
// The writer is injectable. In production it is a model call taking the prompt
// that fragments.js assembled. There is no model key in this environment, so
// the default is a deterministic writer that composes from the post's own
// sentences, which keeps the pipeline runnable end to end and keeps the tests
// free of a network.
//
// Whichever writer runs, the limits are enforced here afterwards. A prompt
// that asks for 280 characters is a request. A function that refuses to return
// 300 is a control, and the platform enforces the same limit with a 422, so a
// caption that slips through is a failed publish rather than a long caption.

const { platform } = require("../platforms");
const { composePrompt } = require("./fragments");

async function captionFor(post, platformKey, options = {}) {
  const spec = platform(platformKey);
  const prompt = composePrompt(post, platformKey);
  const write = options.write || localWriter;

  const draft = await write(prompt, post, spec);
  const caption = enforce(draft, spec, post);

  return { platform: platformKey, caption, fragments: prompt.fragments, prompt };
}

async function captionsFor(post, platformKeys, options = {}) {
  const out = {};
  for (const key of platformKeys) {
    out[key] = await captionFor(post, key, options);
  }
  return out;
}

/**
 * Cut the caption down to what the platform accepts, at a word boundary, and
 * drop hashtags past the limit. Returns a caption or throws: there is no
 * version of this that quietly returns something the platform will reject.
 */
function enforce(draft, spec, post) {
  let text = String(draft || "").trim();
  if (!text) {
    throw new Error(`caption for ${spec.key} came back empty for "${post.title}"`);
  }

  text = capHashtags(text, spec.caption.maxHashtags);

  if (text.length > spec.caption.maxLength) {
    text = truncateAtWord(text, spec.caption.maxLength);
  }
  if (text.length > spec.caption.maxLength) {
    throw new Error(
      `caption for ${spec.key} is ${text.length} characters and cannot be cut to ` +
        `${spec.caption.maxLength} without losing the link`
    );
  }
  return text;
}

function capHashtags(text, max) {
  let seen = 0;
  return text.replace(/#[\w]+/g, (tag) => {
    seen += 1;
    return seen <= max ? tag : "";
  }).replace(/[ \t]{2,}/g, " ").replace(/ +\n/g, "\n").trim();
}

function truncateAtWord(text, limit) {
  if (text.length <= limit) return text;
  const room = limit - 1;
  const cut = text.slice(0, room);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > room * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/**
 * The stand-in writer. It follows the same fragment rules the prompt states,
 * so the output is shaped like what a model would return: the opening idea,
 * the link, and the platform's hashtag policy applied.
 */
function localWriter(_prompt, post, spec) {
  const sentences = splitSentences(post.body);
  const topics = post.topics || [];
  const tags = topics
    .slice(0, spec.caption.hashtagCount)
    .map((t) => `#${t.toLowerCase().replace(/[^a-z0-9]+/g, "")}`);

  if (spec.key === "x") {
    const opener = sentences[0] || post.title;
    return [trimTo(opener, 180), post.url, tags.join(" ")].filter(Boolean).join(" ");
  }

  const opening = sentences.slice(0, 2).join(" ");
  const middle = sentences.slice(2, 5).join(" ");
  const question = closingQuestion(post);

  return [opening, middle, question, post.url, tags.join(" ")]
    .filter((part) => part && part.trim())
    .join("\n\n");
}

function splitSentences(body) {
  return String(body || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function closingQuestion(post) {
  const topic = (post.topics && post.topics[0]) || "this";
  return `How does ${topic} behave in your own stack when it goes wrong?`;
}

function trimTo(text, limit) {
  return text.length <= limit ? text : truncateAtWord(text, limit);
}

module.exports = { captionFor, captionsFor, enforce, localWriter };

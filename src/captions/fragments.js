// Caption prompts, assembled from fragments rather than written twice.
//
// The failure this avoids is the one every social tool has: two prompts that
// are 90 percent the same, so a fix to the grounding rule lands in one of them
// and not the other, and nobody notices for a month. Everything true of every
// platform lives in SHARED and appears exactly once. A platform contributes
// only what makes it different from the others.
//
// There is a test that reads these strings and fails if a platform fragment
// duplicates a shared one, because the rule is worth nothing if it is only a
// convention.

const SHARED = {
  role:
    "You write social copy for an engineering blog. You have read the post. " +
    "You do not have access to anything else.",

  grounding:
    "Every claim in the caption must be supported by the post itself. " +
    "If a number is not in the post, it does not go in the caption. " +
    "Do not invent results, dates, names or endorsements.",

  antiHype:
    "No hype words: revolutionary, game-changing, unlock, supercharge, seamless, " +
    "leverage, delve. No exclamation marks. Say the thing plainly.",

  outputContract:
    "Return the caption text only. No preamble, no quotes around it, no markdown, " +
    "no explanation of your choices.",
};

const PER_PLATFORM = {
  instagram: {
    voice:
      "Warm and conversational. Open with the idea, not the link. " +
      "Two or three short paragraphs separated by a blank line.",
    hashtags:
      "End with up to 6 hashtags on their own final line, lowercase, " +
      "drawn from the post's own topics.",
    cta: "Close with a question the reader could actually answer from their own work.",
    length: "Aim for 600 to 900 characters. The hard limit is 2200.",
  },
  x: {
    voice: "Terse. One idea, one sentence, no throat clearing. Lower case is fine.",
    hashtags: "At most 2 hashtags, inline rather than stacked at the end.",
    cta: "No call to action. The link is the call to action.",
    length: "Hard limit 280 characters including the link. Aim for under 240.",
  },
};

/**
 * Build the prompt for one platform. Returns the fragments it used as well as
 * the text, so a caption can be traced back to the rules that produced it.
 */
function composePrompt(post, platformKey) {
  const specific = PER_PLATFORM[platformKey];
  if (!specific) {
    throw new Error(`no caption fragments for platform ${platformKey}`);
  }

  const used = [
    ["shared.role", SHARED.role],
    ["shared.grounding", SHARED.grounding],
    ["shared.antiHype", SHARED.antiHype],
    [`${platformKey}.voice`, specific.voice],
    [`${platformKey}.length`, specific.length],
    [`${platformKey}.hashtags`, specific.hashtags],
    [`${platformKey}.cta`, specific.cta],
    ["shared.outputContract", SHARED.outputContract],
  ];

  const system = used.map(([, text]) => text).join("\n\n");
  const user = [
    `Title: ${post.title}`,
    `URL: ${post.url}`,
    post.topics?.length ? `Topics: ${post.topics.join(", ")}` : null,
    "",
    post.body,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { system, user, fragments: used.map(([name]) => name) };
}

module.exports = { SHARED, PER_PLATFORM, composePrompt };

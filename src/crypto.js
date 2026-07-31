// Encryption for the one secret this service holds: the platform access token.
//
// AES-256-GCM with a fresh random IV per record, because a reused IV under the
// same key is the failure that turns GCM from safe into broken. The tag is
// stored alongside, so a modified ciphertext fails to decrypt rather than
// decrypting to something else.
//
// The stored form carries a version prefix. Rotating the key or the algorithm
// later means reading v1 and writing v2 rather than a migration that has to
// stop the world.

const crypto = require("crypto");

const VERSION = "v1";
const IV_BYTES = 12;

function keyFrom(secret) {
  if (!secret) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not set, refusing to store tokens in the clear");
  }
  // A passphrase is not a key. Hashing it to 32 bytes is the minimum honest
  // step; a real deployment would take the key from a KMS already at length.
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encrypt(plaintext, secret) {
  const key = keyFrom(secret);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

function decrypt(stored, secret) {
  const [version, iv, tag, ciphertext] = String(stored).split(":");
  if (version !== VERSION) {
    throw new Error(`cannot read token format ${version}, this build writes ${VERSION}`);
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Constant-time comparison for signatures. Comparing with === leaks how much
 * of a forged signature was right through how long the comparison took.
 */
function sameSignature(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { encrypt, decrypt, sameSignature };

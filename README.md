# social-media-studio

One published blog post to a multi-platform campaign: a sized image variant per
platform, a caption written for each platform's shape, published through one
adapter interface, scheduled by a durable worker, and marked published only
when the platform says so.

**FlyRank AI Internship, Backend AI Engineering capstone: Social Media Studio.**

Every publish in this repository goes to a sandbox platform that runs beside
the service. Nothing here has ever touched a real social account, and the
sandbox is not a mock: it refuses wrong image sizes, over-long captions,
missing idempotency keys and expired tokens, and it rate limits you.

## Run it

```bash
docker compose up --build
```

Four containers: Postgres, the studio API on 4000, the worker, and the sandbox
platform on 4010. Then:

```bash
curl -s -X POST localhost:4000/campaigns -H 'content-type: application/json' -d "{\"post\": $(cat fixtures/post.json), \"focus\": {\"x\": 0.62, \"y\": 0.3}}"
```

The campaign view is at [localhost:4000](http://localhost:4000). Tests need no
containers and no network:

```bash
npm test
```

## What it does

```
[blog post]
     │
     ├─► caption composer ──► shared fragments + per-platform fragments
     │                        limits enforced in code afterwards
     │
     └─► variant pipeline ──► crop to aspect, hold the subject in the safe zone
                              1080x1080 for instagram, 1600x900 for x
     │
     ▼
 POST /campaigns ──► rows in social_post_entries, one job per platform
                     (run_after = now, or the scheduled time)
     │
     ▼
  worker: claim one job  FOR UPDATE SKIP LOCKED
     │
     ▼
  SocialPublisher ──► InstagramPublisher: upload media, then post by id
       interface  └─► XPublisher:         post with the image inline
                      idempotency key · 429 honours Retry-After · token encrypted
     │
     ▼
  SANDBOX PLATFORM ──► signed delivery webhook ──► status: queued → published
                       HMAC verified over raw bytes                    └─► failed
```

The worker never writes `published`. It writes `accepted`, because at that
moment all it knows is that the platform took the post. Only the signed
callback moves an entry to `published`. Marking it published in the worker
would be recording an intention as a fact, and the delivery webhook exists
precisely because those two things differ.

## The five things that make it safe

**Idempotency.** The key is `<campaign>:<platform>`, derived from what is being
published rather than generated per attempt, and it is sent on every retry. So
a retry after a timeout, a reclaimed job, or a duplicate API call all produce
one post. Proven under a real crash below.

**Rate limits.** A 429 is not an error, it is the platform telling you the rate
at which it will accept work. `Retry-After` is honoured to the second rather
than replaced with a guess. A 5xx backs off exponentially with jitter. A 4xx
that is not 429 or 401 is permanent and is not retried at all, because sending
a rejected caption three more times annoys the platform and changes nothing.

**Tokens.** AES-256-GCM, a fresh random IV per record, an auth tag stored
alongside, and a `v1:` prefix so rotating the scheme later is a read path
rather than a migration. Two tests: the stored value never contains the
plaintext, and encrypting the same token twice never produces the same bytes.

**Webhooks.** Verified over the raw request bytes, never a re-serialised
object, because `JSON.parse` then `JSON.stringify` can reorder keys and break a
valid signature. Timing-safe comparison, a five minute replay window, and a
unique index on the signature so a replayed delivery is a no-op.

**Durability.** "Post at 9am" is a `run_after` column, not a timer in a
process. `FOR UPDATE SKIP LOCKED` lets several workers run without waiting on
each other, and a lease plus a reclaim sweep is what tells a slow job apart
from a dead one.

## Crash resume, for real

The interesting failure is not a worker that dies between jobs. It is a worker
that dies *during* one, after the platform created the post and before the
worker recorded the id. `scripts/crash-resume-demo.sh` opens that window on
purpose by slowing the platform to four seconds a post, then kills the worker
two seconds in:

```
while the worker was dying   instagram 1 post, x 0 posts

[13:15:40] crash-demo:x accepted as post_4307510ac7a9c64b on attempt 1
[13:15:47] reclaimed crash-demo:instagram from a worker that died holding it, attempt 1
[13:15:48] crash-demo:instagram accepted as post_954505320d9000c3
             (platform recognised the idempotency key, no second post) on attempt 2

after the worker resumed     instagram 1 post, x 1 post
```

One post per platform, across a crash mid publish. Full transcript in
[docs/crash-resume-transcript.txt](docs/crash-resume-transcript.txt).

## Scheduling, and the two transitions

A post scheduled 25 seconds out, polled every 5:

```
13:18:08  job queued  run_after 13:18:28   entry queued
13:18:23  job queued  run_after 13:18:28   entry queued
13:18:28  job done    run_after 13:18:28   entry accepted
13:18:34  job done    run_after 13:18:28   entry published
```

The worker polls twice a second and passes over the row four times, because
`claim()` filters on `run_after <= now()` and not on status alone. Then the
entry sits at `accepted` for six seconds before it becomes `published`, and
nothing the worker did moved it. The platform's signed callback did.
[docs/scheduling-transcript.txt](docs/scheduling-transcript.txt).

## Image variants

Each platform crops a different shape out of the same picture, so the subject
has to survive the crop and land somewhere the platform's own UI will not cover
with a caption or an avatar. That region is the safe zone.

| | |
|---|---|
| source, 1400x1900, subject at 0.62, 0.30 | ![source](docs/variant-source.png) |
| instagram, 1080x1080 | ![instagram](docs/variant-instagram.png) |
| x, 1600x900 | ![x](docs/variant-x.png) |

The crop window is the largest one of the target aspect that fits inside the
source, slid to centre the subject, then clamped to the source edges. Clamping
is why a variant can come back with a warning rather than a lie: past a certain
point you cannot both stay inside the picture and hold the subject in the safe
zone. A subject at 0.98, 0.03 reports landing at x=1568 against a safe zone
ending at 1472, and the caller decides what to do about it.

The brand bar sits in the margin the safe zone already reserves, so branding
never competes with the subject for the same pixels. There is a test that
extracts the safe zone from a plain and a branded variant and compares the raw
bytes.

**The studio's platform spec table is deliberately not imported from the
sandbox.** Sharing one constant would make the dimension test circular: it
would prove the studio agrees with itself. The studio encodes what it believes
the platform wants, the way a real integration encodes your reading of a
vendor's docs, and the integration test proves the belief by publishing.

## Captions

Everything true of every platform lives in `SHARED` and appears exactly once.
A platform contributes only what makes it different. The failure this avoids is
the one every social tool has: two prompts that are ninety percent the same, so
a fix to the grounding rule lands in one and not the other. Three tests enforce
it, because the rule is worth nothing if it is only a convention.

The writer is injectable. In production it is a model call taking the assembled
prompt; there is no model key in this environment, so the default composes
deterministically from the post's own sentences and the pipeline stays runnable
end to end.

Either way the limits are applied in code afterwards. A prompt asking for 280
characters is a request. A function that refuses to return 300 is a control,
and the platform enforces the same limit with a 422, so a caption that slips
through is a failed publish rather than a long caption.

Same post, two platforms:

```
instagram  686 chars, 6 hashtags, three paragraphs and a closing question
x          134 chars, 2 hashtags, one sentence and the link
```

## API

| | |
|---|---|
| `POST /campaigns` | validate, render variants, compose captions, queue one job per platform. 202 with a `Location` header |
| `GET /campaigns` | the list behind the campaign view |
| `GET /campaigns/:id` | entries and job state, including `attempts` and `last_error` |
| `GET /campaigns/:id/media/:platform` | the rendered variant |
| `POST /webhooks/platform` | signature verified over raw bytes, 400 on anything that does not verify |
| `GET /health` | job counts by status |

Validation is at the boundary and rejects with 422 and a list of problems, so a
bad `focus`, an unknown platform or a non-ISO `scheduled_at` fails in front of
whoever sent it rather than at 9am inside a worker.

## Tests

27, no containers, no network. The four the brief names as done, plus what
turned up while building:

```
dimensions per platform, and the subject inside every safe zone
a subject the crop cannot hold is reported, not silently mangled
the brand overlay changes no pixels inside the safe zone
no platform fragment repeats a shared one
every prompt carries the grounding rule exactly once
a writer that ignores the limit is still cut to it
publishing the same post twice yields one post on the platform
a real rate limit is waited out and the post still lands once
a 429 is waited out for exactly as long as the platform asked
a permanent refusal is not retried
a token the platform has forgotten is refreshed rather than failed
the stored token is ciphertext, and two encryptions of it differ
a forged webhook is rejected, and so are a tampered body, a stale
  timestamp, a missing signature and an unsupported scheme
```

Nothing is stubbed except the clock, and publishing runs against the sandbox
started inside the test process.

## Two things that went wrong

**The test that stopped time on one side.** The duplicate-publish test failed
first for a real reason. Publishing twice on Instagram is four writes and its
limiter allows three per ten seconds, so replacing the adapter's `sleep` meant
the adapter believed it had waited twenty seconds while the platform saw four
requests in an instant. The tempting fix is to loosen the limit. Instead the
sandbox grew a `_control/advance` that shifts its own window by the same
amount, so both sides share one clock. That turned the failure into a better
test: the limiter it now recovers from is the real one, not an injected 429.

**A 401 treated as permanent.** The crash-resume demo failed on its first run
with both jobs dead after zero retries. The platform container had restarted,
its tokens live in memory, and ours was in Postgres still looking unexpired, so
every request came back 401 and the adapter filed it under "the request was
wrong". A 401 is not a permanent refusal the first time you see it: tokens get
revoked, keys rotate, and a platform that restarts forgets what it issued. The
adapter now refreshes once and retries, and a second 401 means the credentials
really are wrong.

Neither of these was findable by reading the code. Both needed the thing to
actually run.

## Sandbox, and what it means for scope

The brief points at a provided starter, `starters/challenge-5-social/`, which
is not in my Resources list. `fake-platform/` is written to the behaviours the
brief names instead: OAuth, idempotency keys, rate limits with `Retry-After`,
and a signed delivery webhook. Writing it was more work than using a starter
and it made the studio better, because a strict sandbox rejects things a
permissive mock waves through.

Real posting is not implemented and is not going to be. At intern scale the
live APIs mean bans, leaked tokens and terms violations, and the brief says so
first.

## Limits

Named rather than discovered later.

- Two platforms. A third is a file in `src/publisher/` and a line in the
  registry, but nothing has proven that until a third exists.
- The default caption writer is deterministic, not a model. The fragment
  assembly is real and tested; the prose it produces is a stand-in.
- `_control/advance` and `_control/latency` on the sandbox exist for tests and
  the crash demo. A real platform gives you neither, which is why the crash
  window has to be opened on purpose rather than waited for.
- The campaign view polls nothing. It is a page you reload.
- Media lives on a shared volume. Object storage is the obvious next step and
  the entry already carries a path rather than the bytes.

## Layout

```
src/platforms.js          what the studio believes each platform wants
src/images.js             crop to aspect, hold the subject in the safe zone
src/captions/fragments.js shared and per-platform prompt fragments
src/captions/compose.js   the writer, and the limits enforced after it
src/publisher/            SocialPublisher, the HTTP layer, two adapters
src/crypto.js             AES-256-GCM token storage, timing-safe compare
src/jobs.js               claim, succeed, fail, reclaim
src/worker.js             the loop
src/webhooks.js           signature verification and the replay window
src/api.js                routes and validation
fake-platform/            the sandbox, deliberately strict
test/                     27 tests
scripts/crash-resume-demo.sh
```

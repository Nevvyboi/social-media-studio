#!/usr/bin/env bash
# Kill the worker in the middle of a publish and show that resuming does not
# double post.
#
# The window this needs is narrow: the platform has to have created the post
# but the worker has to die before it records the id. Latency on the platform
# opens that window on purpose, which is the only honest way to hit a race
# reliably rather than running the demo until it happens.
#
#   ./scripts/crash-resume-demo.sh

set -euo pipefail

STUDIO=http://localhost:4000
PLATFORM=http://localhost:4010
CAMPAIGN="crash-demo-$(date +%s)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1. Reset the platform and slow it to 4 seconds per post"
curl -s -X POST "$PLATFORM/_control/reset" > /dev/null
curl -s -X POST "$PLATFORM/_control/latency" -H 'content-type: application/json' -d '{"ms":4000}'
echo

say "2. Create a campaign, two platforms, two jobs"
curl -s -X POST "$STUDIO/campaigns" -H 'content-type: application/json' -d "{
  \"post\": {
    \"id\": \"$CAMPAIGN\",
    \"title\": \"A crawler that behaves itself\",
    \"url\": \"https://github.com/Nevvyboi/polite-scraper\",
    \"topics\": [\"scraping\", \"robots\", \"http\"],
    \"body\": \"It reads robots.txt before every URL and keeps the line that refused a page. It spaces requests by the host crawl-delay. It caches every response with its ETag, so the second run downloads 0.1 KB where the first downloaded 112.4 KB.\"
  },
  \"focus\": {\"x\": 0.62, \"y\": 0.3}
}" | node -pe "JSON.parse(require('fs').readFileSync(0)).entries.map(e=>'   queued '+e.job.key).join('\n')"

say "3. Wait 2 seconds, so a publish is in flight, then kill the worker"
sleep 2
docker compose kill worker
echo "   worker killed mid publish"

say "4. What the platform received while the worker was dying"
for p in instagram x; do
  printf '   %-10s %s post(s)\n' "$p" "$(curl -s "$PLATFORM/$p/posts" | node -pe 'JSON.parse(require("fs").readFileSync(0)).count')"
done

say "5. Speed the platform back up and restart the worker"
curl -s -X POST "$PLATFORM/_control/latency" -H 'content-type: application/json' -d '{"ms":0}' > /dev/null
docker compose start worker > /dev/null
echo "   worker restarted, waiting for the lease to expire and the job to be reclaimed"

for _ in $(seq 1 40); do
  finished=$(curl -s "$STUDIO/campaigns/$CAMPAIGN" | node -pe 'JSON.parse(require("fs").readFileSync(0)).jobs.filter(j=>j.status==="done").length' 2>/dev/null || echo 0)
  [ "$finished" = "2" ] && break
  sleep 1
done

say "6. Result"
curl -s "$STUDIO/campaigns/$CAMPAIGN" | node -pe "
const r = JSON.parse(require('fs').readFileSync(0));
r.entries.map(e => '   ' + e.platform.padEnd(10) + e.status.padEnd(12) + (e.platform_post_id || '-')).join('\n')
"
echo
for p in instagram x; do
  printf '   %-10s %s post(s) on the platform\n' "$p" "$(curl -s "$PLATFORM/$p/posts" | node -pe 'JSON.parse(require("fs").readFileSync(0)).count')"
done

say "The count is what matters. One post per platform, across a crash mid publish."
docker compose logs worker --since 2m --no-log-prefix | grep -E "reclaimed|accepted" || true

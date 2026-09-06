# Landing analytics consent

Cloudflare Web Analytics for `vayada.com` must use **Enable with JS Snippet
installation**, never automatic injection (including the non-EU option).
The public site token is a Landing Docker build argument wired in Deploy Landing.
An absent or invalid token leaves analytics off, including ordinary local builds.

Only a valid local `vayada_cookie_consent` with analytics=true loads the script.
Withdrawal stops subsequent Cloudflare RUM dispatch synchronously, even if saving
fails. A host-only necessary withdrawal cookie preserves rejection across reloads
when localStorage cannot be updated or removed; successful acceptance clears it.
If a browser blocks every form of persistence, only the current document can
retain a failed choice, and the UI reports that it could not save. Cross-tab withdrawal also seals already-open documents. Existing forms are
preserved. Accepting again after withdrawal starts fresh measurement on the next
full page load; an old beacon cannot replay activity from the withdrawn period.
Other origins and account consent are independent.

The reviewed 2026-09-06 beacon uses XHR and navigator.sendBeacon. Guards cover its
Cloudflare and same-origin `/cdn-cgi/rum` destinations only. SRI pins the reviewed
bytes. A vendor update fails closed instead of introducing an unguarded transport.
To update, download the official script, review all network transports, update
both implementation/test SHA-384 digests, and rerun the actual-beacon browser
suite. Do not merely replace the digest after a test failure.

PR Checks builds with a dummy public token and runs all Landing browser tests.
The analytics suite downloads the vendor script and verifies the pinned digest;
all measurement requests are intercepted and never reach Cloudflare. For local
runs, build with NEXT_PUBLIC_CLOUDFLARE_ANALYTICS_TOKEN set to 32 zeroes, start
Landing through portless, and run:

```sh
E2E_LANDING_BASE_URL=https://landing.localhost \
E2E_LANDING_ANALYTICS=1 npm run e2e:landing
```

`E2E_CLOUDFLARE_BEACON_FILE` can supply already-downloaded vendor bytes for offline
runs; the same digest verification still applies. Live rollout verification must
separately inspect actual requests before choice, after rejection, acceptance,
withdrawal, reload, and navigation, and confirm edge injection remains off.

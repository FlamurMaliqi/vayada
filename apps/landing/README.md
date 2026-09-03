# vayada-landing

The target-stack **marketing / landing site** for vayada (Next.js App Router).

Split out of `vayada-creator-marketplace-frontend` so the marketing surface and
the authenticated creator marketplace app evolve as independent projects. This
repo contains only public website pages — no authenticated app code.

## Pages

| Route                                                                               | Purpose                                   |
| ----------------------------------------------------------------------------------- | ----------------------------------------- |
| `/`                                                                                 | Home                                      |
| `/booking-engine`, `/pms`, `/hotel-creator-network`, `/partner-program`, `/pricing` | Product pages                             |
| `/about`, `/contact`, `/creator-benefits`, `/hotel-benefits`                        | Marketing                                 |
| `/imprint`, `/privacy`, `/terms`                                                    | Legal                                     |
| `/api/health`                                                                       | Health check (for the container platform) |

`/hotel-creator-network` pulls live creators/hotels from the marketplace
backend API, and `/contact` submits to the target platform intake route —
see `NEXT_PUBLIC_API_URL`.

The marketing chrome (`Navigation`, `Footer`, `LandingFooter`) is intentionally
duplicated in both repos because app pages (`/hotels/[id]`, `/creators`,
`/properties`) still use it.

## Develop

```bash
npm install
npm run dev      # http://localhost:3006
npm run build    # always run before declaring a change done
npm run lint
```

`NEXT_PUBLIC_API_URL` points the contact form and HCN data fetch at the public
API host. The current portless local default is the marketplace FastAPI API; use
`http://localhost:8003` only when testing a target `apps/api` cutover. See
`.env.example`.

## Deployment status

`Dockerfile` can build a Next.js `standalone` image, but this repository does
not currently contain an active workflow that publishes or deploys
`apps/landing`. Merging landing changes to `main` is not a production
deployment.

`vayada.com` belongs to the legacy system. Do not deploy this app to that
hostname or change its DNS or runtime. A target-stack hostname and an explicit,
reviewed deployment workflow must be established before this app is published.

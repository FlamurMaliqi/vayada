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

`/hotel-creator-network` pulls live creators/hotels from the TypeScript API via
`NEXT_PUBLIC_VAYADA_API_URL`. `/contact` submits to the public contact endpoint
via `NEXT_PUBLIC_API_URL`.

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

The two API variables stay separate: `NEXT_PUBLIC_API_URL` is the contact API,
while `NEXT_PUBLIC_VAYADA_API_URL` is the TypeScript marketplace discovery API.
See `.env.example` for local targets.

## Deploy

[`deploy-landing.yml`](../../.github/workflows/deploy-landing.yml) builds the
Next.js `standalone` image and pushes `latest` plus an immutable commit-SHA tag
to the `vayada-landing` ECR repository after landing changes merge to `main`.
The existing `vayada-landing` App Runner service watches `latest` and publishes
it at `vayada.com`.

`vayada.com` is the shared public landing surface. Deploying it does not change
the separate application or API hostnames. No DNS change is required for a
normal landing deployment.

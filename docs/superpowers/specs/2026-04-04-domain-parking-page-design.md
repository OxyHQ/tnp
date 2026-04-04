# TNP Domain Parking Page

## Context

When a user registers a TNP domain but hasn't configured DNS records or a service node, visiting that domain fails with NXDOMAIN. The DNS server returns an empty response and the browser can't connect to anything.

Real domain registrars (GoDaddy, Namecheap) solve this by serving a branded "parking page" — a simple page that shows the domain is registered and links to the registrar. TNP should do the same.

## How It Works

### DNS Layer

The TNP DNS server (`packages/client/src/proxy.ts` and `apps/dns-server/`) currently returns empty answers for domains without records. The change:

**When a domain exists and is active but has NO DNS records and NO service node**, return a default A record pointing to the TNP web server IP instead of an empty response.

Resolution logic (in `apps/api/src/routes/dns.ts`):

| Domain State | Current Behavior | New Behavior |
|---|---|---|
| Does not exist | NXDOMAIN | No change |
| Has DNS records | Return records | No change |
| Has service node | Overlay routing | No change |
| Active, no records, no service node | Empty response | **Return A record with parking IP** |

The parking IP is configured via environment variable `TNP_PARKING_IP` on the API server. The DNS resolution endpoint already knows the domain state — the change is just returning a fallback A record instead of empty answers.

### HTTP Redirect Layer

When the browser makes an HTTP request to the parking IP with a TNP domain as the Host header (e.g., `Host: example.ox`):

1. A catch-all handler detects the request is for a TNP domain (not `tnp.network`)
2. Returns a 302 redirect to `https://tnp.network/park/{host}`

This redirect is implemented as:
- A catch-all route in the Express API (`apps/api/`) that checks the Host header
- If the Host is a known TNP domain (matches `*.{activeTLD}` pattern), redirect to the SPA parking route

### React SPA Route

New page at `/park/:domain` in `apps/web/`:

**File**: `apps/web/src/pages/Park.tsx`

**Behavior**:
1. Extract domain from URL param
2. Fetch `GET /domains/lookup/:domain` from the API
3. If domain exists and has no records: render parking page
4. If domain has records: redirect to `/d/:domain` (it's configured, not parked)
5. If domain doesn't exist: show "domain not registered" message with link to register

**Content** (minimal, clean, TNP-branded):
- Domain name displayed prominently: `example.ox`
- Subtitle: "Registered on The Network Protocol"
- Two links:
  - "View domain details" → `/d/example.ox`
  - "What is TNP?" → `https://oxy.so/tnp`
- TNP branding and Oxy footer
- Follows existing page layout pattern (uses Layout component with nav/footer)

**SEO**: Helmet meta tags with domain name, `noindex` (parking pages shouldn't be indexed).

### i18n

New namespace `park` with translations in all 5 languages (en, zh, es, hi, fr):

```json
{
  "meta": {
    "title": "{{domain}} — TNP",
    "description": "{{domain}} is registered on The Network Protocol."
  },
  "registeredOn": "Registered on The Network Protocol",
  "viewDetails": "View domain details",
  "whatIsTnp": "What is TNP?",
  "notRegistered": "This domain is not registered on TNP.",
  "registerIt": "Register it now",
  "configured": "This domain is already configured."
}
```

~8 strings x 5 languages = 40 translated strings.

## Scope

### In Scope
- DNS fallback A record for unconfigured domains
- React parking page route (`/park/:domain`)
- HTTP redirect handler in the API for TNP domain Host headers
- i18n support (5 languages)
- Route added to `App.tsx`

### Out of Scope
- Custom parking page templates per user
- Ads or monetization on parking pages
- Domain marketplace / "for sale" functionality
- HTTPS certificate for TNP domains (would need wildcard certs per TLD)

## Files to Modify

- `apps/api/src/routes/dns.ts` — return fallback A record for unconfigured domains
- `apps/api/src/index.ts` (or routes) — add catch-all redirect for TNP domain Host headers
- `apps/web/src/App.tsx` — add `/park/:domain` route
- `apps/web/src/pages/Park.tsx` — new parking page component
- `apps/web/public/locales/{en,zh,es,hi,fr}/park.json` — new translation files (5 files)
- `apps/web/src/lib/i18n.ts` — add `park` to namespace list

## Verification

1. `cd apps/web && bun run build` — no TypeScript errors
2. `cd apps/api && bun run build` — no build errors
3. Visit `/park/example.ox` in dev — parking page renders with domain name
4. Visit `/park/nonexistent.ox` — shows "not registered" message
5. Verify i18n works — switch language, parking page text updates
6. Test DNS endpoint — `GET /dns/resolve?name=unhosted.ox&type=A` returns fallback A record
7. Test redirect — request to API with `Host: unhosted.ox` returns 302 to parking page

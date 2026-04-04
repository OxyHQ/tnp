# Domain Parking Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a branded TNP parking page when users visit a registered domain that hasn't been configured with DNS records or a service node.

**Architecture:** The DNS resolution endpoint returns a fallback A record (configurable IP) for unconfigured domains instead of empty answers. The API has a catch-all route that redirects TNP domain Host headers to the SPA. The SPA renders a minimal, i18n-aware parking page at `/park/:domain`.

**Tech Stack:** Express 5.2 (API), React 19 / React Router 7 / react-i18next (SPA), Tailwind CSS 4.2

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `apps/api/src/config.ts` | Add `parkingIp` config from env var |
| Modify | `apps/api/src/routes/dns.ts` | Return fallback A record for unconfigured domains |
| Modify | `apps/api/src/index.ts` | Add catch-all redirect for TNP domain Host headers |
| Create | `apps/web/src/pages/Park.tsx` | Parking page React component |
| Modify | `apps/web/src/App.tsx` | Add `/park/:domain` route |
| Modify | `apps/web/src/lib/i18n.ts` | Add `park` namespace |
| Create | `apps/web/public/locales/en/park.json` | English translations |
| Create | `apps/web/public/locales/zh/park.json` | Chinese translations |
| Create | `apps/web/public/locales/es/park.json` | Spanish translations |
| Create | `apps/web/public/locales/hi/park.json` | Hindi translations |
| Create | `apps/web/public/locales/fr/park.json` | French translations |

---

### Task 1: DNS fallback A record for unconfigured domains

**Files:**
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/routes/dns.ts`

- [ ] **Step 1: Add `parkingIp` to config**

In `apps/api/src/config.ts`, add the parking IP to the config object:

```typescript
export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017",
  dbName: `${APP_NAME}-${env}`,
  oxyApiUrl: process.env.OXY_API_URL || "https://api.oxy.so",
  parkingIp: process.env.TNP_PARKING_IP || "",
  corsOrigins: [
    "http://localhost:5173",
    "https://tnp.network",
    "https://www.tnp.network",
    "https://tnp-9uk.pages.dev",
  ],
};
```

- [ ] **Step 2: Modify DNS resolve endpoint to return fallback A record**

In `apps/api/src/routes/dns.ts`, after the `answers` array is built (line 68) and before the `response` object is created (line 70), add fallback logic. Replace the section from line 70 to line 83:

```typescript
    // If domain has no records and no service node, return parking page fallback
    if (answers.length === 0 && !domain.serviceNodeId && config.parkingIp) {
      if (qtype === "A" || qtype === "ANY") {
        answers.push({
          name: fqdn,
          type: "A",
          value: config.parkingIp,
          ttl: 300,
        });
      }
    }

    const response: Record<string, unknown> = { name: fqdn, type: qtype, answers };

    if (domain.serviceNodeId) {
      const serviceNode = await ServiceNode.findById(domain.serviceNodeId);
      if (serviceNode && serviceNode.status === "online") {
        response.overlay = {
          serviceNodePubKey: serviceNode.publicKey,
          relay: serviceNode.connectedRelay,
          available: true,
        };
      }
    }

    res.json(response);
```

Also add the config import at the top of the file:

```typescript
import { config } from "../config.js";
```

- [ ] **Step 3: Verify API builds**

Run: `cd /home/nate/tnp/apps/api && bun run build`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/config.ts apps/api/src/routes/dns.ts
git commit -m "feat: return fallback A record for unconfigured TNP domains"
```

---

### Task 2: Host-based redirect in API

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Add catch-all redirect after all routes**

In `apps/api/src/index.ts`, after all the `app.use()` route registrations (after line 51) and before the `start()` function, add:

```typescript
// Catch-all: if the Host header is a TNP domain (not the API itself),
// redirect to the parking page on the web frontend.
app.use((req, res, next) => {
  const host = req.hostname;
  if (!host || host === "localhost" || host.endsWith("tnp.network") || host.endsWith("oxy.so") || host.endsWith("pages.dev")) {
    return next();
  }
  // Check if host looks like a TNP domain (has at least one dot)
  if (host.includes(".")) {
    res.redirect(302, `https://tnp.network/park/${host}`);
    return;
  }
  next();
});
```

- [ ] **Step 2: Verify API builds**

Run: `cd /home/nate/tnp/apps/api && bun run build`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat: redirect TNP domain Host headers to parking page"
```

---

### Task 3: Create parking page translations

**Files:**
- Create: `apps/web/public/locales/en/park.json`
- Create: `apps/web/public/locales/zh/park.json`
- Create: `apps/web/public/locales/es/park.json`
- Create: `apps/web/public/locales/hi/park.json`
- Create: `apps/web/public/locales/fr/park.json`
- Modify: `apps/web/src/lib/i18n.ts`

- [ ] **Step 1: Add `park` namespace to i18n config**

In `apps/web/src/lib/i18n.ts`, add `"park"` to the `NAMESPACES` array:

```typescript
const NAMESPACES = [
  "common",
  "home",
  "explore",
  "register",
  "domains",
  "domainDetail",
  "dashboard",
  "serviceNodes",
  "network",
  "propose",
  "install",
  "park",
] as const;
```

- [ ] **Step 2: Create English translation file**

Create `apps/web/public/locales/en/park.json`:

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
  "configured": "This domain is already configured.",
  "goToDomain": "Go to domain details"
}
```

- [ ] **Step 3: Create Chinese translation file**

Create `apps/web/public/locales/zh/park.json`:

```json
{
  "meta": {
    "title": "{{domain}} — TNP",
    "description": "{{domain}} 已在 The Network Protocol 上注册。"
  },
  "registeredOn": "已在 The Network Protocol 上注册",
  "viewDetails": "查看域名详情",
  "whatIsTnp": "什么是 TNP？",
  "notRegistered": "此域名未在 TNP 上注册。",
  "registerIt": "立即注册",
  "configured": "此域名已配置。",
  "goToDomain": "前往域名详情"
}
```

- [ ] **Step 4: Create Spanish translation file**

Create `apps/web/public/locales/es/park.json`:

```json
{
  "meta": {
    "title": "{{domain}} — TNP",
    "description": "{{domain}} está registrado en The Network Protocol."
  },
  "registeredOn": "Registrado en The Network Protocol",
  "viewDetails": "Ver detalles del dominio",
  "whatIsTnp": "¿Qué es TNP?",
  "notRegistered": "Este dominio no está registrado en TNP.",
  "registerIt": "Regístralo ahora",
  "configured": "Este dominio ya está configurado.",
  "goToDomain": "Ir a detalles del dominio"
}
```

- [ ] **Step 5: Create Hindi translation file**

Create `apps/web/public/locales/hi/park.json`:

```json
{
  "meta": {
    "title": "{{domain}} — TNP",
    "description": "{{domain}} The Network Protocol पर पंजीकृत है।"
  },
  "registeredOn": "The Network Protocol पर पंजीकृत",
  "viewDetails": "डोमेन विवरण देखें",
  "whatIsTnp": "TNP क्या है?",
  "notRegistered": "यह डोमेन TNP पर पंजीकृत नहीं है।",
  "registerIt": "अभी पंजीकृत करें",
  "configured": "यह डोमेन पहले से कॉन्फ़िगर है।",
  "goToDomain": "डोमेन विवरण पर जाएं"
}
```

- [ ] **Step 6: Create French translation file**

Create `apps/web/public/locales/fr/park.json`:

```json
{
  "meta": {
    "title": "{{domain}} — TNP",
    "description": "{{domain}} est enregistré sur The Network Protocol."
  },
  "registeredOn": "Enregistré sur The Network Protocol",
  "viewDetails": "Voir les détails du domaine",
  "whatIsTnp": "Qu'est-ce que TNP ?",
  "notRegistered": "Ce domaine n'est pas enregistré sur TNP.",
  "registerIt": "L'enregistrer maintenant",
  "configured": "Ce domaine est déjà configuré.",
  "goToDomain": "Aller aux détails du domaine"
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/i18n.ts apps/web/public/locales/*/park.json
git commit -m "feat: add parking page translations for 5 languages"
```

---

### Task 4: Create Park page component and route

**Files:**
- Create: `apps/web/src/pages/Park.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Create the Park page component**

Create `apps/web/src/pages/Park.tsx`:

```tsx
import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useParams, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../lib/api";

interface DomainData {
  _id: string;
  name: string;
  tld: string;
  status: string;
  records: { _id: string }[];
}

type ParkState = "loading" | "parked" | "configured" | "not-found";

export default function Park() {
  const { domain: domainParam } = useParams<{ domain: string }>();
  const { t } = useTranslation("park");
  const [state, setState] = useState<ParkState>("loading");
  const [domainName, setDomainName] = useState("");

  useEffect(() => {
    if (!domainParam) return;
    setDomainName(domainParam);
    let ignore = false;
    apiFetch<DomainData>(`/domains/lookup/${domainParam}`)
      .then((data) => {
        if (ignore) return;
        if (data.records.length > 0) {
          setState("configured");
        } else {
          setState("parked");
        }
      })
      .catch(() => {
        if (!ignore) setState("not-found");
      });
    return () => { ignore = true; };
  }, [domainParam]);

  if (state === "configured") {
    return <Navigate to={`/d/${domainParam}`} replace />;
  }

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      <Helmet>
        <title>{t("meta.title", { domain: domainName })}</title>
        <meta name="description" content={t("meta.description", { domain: domainName })} />
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      {state === "loading" && (
        <div className="font-mono text-sm text-muted">...</div>
      )}

      {state === "parked" && (
        <>
          <h1 className="mb-4 font-pixel text-3xl text-accent sm:text-4xl">
            {domainName}
          </h1>
          <p className="mb-8 font-mono text-sm text-secondary">
            {t("registeredOn")}
          </p>
          <div className="flex flex-col items-center gap-3">
            <Link
              to={`/d/${domainParam}`}
              className="font-mono text-sm text-accent transition-colors hover:text-primary"
            >
              [{t("viewDetails")}]
            </Link>
            <a
              href="https://oxy.so/tnp"
              className="font-mono text-sm text-muted transition-colors hover:text-secondary"
            >
              [{t("whatIsTnp")}]
            </a>
          </div>
        </>
      )}

      {state === "not-found" && (
        <>
          <h1 className="mb-4 font-pixel text-xl text-muted">
            {domainName}
          </h1>
          <p className="mb-6 font-mono text-sm text-muted">
            {t("notRegistered")}
          </p>
          <Link
            to="/register"
            className="font-mono text-sm text-accent transition-colors hover:text-primary"
          >
            [{t("registerIt")}]
          </Link>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the route to App.tsx**

In `apps/web/src/App.tsx`, add the import and route. Add this import with the other page imports:

```typescript
import Park from "./pages/Park";
```

Add the route inside the `<Route element={<Layout />}>` group, after the Install route:

```tsx
<Route path="/park/:domain" element={<Park />} />
```

- [ ] **Step 3: Verify web app builds**

Run: `cd /home/nate/tnp/apps/web && bun run build`
Expected: No TypeScript errors, successful build.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/Park.tsx apps/web/src/App.tsx
git commit -m "feat: add domain parking page with i18n support"
```

---

### Task 5: Final verification

- [ ] **Step 1: Build both API and web**

Run: `cd /home/nate/tnp/apps/api && bun run build && cd /home/nate/tnp/apps/web && bun run build`
Expected: Both build with zero errors.

- [ ] **Step 2: Verify file count**

Run: `ls apps/web/public/locales/*/park.json | wc -l`
Expected: 5

- [ ] **Step 3: Verify route exists in App.tsx**

Run: `grep -n "park" apps/web/src/App.tsx`
Expected: Shows the import and route for Park.

- [ ] **Step 4: Push**

```bash
git push
```

# TNP Web App — i18n & Multilanguage Support

## Context

TNP's web app has ~400-500 hardcoded English strings across 10+ pages. To reach a global audience, we're adding full multilanguage support for the 5 most spoken languages: English, Chinese (Simplified), Spanish, Hindi, and French.

## Languages

| Code | Language | Script |
|------|----------|--------|
| `en` | English | Latin |
| `zh` | Chinese (Simplified) | Han |
| `es` | Spanish | Latin |
| `hi` | Hindi | Devanagari |
| `fr` | French | Latin |

No RTL languages — no bidirectional layout work needed.

## Library Stack

- `i18next` — core i18n framework
- `react-i18next` — React bindings (`useTranslation` hook, `I18nextProvider`)
- `i18next-browser-languagedetector` — auto-detect browser language
- `i18next-http-backend` — lazy-load translation JSON files at runtime

## Architecture

### i18n Initialization (`apps/web/src/lib/i18n.ts`)

- Supported languages: `en`, `zh`, `es`, `hi`, `fr`
- Default/fallback: `en`
- Detection order: `localStorage` -> `navigator` -> `htmlTag`
- Backend loads from `/locales/{lng}/{ns}.json`
- React Suspense handles loading state

### Provider Setup (`main.tsx`)

Wrap the app with i18next initialization. Use `Suspense` to show a loading state while translation files are fetched.

### Translation File Structure

```
apps/web/public/locales/
  en/
    common.json       # Nav, footer, shared buttons, status labels
    home.json         # Home page strings
    explore.json      # Explore page
    register.json     # Register page
    domains.json      # Domains listing + DomainDetail page
    dashboard.json    # Dashboard page
    serviceNodes.json # Service Nodes page
    network.json      # Network Status page
    propose.json      # Propose TLD page
    install.json      # Install/setup page (largest — platform-specific instructions)
  zh/ ... (same structure)
  es/ ...
  hi/ ...
  fr/ ...
```

Namespaces split by page. Only the active language + current page namespace are loaded at any time.

### Language Picker

A dropdown in the Layout header (right side, near auth buttons) showing language names in native script:
- English
- 中文
- Español
- हिन्दी
- Français

Selection persists to `localStorage` via the browser language detector plugin.

## Component Integration

### useTranslation Hook

Each page imports its namespace:

```tsx
const { t } = useTranslation("explore");
<h1>{t("title")}</h1>
```

Shared strings (nav, footer, buttons) use the `common` namespace:

```tsx
const { t } = useTranslation("common");
```

### Interpolation

Dynamic values passed as parameters:

```tsx
t("domainAvailable", { domain: "mysite.ox" })
// "{{domain}} is available"
```

### Pluralization

i18next handles plural forms per language:

```tsx
t("recordCount", { count: 3 })
// en: "3 records" (singular: "1 record")
```

### Helmet / SEO Metadata

Page titles and meta descriptions use `t()`:

```tsx
<Helmet>
  <title>{t("meta.title")} — TNP</title>
  <meta name="description" content={t("meta.description")} />
</Helmet>
```

The `<html lang>` attribute is set to the active language via i18next's `htmlTag` detection.

### Date & Time Formatting

Replace hardcoded `toLocaleDateString("en-US")` with locale-aware formatting:

```tsx
new Date(date).toLocaleDateString(i18n.language, { year: "numeric", month: "short", day: "numeric" })
```

Relative time display (ServiceNodes) uses `Intl.RelativeTimeFormat` with the active locale.

### API Error Handling

API errors stay in English on the server. The frontend maps known error patterns to translation keys via a lookup object. Unknown errors fall back to the raw English message.

```tsx
// lib/errorMessages.ts
const errorKeyMap: Record<string, string> = {
  "Domain not found": "errors.domainNotFound",
  "Format must be name.tld": "errors.invalidFormat",
  // ...
};
```

## Translation Content

All 5 languages will have complete translations generated during implementation. English is the source of truth; other languages are AI-generated as a quality v1 baseline.

## Scope

### In Scope
- All web app UI strings (pages, components, layout)
- Page titles and SEO metadata
- Date and time formatting
- Language detection and manual switching
- Lazy-loaded translation files

### Out of Scope
- API server-side translations (errors stay in English)
- URL-based language routing (`/es/explore`)
- Client CLI translations
- DNS server translations

## Files to Modify

- `apps/web/package.json` — add i18n dependencies
- `apps/web/src/lib/i18n.ts` — new: i18next configuration
- `apps/web/src/main.tsx` — wrap with Suspense for i18n loading
- `apps/web/src/components/Layout.tsx` — add language picker, translate nav/footer
- `apps/web/src/components/LanguagePicker.tsx` — new: language selector dropdown
- `apps/web/src/pages/*.tsx` — all 10 pages: replace hardcoded strings with `t()` calls
- `apps/web/src/components/RecordEditor.tsx` — translate labels/placeholders
- `apps/web/src/components/CodeBlock.tsx` — translate "Copy"/"Copied"
- `apps/web/src/lib/errorMessages.ts` — new: error string to i18n key mapping
- `apps/web/public/locales/{en,zh,es,hi,fr}/*.json` — new: 10 namespace files x 5 languages = 50 translation files

## Verification

1. `cd apps/web && bun run build` — ensure no TypeScript or build errors
2. `bun run dev:web` — verify the app loads with English by default
3. Switch language via picker — verify UI updates to each of the 5 languages
4. Check that page titles (Helmet) update with language changes
5. Verify date formatting respects locale
6. Verify lazy loading — only the current namespace is fetched (check Network tab)
7. Verify localStorage persistence — refresh page, language should persist
8. Verify fallback — set browser to unsupported language, should fall back to English

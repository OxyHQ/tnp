import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import HttpBackend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";

const SUPPORTED_LANGUAGES = ["en", "zh", "es", "hi", "fr"] as const;

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

i18n
  .use(HttpBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    supportedLngs: SUPPORTED_LANGUAGES,
    fallbackLng: "en",
    defaultNS: "common",
    ns: [...NAMESPACES],

    backend: {
      loadPath: "/locales/{{lng}}/{{ns}}.json",
    },

    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "tnp-lang",
      caches: ["localStorage"],
    },

    interpolation: {
      escapeValue: false,
    },

    react: {
      useSuspense: true,
    },
  });

export default i18n;

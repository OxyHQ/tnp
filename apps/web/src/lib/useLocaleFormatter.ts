import { useTranslation } from "react-i18next";
import { useMemo } from "react";

const DEFAULT_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

const RELATIVE_TIME_UNITS: ReadonlyArray<{
  unit: Intl.RelativeTimeFormatUnit;
  seconds: number;
}> = [
  { unit: "year", seconds: 60 * 60 * 24 * 365 },
  { unit: "month", seconds: 60 * 60 * 24 * 30 },
  { unit: "week", seconds: 60 * 60 * 24 * 7 },
  { unit: "day", seconds: 60 * 60 * 24 },
  { unit: "hour", seconds: 60 * 60 },
  { unit: "minute", seconds: 60 },
  { unit: "second", seconds: 1 },
];

interface LocaleFormatter {
  formatDate: (
    date: string | Date,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatRelativeTime: (date: string | Date) => string;
}

export function useLocaleFormatter(): LocaleFormatter {
  const { i18n } = useTranslation();
  const language = i18n.language;

  return useMemo(() => {
    const formatDate = (
      date: string | Date,
      options?: Intl.DateTimeFormatOptions,
    ): string => {
      const d = typeof date === "string" ? new Date(date) : date;
      const formatter = new Intl.DateTimeFormat(
        language,
        options ?? DEFAULT_DATE_OPTIONS,
      );
      return formatter.format(d);
    };

    const formatRelativeTime = (date: string | Date): string => {
      const d = typeof date === "string" ? new Date(date) : date;
      const diffSeconds = Math.round((d.getTime() - Date.now()) / 1000);
      const formatter = new Intl.RelativeTimeFormat(language, {
        numeric: "auto",
      });

      for (const { unit, seconds } of RELATIVE_TIME_UNITS) {
        if (Math.abs(diffSeconds) >= seconds) {
          const value = Math.round(diffSeconds / seconds);
          return formatter.format(value, unit);
        }
      }

      return formatter.format(0, "second");
    };

    return { formatDate, formatRelativeTime };
  }, [language]);
}

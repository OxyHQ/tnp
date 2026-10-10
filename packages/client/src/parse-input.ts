/**
 * Strict parsing for numbers and targets typed by the user.
 *
 * `parseInt` reads a leading number and drops the rest, so `8O80` (a letter O)
 * became port 8 and `3000abc` became 3000, and both passed validation.
 * Everything here accepts only the whole string.
 */

/** A non-negative decimal integer written only with digits, or `null`. */
export function parseDecimalInt(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/** A TCP/UDP port (1-65535), or `null`. */
export function parsePort(text: string): number | null {
  const n = parseDecimalInt(text);
  return n !== null && n >= 1 && n <= 65535 ? n : null;
}

export interface LocalTarget {
  /** Host as `net.createConnection` expects it (IPv6 without brackets). */
  host: string;
  port: number;
}

const DEFAULT_TARGET_PORT = 80;

/**
 * Parse a service node's local target: `host`, `host:port`, `[v6]` or
 * `[v6]:port`. A missing port means 80. A port that is present but invalid
 * throws instead of quietly turning into 80, because that would forward the
 * domain's public traffic to a different local service than the one named.
 */
export function parseLocalTarget(target: string): LocalTarget {
  const value = target.trim();
  if (value === '') throw new Error('Local target is empty');

  let host: string;
  let portText: string | undefined;

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) throw new Error(`Invalid local target "${target}": missing "]"`);
    host = value.slice(1, close);
    const rest = value.slice(close + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) {
        throw new Error(`Invalid local target "${target}": expected ":port" after "]"`);
      }
      portText = rest.slice(1);
    }
  } else {
    const colons = value.split(':').length - 1;
    if (colons > 1) {
      throw new Error(
        `Invalid local target "${target}": write IPv6 addresses in brackets, e.g. [::1]:8080`,
      );
    }
    if (colons === 1) {
      const colon = value.indexOf(':');
      host = value.slice(0, colon);
      portText = value.slice(colon + 1);
    } else {
      host = value;
    }
  }

  if (host === '') throw new Error(`Invalid local target "${target}": missing host`);
  if (portText === undefined) return { host, port: DEFAULT_TARGET_PORT };

  const port = parsePort(portText);
  if (port === null) {
    throw new Error(`Invalid local target "${target}": port must be 1-65535`);
  }
  return { host, port };
}

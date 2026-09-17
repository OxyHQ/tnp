/**
 * Secret references.
 *
 * `provider_accounts.secret_ref` holds a pointer, never a secret. The only
 * scheme today is `env:NAME`: ECS injects the value from the secret manager as
 * an environment variable (provisioned in `oxy-infra`), and the process reads
 * it at the moment an adapter is built. A scheme this resolver does not know
 * is a configuration error, not a fallback to something else.
 */

import { ProviderError } from "./errors.js";

export interface SecretResolver {
  /** The secret's value. Throws `ProviderError("credentials")` when absent. */
  resolve(ref: string): string;
}

const ENV_REF_RE = /^env:([A-Z][A-Z0-9_]*)$/;

export function createEnvSecretResolver(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretResolver {
  return {
    resolve(ref) {
      const match = ENV_REF_RE.exec(ref);
      if (!match) {
        throw new ProviderError("credentials", `unsupported secret reference scheme in ${JSON.stringify(ref.split(":")[0])}`);
      }
      const value = env[match[1]];
      if (!value) {
        throw new ProviderError("credentials", `secret ${match[1]} is not set`);
      }
      return value;
    },
  };
}

/**
 * Replace every occurrence of each secret in `text`.
 *
 * Adapters run their request URLs and provider responses through this before
 * anything reaches a log, an error message or a stored result. Values shorter
 * than 4 characters are skipped: redacting "1" would mangle the text without
 * protecting anything.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("[REDACTED]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join("[REDACTED]");
  }
  return out;
}

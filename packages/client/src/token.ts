/**
 * Where an Oxy bearer token comes from.
 *
 * `--token <value>` puts the token in the process list (`/proc/<pid>/cmdline`
 * is readable by every local user) and in shell history, which on a seized or
 * shared machine is a credential handed over. The supported sources are the
 * `TNP_TOKEN` environment variable and `--token-stdin`; the flag still works
 * for compatibility but warns every time.
 */

export type TokenSource = 'stdin' | 'env' | 'flag';

export type TokenResult =
  | { ok: true; token: string; source: TokenSource; warning?: string }
  | { ok: true; token: null }
  | { ok: false; error: string };

export const TOKEN_FLAG_DEPRECATION =
  '--token is deprecated: it exposes the token to every local user through the process list and is saved in shell history. Use TNP_TOKEN=<token> or pipe it to --token-stdin instead.';

export interface TokenInputs {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  readStdin: () => Promise<string>;
}

/** Precedence: `--token-stdin`, then `TNP_TOKEN`, then the deprecated `--token`. */
export async function resolveToken({ argv, env, readStdin }: TokenInputs): Promise<TokenResult> {
  if (argv.includes('--token-stdin')) {
    const token = (await readStdin()).trim();
    if (!token) return { ok: false, error: '--token-stdin was given but stdin was empty' };
    if (/\s/.test(token)) {
      return { ok: false, error: '--token-stdin: expected a single token on stdin' };
    }
    return { ok: true, token, source: 'stdin' };
  }

  const fromEnv = env.TNP_TOKEN?.trim();
  if (fromEnv) return { ok: true, token: fromEnv, source: 'env' };

  const idx = argv.indexOf('--token');
  if (idx !== -1) {
    const value = argv[idx + 1];
    if (!value || value.startsWith('--')) return { ok: false, error: '--token needs a value' };
    return { ok: true, token: value, source: 'flag', warning: TOKEN_FLAG_DEPRECATION };
  }

  return { ok: true, token: null };
}

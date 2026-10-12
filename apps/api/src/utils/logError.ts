/**
 * Error logging that does not copy request data into the logs.
 *
 * `console.error(err)` on a failed query prints drizzle's `DrizzleQueryError`,
 * whose message is the SQL followed by `params: …` — the names people looked
 * up, Oxy user ids, record values — and the PostgreSQL error underneath can
 * carry a `detail` like `Key (name)=(…) already exists` or a message quoting
 * the offending input. All of it lands in CloudWatch, retained, for anyone
 * with log access or a log subpoena.
 *
 * In production only the shape of the failure is logged: the error's class,
 * its SQLSTATE and constraint when it is a database error, a message with any
 * parameter list cut off when it is not, and the stack frames without the
 * message line. Outside production the full error is printed, because a
 * developer's terminal is where the detail is wanted.
 */

const MAX_MESSAGE = 200;
const MAX_FRAMES = 8;

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  constraint_name?: unknown;
  stack?: unknown;
  cause?: unknown;
}

function asErrorLike(value: unknown): ErrorLike | null {
  return typeof value === 'object' && value !== null ? (value as ErrorLike) : null;
}

/** A SQLSTATE: five characters of digits and capitals. */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

function sqlState(err: ErrorLike | null): string | null {
  for (let current = err, depth = 0; current && depth < 4; depth++) {
    if (typeof current.code === 'string' && SQLSTATE_RE.test(current.code)) return current.code;
    current = asErrorLike(current.cause);
  }
  return null;
}

function constraint(err: ErrorLike | null): string | null {
  for (let current = err, depth = 0; current && depth < 4; depth++) {
    if (typeof current.constraint_name === 'string') return current.constraint_name;
    current = asErrorLike(current.cause);
  }
  return null;
}

/** The message with anything after a `params:` marker removed, and capped. */
function safeMessage(message: string): string {
  const cut = message.search(/\bparams:/i);
  const kept = (cut === -1 ? message : message.slice(0, cut)).trim();
  return kept.length > MAX_MESSAGE ? `${kept.slice(0, MAX_MESSAGE)}…` : kept;
}

function frames(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  return stack
    .split('\n')
    .filter((line) => line.trimStart().startsWith('at '))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim());
}

/** A log line describing `err` that carries no query parameters or row values. */
export function redactError(err: unknown): Record<string, unknown> {
  const e = asErrorLike(err);
  const name = typeof e?.name === 'string' ? e.name : typeof err;
  const code = sqlState(e);
  if (code !== null) {
    // A database error: the SQLSTATE and constraint say what failed. Its
    // message and detail are where PostgreSQL quotes the data, so neither is
    // kept — and neither is the drizzle wrapper's, which is the SQL plus params.
    return { name, sqlState: code, constraint: constraint(e), stack: frames(e?.stack) };
  }
  // A system error code such as ECONNREFUSED says which dependency failed and
  // nothing about the request.
  const systemCode =
    typeof e?.code === 'string' && /^E[A-Z_]{2,30}$/.test(e.code) ? e.code : undefined;
  return {
    name,
    code: systemCode,
    message: typeof e?.message === 'string' ? safeMessage(e.message) : undefined,
    stack: frames(e?.stack),
  };
}

export function logError(
  context: string,
  err: unknown,
  production = process.env.NODE_ENV === 'production',
): void {
  if (production) {
    console.error(context, JSON.stringify(redactError(err)));
  } else {
    console.error(context, err);
  }
}

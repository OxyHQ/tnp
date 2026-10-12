import { describe, expect, spyOn, test } from 'bun:test';
import { logError, redactError } from './logError.js';

/** The shape drizzle 0.45 throws for a failed query: SQL and params in the message, the server error as `cause`. */
function drizzleQueryError(): Error {
  const cause = Object.assign(new Error('invalid input syntax for type uuid: "secret-name"'), {
    name: 'PostgresError',
    code: '22P02',
    detail: 'Key (name)=(secret-name) already exists.',
  });
  const err = new Error(
    'Failed query: select "id" from "domains" where "name" = $1 and "oxy_user_id" = $2\nparams: secret-name,oxy-user-123',
    { cause },
  );
  err.name = 'DrizzleQueryError';
  return err;
}

describe('redactError', () => {
  test('a database error keeps its class and SQLSTATE and loses every parameter', () => {
    const redacted = redactError(drizzleQueryError());
    expect(redacted.name).toBe('DrizzleQueryError');
    expect(redacted.sqlState).toBe('22P02');
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('secret-name');
    expect(text).not.toContain('oxy-user-123');
    expect(text).not.toContain('params');
  });

  test('a non-database error keeps its message up to any params marker', () => {
    const err = Object.assign(new Error('connect failed params: host-with-user-data'), {
      code: 'ECONNREFUSED',
    });
    const redacted = redactError(err);
    expect(redacted.message).toBe('connect failed');
    expect(redacted.code).toBe('ECONNREFUSED');
  });

  test('keeps stack frames but not the message line at their head', () => {
    const redacted = redactError(drizzleQueryError());
    const stack = redacted.stack as string[];
    expect(stack.length).toBeGreaterThan(0);
    expect(stack.every((frame) => frame.startsWith('at '))).toBe(true);
  });

  test('copes with values that are not errors', () => {
    expect(redactError('boom')).toMatchObject({ name: 'string' });
    expect(redactError(null)).toMatchObject({ name: 'object' });
  });
});

describe('logError', () => {
  test('in production, logs only the redacted form', () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      logError('Lookup error:', drizzleQueryError(), true);
      const line = logged.mock.calls.flat().map(String).join(' ');
      expect(line).toContain('Lookup error:');
      expect(line).toContain('22P02');
      expect(line).not.toContain('secret-name');
      expect(line).not.toContain('oxy-user-123');
    } finally {
      logged.mockRestore();
    }
  });

  test('outside production, logs the full error for the developer', () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const err = drizzleQueryError();
      logError('Lookup error:', err, false);
      expect(logged.mock.calls[0]?.[1]).toBe(err);
    } finally {
      logged.mockRestore();
    }
  });
});

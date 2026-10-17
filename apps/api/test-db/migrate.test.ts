import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/db/migrate.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

let t: TestDatabase;
let folder: string;

beforeAll(async () => {
  t = await createTestDatabase();
  folder = mkdtempSync(join(tmpdir(), 'tnp-migrate-'));
  const files = [
    { tag: '9000_cold', when: 9_000_000_000_000, sql: 'create table lock_cold (id int);' },
    {
      tag: '9001_hot',
      when: 9_000_000_001_000,
      sql: 'alter table users add column lock_note text;',
    },
  ];
  mkdirSync(join(folder, 'meta'));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: files.map(({ tag, when }, idx) => ({ idx, tag, when, breakpoints: true })),
    }),
  );
  for (const file of files) writeFileSync(join(folder, `${file.tag}.sql`), file.sql);
});

afterAll(async () => {
  rmSync(folder, { recursive: true, force: true });
  await t.drop();
});

test('each migration commits on its own, and one whose lock is held is retried', async () => {
  // A reader holds ACCESS SHARE on the table 9001 alters, past lock_timeout.
  const reserved = await t.sql.reserve();
  await reserved`begin`;
  await reserved`lock table users in access share mode`;
  const released = new Promise((resolve) => setTimeout(resolve, 600)).then(async () => {
    const rows = await t.sql<{ created_at: string }[]>`
      select created_at::text from drizzle.__drizzle_migrations where created_at >= 9000000000000`;
    // 9000 committed on its own while 9001 waited.
    expect(rows.map((row) => row.created_at)).toEqual(['9000000000000']);
    await reserved`rollback`;
    reserved.release();
  });

  const logs: string[] = [];
  const applied = await runMigrations(t.url, {
    migrationsFolder: folder,
    lockTimeoutMs: 200,
    log: (line) => logs.push(line),
  });
  await released;

  expect(applied).toEqual(['9000_cold', '9001_hot']);
  expect(logs.some((line) => line.startsWith('9001_hot: lock not available'))).toBe(true);
});

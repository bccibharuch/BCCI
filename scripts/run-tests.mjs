#!/usr/bin/env node
// Runs every suite in its own process and prints one line per suite.
//
// A serial `&&` chain stopped at the first failure and hid every later
// result. This always runs the whole list, and shows SKIP for a Postgres
// path that found no database instead of counting it as a pass.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SUITES = [
  { name: 'e2e', file: 'tests/e2e.test.mjs' },
  { name: 'api', file: 'tests/api.test.mjs' },
  { name: 'data', file: 'tests/data.test.mjs' },
  { name: 'client', file: 'tests/client.test.mjs' },
  { name: 'smtp-config', file: 'tests/smtp-config.test.mjs' },
  { name: 'purge', file: 'tests/purge.test.mjs' },
  { name: 'applicant-auth', file: 'tests/applicant-auth.test.mjs' },
  { name: 'events-redis', file: 'tests/events-redis.test.mjs' },
  { name: 'events-api', file: 'tests/events-api.test.mjs' },
  { name: 'postgres', file: 'tests/postgres.test.mjs' },
  { name: 'e2e (postgres)', file: 'tests/e2e.test.mjs', env: { E2E_BACKEND: 'postgres' } },
  { name: 'board', file: 'tests/board.test.mjs' },
  { name: 'board (postgres)', file: 'tests/board.test.mjs', env: { BOARD_BACKEND: 'postgres' } },
];

/** "168 passed", or "" when the suite reports no tally we recognise. */
function tally(output) {
  const counted = output.match(/(\d+) passed, (\d+) failed/);
  if (counted) return `${counted[1]} passed${Number(counted[2]) ? `, ${counted[2]} failed` : ''}`;
  const nodeTest = output.match(/^\s*ℹ\s*pass\s+(\d+)/m);
  if (nodeTest) {
    const failed = output.match(/^\s*ℹ\s*fail\s+(\d+)/m);
    return `${nodeTest[1]} passed${failed && Number(failed[1]) ? `, ${failed[1]} failed` : ''}`;
  }
  return '';
}

const results = [];

for (const suite of SUITES) {
  const started = Date.now();
  const child = spawnSync(process.execPath, [suite.file], {
    cwd: ROOT,
    env: { ...process.env, ...suite.env },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const elapsed = `${Date.now() - started}ms`;
  const output = `${child.stdout || ''}${child.stderr || ''}`;

  let status = 'PASS';
  let detail = tally(output);
  if (child.error || child.status !== 0) {
    status = 'FAIL';
    detail = `exit ${child.status ?? 'error'}`;
  } else if (/^\s*SKIP\b/m.test(output)) {
    status = 'SKIP';
    detail = 'no database';
  }

  results.push({ name: suite.name, status, output });
  console.log(`${status.padEnd(4)}  ${suite.name.padEnd(17)} ${detail.padEnd(14)} ${elapsed}`);
}

for (const result of results) {
  if (result.status !== 'FAIL') continue;
  console.log(`\n───── ${result.name} failed ─────`);
  console.log(result.output.trimEnd());
}

const passed = results.filter((r) => r.status === 'PASS').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
const failed = results.filter((r) => r.status === 'FAIL').length;

console.log('');
console.log(`${results.length} suites: ${passed} passed, ${skipped} skipped, ${failed} failed`);
if (failed) process.exit(1);

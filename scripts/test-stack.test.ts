import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bounded,
  cleanupTestResources,
  removeTestDir,
  testComposeArgs,
} from './test-stack';

test('temporary directory cleanup is idempotent and refuses unrelated paths', async () => {
  const owned = mkdtempSync(join(tmpdir(), 'kinan-integration-'));
  writeFileSync(join(owned, 'fixture'), 'test');
  await removeTestDir(owned);
  await removeTestDir(owned);
  const unrelated = mkdtempSync(join(tmpdir(), 'not-kinan-'));
  try {
    await expect(removeTestDir(unrelated)).rejects.toThrow('Refusing cleanup');
  } finally {
    rmSync(unrelated, { recursive: true, force: true });
  }
});

test('test Compose commands are scoped and reject non-test projects', () => {
  const args = testComposeArgs('kinan-test-123-abc', ['down', '--volumes']);
  expect(args.slice(0, 6)).toEqual([
    'docker',
    'compose',
    '--env-file',
    '/dev/null',
    '-p',
    'kinan-test-123-abc',
  ]);
  expect(args.slice(-2)).toEqual(['down', '--volumes']);
  for (const name of ['kinan_works', 'kinan-vps', '', 'kinan-test-../main'])
    expect(() => testComposeArgs(name, ['down'])).toThrow();
});

test('shutdown continues after rejection and timeout without hiding errors', async () => {
  const calls: string[] = [];
  try {
    await cleanupTestResources(
      [
        {
          label: 'failed',
          run: () => {
            calls.push('failed');
            throw new Error('shutdown rejected');
          },
        },
        {
          label: 'hung',
          run: () => {
            calls.push('hung');
            return new Promise(() => {});
          },
        },
        {
          label: 'last',
          run: () => {
            calls.push('last');
          },
        },
      ],
      10,
    );
    throw new Error('Expected cleanup failure');
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map(String)).toEqual([
      'Error: shutdown rejected',
      'Error: hung timed out after 10ms',
    ]);
  }
  expect(calls).toEqual(['failed', 'hung', 'last']);
  expect(await bounded(() => 42, 'quick', 10)).toBe(42);
});

for (const scenario of ['pass', 'fail', 'crash', 'cleanup-fail', 'interrupt']) {
  test(`test supervisor cleans its project after ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinan-supervisor-'));
    const log = join(dir, 'docker.log');
    const ready = join(dir, 'ready');
    writeFileSync(
      join(dir, 'docker'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_LOG"\nexit "${DOCKER_EXIT:-0}"\n',
      { mode: 0o700 },
    );
    const fixture = join(dir, 'fixture.test.ts');
    writeFileSync(
      fixture,
      scenario === 'interrupt'
        ? `import {test} from 'bun:test'; import {writeFileSync} from 'node:fs'; test('wait', async()=>{writeFileSync(${JSON.stringify(ready)},'ready'); await new Promise(()=>{});});`
        : scenario === 'crash'
          ? `process.kill(process.pid, 'SIGKILL');`
          : `import {test,expect} from 'bun:test'; test('fixture',()=>expect(${scenario !== 'fail'}).toBe(true));`,
    );
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'test.ts'), fixture],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          DOCKER_LOG: log,
          DOCKER_EXIT: scenario === 'cleanup-fail' ? '1' : '0',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      },
    );
    try {
      if (scenario === 'interrupt') {
        await bounded(
          async () => {
            while (!(await Bun.file(ready).exists())) await Bun.sleep(20);
          },
          'Fixture startup',
          5000,
        );
        child.kill('SIGTERM');
      }
      const [code] = await bounded(
        () => Promise.all([child.exited, new Response(child.stderr).text()]),
        'Supervisor exit',
        10000,
      );
      expect(code).toBe(
        scenario === 'pass'
          ? 0
          : scenario === 'interrupt'
            ? 130
            : scenario === 'crash'
              ? 137
              : 1,
      );
      const command = readFileSync(log, 'utf8');
      expect(command).toMatch(/-p kinan-test-\d+-[a-f0-9-]+ /);
      expect(command).toContain('down --volumes --remove-orphans --timeout 5');
      expect(command).not.toContain('prune');
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

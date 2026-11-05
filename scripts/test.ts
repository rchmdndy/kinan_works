import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bounded, downTestStack, removeTestDir } from './test-stack';

export async function runTests(args: string[]) {
  const project = `kinan-test-${process.pid}-${crypto.randomUUID()}`;
  const dir = mkdtempSync(join(tmpdir(), 'kinan-integration-'));
  const env = {
    ...process.env,
    KINAN_TEST_PROJECT: project,
    KINAN_TEST_DIR: dir,
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    child?.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let code = 1;
  try {
    child = Bun.spawn(
      [process.execPath, 'test', '--timeout', '60000', ...args],
      {
        env,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      },
    );
    const watchdog = setInterval(() => {
      if (interrupted && child?.exitCode === null) child.kill('SIGKILL');
    }, 5000);
    try {
      code = await bounded(() => child!.exited, 'Test suite', 180000);
    } finally {
      clearInterval(watchdog);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  } catch (error) {
    console.error(error);
  } finally {
    try {
      await downTestStack(project, {
        ...env,
        TEST_REDIS_PORT: '0',
        TEST_MQTT_PORT: '0',
        TEST_AUTH_DIR: join(dir, 'auth'),
        MQTT_INGEST_PASSWORD: 'unused-cleanup-placeholder',
      });
      await removeTestDir(dir);
    } catch (error) {
      console.error(error);
      code = 1;
    }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  return interrupted ? 130 : code;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  process.exitCode = await runTests(
    args.length
      ? args
      : [
          'api/tests',
          'web/src/lib',
          'simulator/src',
          'exporter/src',
          'scripts',
        ],
  );
}

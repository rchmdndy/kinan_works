import { existsSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const testComposeFile = join(
  import.meta.dir,
  '../docker-compose.test.yml',
);

export function testComposeArgs(project: string, args: string[]) {
  if (!/^kinan-test-[a-z0-9-]+$/.test(project))
    throw new Error('Invalid integration test project');
  return [
    'docker',
    'compose',
    '--env-file',
    '/dev/null',
    '-p',
    project,
    '-f',
    testComposeFile,
    ...args,
  ];
}

export async function bounded<T>(
  action: () => T | Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cleanupTestResources(
  actions: { label: string; run: () => unknown | Promise<unknown> }[],
  timeoutMs = 5000,
) {
  const errors: unknown[] = [];
  for (const { label, run } of actions) {
    try {
      await bounded(run, label, timeoutMs);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, 'Integration test cleanup failed');
}

export async function removeTestDir(dir: string) {
  if (!existsSync(dir)) return;
  if (
    dirname(dir) !== realpathSync(tmpdir()) ||
    !/^kinan-integration-[a-zA-Z0-9]+$/.test(basename(dir)) ||
    realpathSync(dir) !== dir ||
    statSync(dir).uid !== process.getuid!()
  )
    throw new Error('Refusing cleanup outside an owned test directory');
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
    const proc = Bun.spawn(
      [
        'docker',
        'run',
        '--rm',
        '--network',
        'none',
        '--mount',
        `type=bind,src=${dir},dst=/work`,
        'eclipse-mosquitto:2.0.21',
        'chown',
        '-R',
        `${process.getuid!()}:${process.getgid!()}`,
        '/work',
      ],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    try {
      const [code, stderr] = await bounded(
        () => Promise.all([proc.exited, new Response(proc.stderr).text()]),
        'Test directory ownership repair',
        10000,
      );
      if (code !== 0)
        throw new Error(`Test directory ownership repair failed: ${stderr}`);
    } finally {
      if (proc.exitCode === null) proc.kill();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function downTestStack(
  project: string,
  env: Record<string, string | undefined>,
) {
  const proc = Bun.spawn(
    testComposeArgs(project, [
      'down',
      '--volumes',
      '--remove-orphans',
      '--timeout',
      '5',
    ]),
    { env, stdout: 'ignore', stderr: 'pipe' },
  );
  try {
    const [code, stderr] = await bounded(
      () => Promise.all([proc.exited, new Response(proc.stderr).text()]),
      'Docker test cleanup',
      30000,
    );
    if (code !== 0)
      throw new Error(`Docker test cleanup failed (${code}): ${stderr}`);
  } finally {
    if (proc.exitCode === null) proc.kill();
  }
}

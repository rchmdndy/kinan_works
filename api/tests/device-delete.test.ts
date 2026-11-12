import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { MemoryTelemetryCache } from '../src/cache.js';

const dir = mkdtempSync(join(tmpdir(), 'kinan-device-delete-test-'));
const passwdStub = join(dir, 'mosquitto_passwd');
writeFileSync(
  passwdStub,
  `#!/bin/sh
printf '%s:' "$4" > "$3"
printf "\\$7\\$" >> "$3"
printf '%s\\n' "$5" >> "$3"
`,
  { mode: 0o700 },
);
chmodSync(passwdStub, 0o700);

const env = {
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://localhost:5173',
  SQLITE_PATH: join(dir, 'test.sqlite'),
  ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString('base64'),
  MQTT_INGEST_PASSWORD: 'x'.repeat(16),
  MOSQUITTO_PASSWD_BIN: passwdStub,
  MOSQUITTO_PASSWORD_FILE: join(dir, 'auth', 'passwd'),
  MOSQUITTO_ACL_FILE: join(dir, 'auth', 'acl'),
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('DELETE /api/devices/:id soft-deletes only the owner device', async () => {
  const service = await createApp(env, {
    cache: new MemoryTelemetryCache(),
    mqtt: false,
  });
  try {
    const now = Date.now();
    const hash = await Bun.password.hash(
      'correct horse battery staple',
      'argon2id',
    );
    for (const id of ['user-1', 'user-2'])
      service.repository.createUser(
        {
          id,
          username: id,
          displayName: id,
          active: true,
          createdAt: now,
          updatedAt: now,
        },
        hash,
      );
    const login = async (username: string) => {
      const response = await service.app.handle(
        new Request('http://localhost/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username,
            password: 'correct horse battery staple',
          }),
        }),
      );
      return {
        cookie: response.headers
          .getSetCookie()
          .map((line) => line.split(';')[0])
          .join('; '),
        csrf: ((await response.json()) as { csrfToken: string }).csrfToken,
      };
    };
    const owner = await login('user-1');
    const other = await login('user-2');
    const headers = (session: { cookie: string; csrf: string }) => ({
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrf,
      Origin: env.APP_ORIGIN,
    });
    const created = await service.app.handle(
      new Request('http://localhost/api/devices', {
        method: 'POST',
        headers: headers(owner),
        body: JSON.stringify({
          label: 'To delete',
          parameters: [{ label: 'Temperature', unit: 'C', points: 1 }],
        }),
      }),
    );
    const deviceId = ((await created.json()) as { device: { id: string } })
      .device.id;
    const remove = (session: { cookie: string; csrf: string }) =>
      service.app.handle(
        new Request(`http://localhost/api/devices/${deviceId}`, {
          method: 'DELETE',
          headers: headers(session),
        }),
      );

    expect((await remove(other)).status).toBe(404);
    expect(service.repository.getDevice(deviceId)).not.toBeNull();
    const noCsrf = await service.app.handle(
      new Request(`http://localhost/api/devices/${deviceId}`, {
        method: 'DELETE',
        headers: { Cookie: owner.cookie, Origin: env.APP_ORIGIN },
      }),
    );
    expect(noCsrf.status).toBe(403);

    expect((await remove(owner)).status).toBe(200);
    expect((await remove(owner)).status).toBe(404);
    const list = await service.app.handle(
      new Request('http://localhost/api/devices', {
        headers: { Cookie: owner.cookie },
      }),
    );
    expect(((await list.json()) as { devices: unknown[] }).devices).toEqual([]);
  } finally {
    await service.close();
  }
});

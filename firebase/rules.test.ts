import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { get, push, ref, set, update } from 'firebase/database';

const projectId = 'demo-kinan-works';
let testEnv: RulesTestEnvironment;

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await set(ref(context.database(), '/'), {
      devices: {
        deviceA: { ownerUid: 'ownerA', active: true, parameters: { temperature: { id: 'temperature' } } },
        deviceB: { ownerUid: 'ownerB', active: true, parameters: { temperature: { id: 'temperature' } } }
      },
      backend: { deviceAccess: {
        deviceA: { ownerUid: 'ownerA', active: true, credentialVersion: 1 },
        deviceB: { ownerUid: 'ownerB', active: true, credentialVersion: 1 },
        inactive: { ownerUid: 'ownerA', active: false, credentialVersion: 1 },
        malformedVersion: { ownerUid: 'ownerA', active: true, credentialVersion: '1' },
        missingVersion: { ownerUid: 'ownerA', active: true }
      } }
    });
  });
}

describe('Realtime Database security rules (emulator)', () => {
  test('owner isolation, device identity, malformed/partial/delete, inactive and old version', async () => {
    testEnv = await initializeTestEnvironment({ projectId, database: { host: '127.0.0.1', port: 9000, rules: readFileSync(new URL('./database.rules.json', import.meta.url), 'utf8') } });
    try {
      await seed();
      const ownerA = testEnv.authenticatedContext('ownerA');
      const ownerB = testEnv.authenticatedContext('ownerB');
      const deviceA = testEnv.authenticatedContext('deviceA', { deviceId: 'deviceA', credentialVersion: 1 });
      const oldDeviceA = testEnv.authenticatedContext('deviceA', { deviceId: 'deviceA', credentialVersion: 0 });
      const inactiveDevice = testEnv.authenticatedContext('inactive', { deviceId: 'inactive', credentialVersion: 1 });
      const malformedVersion = testEnv.authenticatedContext('malformedVersion', { deviceId: 'malformedVersion', credentialVersion: 1 });
      const missingVersion = testEnv.authenticatedContext('missingVersion', { deviceId: 'missingVersion', credentialVersion: 1 });

      await assertSucceeds(get(ref(ownerA.database(), 'devices/deviceA')));
      await assertFails(get(ref(ownerA.database(), 'devices/deviceB')));
      await assertFails(get(ref(ownerB.database(), 'telemetry/deviceA')));
      const timestamp = Date.now();
      const packet = { timestamp, writeId: 'write-1', values: { temperature: { status: 'ok', value: 1 } } };
      await assertSucceeds(set(ref(deviceA.database(), 'telemetry/deviceA/latest'), packet));
      await assertSucceeds(set(ref(deviceA.database(), 'telemetry/deviceA/latest'), { ...packet, timestamp: timestamp + 1, writeId: 'write-2', values: { temperature: { status: 'error', error: 'timeout' } } }));
      await assertSucceeds(push(ref(deviceA.database(), 'telemetry/deviceA/history'), { ...packet, writeId: 'history-1' }));
      await assertFails(set(ref(deviceA.database(), 'telemetry/deviceB/latest'), packet));
      await assertFails(set(ref(deviceA.database(), 'telemetry/deviceA/latest'), { timestamp: timestamp + 2, writeId: 'write-2' }));
      await assertFails(update(ref(deviceA.database(), 'telemetry/deviceA/latest'), { values: null, writeId: 'write-3' }));
      await assertFails(set(ref(deviceA.database(), 'telemetry/deviceA/latest'), { ...packet, timestamp: timestamp + 3, writeId: 'write-4', values: { unknown: { status: 'ok', value: 1 } } }));
      await assertFails(set(ref(deviceA.database(), 'telemetry/deviceA/latest'), { ...packet, timestamp: timestamp + 3, writeId: 'write-5', values: { temperature: { status: 'ok', value: 1, error: 'impossible' } } }));
      await assertFails(set(ref(deviceA.database(), 'telemetry/deviceA/latest'), { ...packet, timestamp: timestamp + 3, writeId: 'write-6', values: { temperature: { status: 'error', error: '' } } }));
      await assertFails(set(ref(oldDeviceA.database(), 'telemetry/deviceA/latest'), { ...packet, timestamp: timestamp + 3, writeId: 'write-7' }));
      await assertFails(set(ref(inactiveDevice.database(), 'telemetry/inactive/latest'), packet));
      await assertFails(set(ref(malformedVersion.database(), 'telemetry/malformedVersion/latest'), packet));
      await assertFails(set(ref(missingVersion.database(), 'telemetry/missingVersion/latest'), packet));
      await assertFails(set(ref(deviceA.database(), 'telemetry/deviceA/latest'), { ...packet, timestamp: Date.now() + 301_000, writeId: 'future' }));
      await assertFails(set(ref(deviceA.database(), 'telemetry/deviceA/latest/timestamp'), timestamp + 4));
      await assertFails(set(ref(deviceA.database(), 'telemetry/deviceA/latest'), null));
      await assertFails(set(ref(deviceA.database(), 'telemetry/deviceA/history/history-1'), null));
    } finally {
      await testEnv.cleanup();
    }
  }, 30_000);
});

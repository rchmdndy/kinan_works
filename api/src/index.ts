import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import { isConfigured, loadConfig, loadServiceAccount } from './config.js';
import { initializeFirebase } from './firebase.js';
import { decryptSecret, encryptSecret, generateDeviceSecret } from './crypto.js';
import { ownerOnly, userAuth, deviceOnly } from './auth.js';
import { rateLimit } from './rate-limit.js';
import { Repository, assertMetadataMigrated, openMetadataDatabase, parameterMap, validateTelemetryParameters } from './repository.js';
import { createDeviceSchema, telemetrySchema, updateDeviceSchema } from './validation.js';
import type { Device } from './types.js';
import type { CreateDevice } from './validation.js';

const app = express();
const configured = isConfigured();

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '128kb' }));
app.get('/health', (_req, res) => res.json({ ok: true, configured }));

if (!configured) {
  app.use((_req, res) => res.status(503).json({ error: 'Service is not configured' }));
  const port = Number(process.env.API_PORT) || 3000;
  app.listen(port, '0.0.0.0', () => console.log(`API health endpoint listening on ${port}; service is not configured`));
} else {
  const config = loadConfig();
  const sqlite = openMetadataDatabase(config.SQLITE_PATH);
  assertMetadataMigrated(sqlite);
  const sqliteWriter = openMetadataDatabase(config.SQLITE_PATH);
  const services = initializeFirebase(config, loadServiceAccount(config.FIREBASE_SERVICE_ACCOUNT_PATH));
  const repository = new Repository(sqlite, services.db, undefined, sqliteWriter);
  app.use(cors({ origin: config.CORS_ORIGIN, credentials: false }));

  const owner: express.RequestHandler[] = [userAuth(services.auth), ownerOnly];
  const deviceAuth: express.RequestHandler = userAuth(services.auth);

app.post('/api/device-login', rateLimit(config.DEVICE_LOGIN_WINDOW_MS, config.DEVICE_LOGIN_MAX_ATTEMPTS), async (req, res) => {
  const input = z.object({ deviceId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/), secret: z.string().min(16).max(256) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Invalid credentials' });
  try {
    const access = await repository.getAccess(input.data.deviceId);
    const encrypted = await repository.getEncryptedSecret(input.data.deviceId);
    if (!access || !encrypted || !access.active) return res.status(401).json({ error: 'Invalid credentials' });
    const secret = await decryptSecret(encrypted, config.encryptionKey);
    if (secret !== input.data.secret) return res.status(401).json({ error: 'Invalid credentials' });
    const customToken = await services.auth.createCustomToken(input.data.deviceId, { deviceId: input.data.deviceId, credentialVersion: access.credentialVersion });
    res.set('Cache-Control', 'no-store');
    return res.json({ customToken, deviceId: input.data.deviceId, credentialVersion: access.credentialVersion });
  } catch {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/api/devices', owner, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try { return res.json({ devices: await repository.listDevices(req.user!.uid) }); } catch (error) { next(error); }
});

app.post('/api/devices', owner, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const input = createDeviceSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Invalid device', details: input.error.flatten() });
  const id = crypto.randomUUID().replaceAll('-', '');
  const now = Date.now();
  const secret = generateDeviceSecret();
  const normalized = input.data as CreateDevice;
  const parameters = normalized.parameters.map((parameter, index) => ({ ...parameter, id: `parameter_${index + 1}` }));
  if (new Set(parameters.map((parameter) => parameter.id)).size !== parameters.length) return res.status(400).json({ error: 'Parameter IDs must be unique' });
  const device: Device = { id, ownerUid: req.user!.uid, label: normalized.label, active: true, credentialVersion: 1, createdAt: now, updatedAt: now, parameters: parameterMap(parameters) };
  try {
    await repository.saveDeviceBundle(device, { ownerUid: device.ownerUid, active: true, credentialVersion: 1 }, await encryptSecret(secret, config.encryptionKey));
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ device, secret });
  } catch (error) { next(error); }
});

app.get('/api/devices/:deviceId/secret', owner, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const device = await repository.getDevice(String(req.params.deviceId));
    if (!device || device.ownerUid !== req.user!.uid) return res.status(404).json({ error: 'Device not found' });
    const encrypted = await repository.getEncryptedSecret(device.id);
    if (!encrypted) return res.status(404).json({ error: 'Device secret unavailable' });
    res.set('Cache-Control', 'no-store');
    return res.json({ deviceId: device.id, secret: await decryptSecret(encrypted, config.encryptionKey), credentialVersion: device.credentialVersion });
  } catch (error) { next(error); }
});

app.patch('/api/devices/:deviceId', owner, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const input = updateDeviceSchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Invalid device', details: input.error.flatten() });
  try {
    const device = await repository.getDevice(String(req.params.deviceId));
    if (!device || device.ownerUid !== req.user!.uid) return res.status(404).json({ error: 'Device not found' });
    const patch: Partial<Device> = { updatedAt: Date.now() };
    if (input.data.label !== undefined) patch.label = input.data.label;
    if (input.data.parameters !== undefined) patch.parameters = parameterMap(input.data.parameters);
    if (input.data.active !== undefined) patch.active = input.data.active;
    if (input.data.active === false && device.active) {
      patch.credentialVersion = device.credentialVersion + 1;
      await repository.disableDeviceBundle({ ...device, ...patch });
      await services.auth.revokeRefreshTokens(device.id);
    } else {
      await repository.updateDevice(device.id, patch);
    }
    return res.json({ device: { ...device, ...patch } });
  } catch (error) { next(error); }
});

app.post('/api/devices/:deviceId/rotate', owner, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const device = await repository.getDevice(String(req.params.deviceId));
    if (!device || device.ownerUid !== req.user!.uid) return res.status(404).json({ error: 'Device not found' });
    const nextVersion = device.credentialVersion + 1;
    const secret = generateDeviceSecret();
    await repository.rotateDeviceBundle({ ...device, credentialVersion: nextVersion, updatedAt: Date.now() }, { ownerUid: device.ownerUid, active: device.active, credentialVersion: nextVersion }, await encryptSecret(secret, config.encryptionKey));
    await services.auth.revokeRefreshTokens(device.id);
    res.set('Cache-Control', 'no-store');
    return res.json({ deviceId: device.id, credentialVersion: nextVersion, secret });
  } catch (error) { next(error); }
});

app.delete('/api/devices/:deviceId', owner, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const device = await repository.getDevice(String(req.params.deviceId));
    if (!device || device.ownerUid !== req.user!.uid) return res.status(404).json({ error: 'Device not found' });
    await repository.disableDeviceBundle({ ...device, active: false, credentialVersion: device.credentialVersion + 1, updatedAt: Date.now() });
    await services.auth.revokeRefreshTokens(device.id);
    await repository.deleteDevice(device.id);
    return res.status(204).end();
  } catch (error) { next(error); }
});

app.post('/api/telemetry/:deviceId', deviceAuth, deviceOnly(repository), async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const input = telemetrySchema.safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Invalid telemetry', details: input.error.flatten() });
  try {
    if (req.user!.deviceId !== String(req.params.deviceId) || input.data.credentialVersion !== req.user!.credentialVersion) return res.status(403).json({ error: 'Invalid device credential version' });
    const device = await repository.getDevice(String(req.params.deviceId));
    if (!device || !device.active || !validateTelemetryParameters(input.data.values, device.parameters)) return res.status(400).json({ error: 'Telemetry must include exactly the registered parameters' });
    const packet = { timestamp: input.data.timestamp ?? { '.sv': 'timestamp' as const }, writeId: crypto.randomUUID(), values: input.data.values };
    await repository.saveLatest(device.id, packet);
    if (input.data.history) await repository.saveHistory(device.id, packet);
    return res.status(202).json({ accepted: true });
  } catch (error) { next(error); }
});

app.get('/api/devices/:deviceId/latest', owner, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const device = await repository.getDevice(String(req.params.deviceId));
    if (!device || device.ownerUid !== req.user!.uid) return res.status(404).json({ error: 'Device not found' });
    return res.json({ latest: await repository.getLatest(device.id) });
  } catch (error) { next(error); }
});

app.get('/api/devices/:deviceId/history', owner, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const query = z.object({ start: z.coerce.number().int().nonnegative(), end: z.coerce.number().int().positive(), limit: z.coerce.number().int().positive().max(config.TELEMETRY_MAX_SAMPLES).default(config.TELEMETRY_MAX_SAMPLES) }).safeParse(req.query);
  if (!query.success || query.data.end <= query.data.start) return res.status(400).json({ error: 'Invalid history range' });
  try {
    const device = await repository.getDevice(String(req.params.deviceId));
    if (!device || device.ownerUid !== req.user!.uid) return res.status(404).json({ error: 'Device not found' });
    return res.json({ device, samples: await repository.getHistory(device.id, query.data.start, query.data.end, query.data.limit) });
  } catch (error) { next(error); }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('request failed', error instanceof Error ? error.message : 'unknown error');
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.API_PORT, '0.0.0.0', () => console.log(`API listening on ${config.API_PORT}`));
}
export { app };

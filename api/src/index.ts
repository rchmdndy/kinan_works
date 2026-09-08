import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { asyncHandler, clearSessionCookie, createSession, mutationRoute, ownerRoute, setSessionCookie } from './auth.js';
import { rateLimit } from './rate-limit.js';
import { openDatabase, parameterMap, Repository, validateTelemetryParameters } from './repository.js';
import { createDeviceSchema, telemetrySchema, updateDeviceSchema } from './validation.js';
import { decryptSecret, encryptSecret, generateDeviceSecret } from './crypto.js';
import { MemoryTelemetryCache, RedisTelemetryCache, type TelemetryCache } from './cache.js';
import { MqttTelemetryConsumer } from './telemetry.js';
import { MosquittoFileCredentials } from './broker.js';
import type { Device, TelemetryPacket } from './types.js';

export async function createApp(env = process.env, options: { cache?: TelemetryCache; mqtt?: boolean } = {}) {
  const config = loadConfig(env);
  const repository = new Repository(openDatabase(config.SQLITE_PATH));
  let activeCache: TelemetryCache = options.cache ?? new RedisTelemetryCache(config.REDIS_URL);
  try { await activeCache.connect(); } catch (error) { if (options.cache) throw error; console.error('redis unavailable; using process-local telemetry cache'); activeCache = new MemoryTelemetryCache(); await activeCache.connect(); }
  const broker = new MosquittoFileCredentials(repository, config);
  const app = express();
  app.disable('x-powered-by'); app.use(helmet({ crossOriginResourcePolicy: false })); app.use(express.json({ limit: '128kb' }));
  app.get('/health', async (_req: express.Request, res: express.Response) => { try { await activeCache.ping(); res.json({ ok: true, redis: true }); } catch { res.json({ ok: true, redis: false }); } });
  const owner = ownerRoute(repository); const mutate = mutationRoute(repository, config);
  app.post('/api/auth/login', rateLimit(config.AUTH_WINDOW_MS, config.AUTH_MAX_ATTEMPTS), asyncHandler(async (req, res) => {
    const input = z.object({ username: z.string().trim().min(3).max(64), password: z.string().min(8).max(256) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid credentials' });
    const user = repository.getUserByUsername(input.data.username);
    if (!user || !user.active || !await Bun.password.verify(input.data.password, user.passwordHash, 'argon2id')) return res.status(401).json({ error: 'Invalid credentials' });
    const session = createSession(repository, config, user.id); setSessionCookie(res, config, session.sessionToken, session.csrfToken);
    res.set('Cache-Control', 'no-store').json({ user: { id: user.id, username: user.username, displayName: user.displayName }, csrfToken: session.csrfToken });
  }));
  app.get('/api/auth/session', owner, (req: express.Request, res: express.Response) => res.set('Cache-Control', 'no-store').json({ user: req.session!.user }));
  app.post('/api/auth/logout', ...mutate, (req: express.Request, res: express.Response) => { repository.deleteSession(req.session!.tokenHash); clearSessionCookie(res, config); res.status(204).end(); });

  app.get('/api/devices', ...owner, (req, res) => res.json({ devices: repository.listDevices(req.session!.user.id) }));
  app.post('/api/devices', ...mutate, asyncHandler(async (req, res) => {
    const input = createDeviceSchema.safeParse(req.body); if (!input.success) return res.status(400).json({ error: 'Invalid device', details: input.error.flatten() });
    const id = crypto.randomUUID().replaceAll('-', ''); const now = Date.now(); const secret = generateDeviceSecret();
    const parameters = parameterMap(input.data.parameters.map((parameter, index) => ({ ...parameter, id: `parameter_${index + 1}` })));
    const device: Device = { id, ownerUid: req.session!.user.id, label: input.data.label, active: true, credentialVersion: 1, createdAt: now, updatedAt: now, parameters };
    repository.saveDeviceBundle(device, await encryptSecret(secret, config.encryptionKey)); await broker.sync();
    res.set('Cache-Control', 'no-store').status(201).json({ device, secret });
  }));
  app.get('/api/devices/:deviceId/secret', ...owner, asyncHandler(async (req, res) => {
    const device = repository.getDevice(String(req.params.deviceId)); if (!device || device.ownerUid !== req.session!.user.id) return res.status(404).json({ error: 'Device not found' });
    const encrypted = repository.getEncryptedSecret(device.id); if (!encrypted) return res.status(404).json({ error: 'Device secret unavailable' });
    res.set('Cache-Control', 'no-store').json({ deviceId: device.id, credentialVersion: device.credentialVersion, secret: await decryptSecret(encrypted, config.encryptionKey) });
  }));
  app.patch('/api/devices/:deviceId', ...mutate, asyncHandler(async (req, res) => {
    const input = updateDeviceSchema.safeParse(req.body); if (!input.success) return res.status(400).json({ error: 'Invalid device', details: input.error.flatten() });
    const device = repository.getDevice(String(req.params.deviceId)); if (!device || device.ownerUid !== req.session!.user.id) return res.status(404).json({ error: 'Device not found' });
    const patch: Partial<Device> = { updatedAt: Date.now() }; if (input.data.label !== undefined) patch.label = input.data.label; if (input.data.parameters !== undefined) patch.parameters = parameterMap(input.data.parameters); if (input.data.active !== undefined) patch.active = input.data.active;
    const updated = repository.updateDevice(device.id, patch); await broker.sync(); res.json({ device: updated });
  }));
  app.post('/api/devices/:deviceId/rotate', ...mutate, asyncHandler(async (req, res) => {
    const device = repository.getDevice(String(req.params.deviceId)); if (!device || device.ownerUid !== req.session!.user.id) return res.status(404).json({ error: 'Device not found' });
    const secret = generateDeviceSecret(); const updated = repository.updateDevice(device.id, { credentialVersion: device.credentialVersion + 1, updatedAt: Date.now() }, await encryptSecret(secret, config.encryptionKey)); await broker.sync();
    res.set('Cache-Control', 'no-store').json({ deviceId: updated.id, credentialVersion: updated.credentialVersion, secret });
  }));
  app.get('/api/devices/:deviceId/latest', ...owner, (req, res) => { const d = repository.getDevice(String(req.params.deviceId)); if (!d || d.ownerUid !== req.session!.user.id) return res.status(404).json({ error: 'Device not found' }); res.json({ latest: repository.getLatest(d.id) }); });
  app.get('/api/devices/:deviceId/history', ...owner, (req, res) => { const q = z.object({ start: z.coerce.number().int().nonnegative(), end: z.coerce.number().int().positive(), limit: z.coerce.number().int().positive().max(config.TELEMETRY_MAX_SAMPLES).default(config.TELEMETRY_MAX_SAMPLES) }).safeParse(req.query); if (!q.success || q.data.end <= q.data.start) return res.status(400).json({ error: 'Invalid history range' }); const d = repository.getDevice(String(req.params.deviceId)); if (!d || d.ownerUid !== req.session!.user.id) return res.status(404).json({ error: 'Device not found' }); res.json({ device: d, samples: repository.getHistory(d.id, q.data.start, q.data.end, q.data.limit) }); });
  app.get('/api/devices/:deviceId/events', ...owner, asyncHandler(async (req, res) => { const d = repository.getDevice(String(req.params.deviceId)); if (!d || d.ownerUid !== req.session!.user.id) return res.status(404).json({ error: 'Device not found' }); res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); const cached = await activeCache.recent(d.id).catch(() => []); const last10 = cached.length === 10 ? cached : repository.getRecent(d.id); res.write(`event: snapshot\ndata: ${JSON.stringify({ latest: repository.getLatest(d.id), last10 })}\n\n`); const unsubscribe = await activeCache.subscribe(d.id, (packet: TelemetryPacket) => res.write(`event: telemetry\ndata: ${JSON.stringify(packet)}\n\n`)); const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20_000); req.on('close', () => { clearInterval(heartbeat); void unsubscribe(); }); }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { console.error('request failed', error instanceof Error ? error.message : 'unknown'); res.status(500).json({ error: 'Internal server error' }); });
  const consumer = new MqttTelemetryConsumer(repository, activeCache, config); if (options.mqtt !== false) { await broker.sync(); await consumer.connect(); }
  return { app, repository, cache: activeCache, consumer, close: async () => { await consumer.close(); await activeCache.close(); repository.close(); } };
}
if (import.meta.main) { const service = await createApp(); service.app.listen(loadConfig().API_PORT, '0.0.0.0', () => console.log('API listening')); }

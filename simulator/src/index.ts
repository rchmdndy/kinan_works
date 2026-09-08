type DeviceLoginResponse = { customToken: string; deviceId: string; credentialVersion: number };
type SignInResponse = { idToken: string; refreshToken: string; expiresIn: string };
type RefreshResponse = { id_token: string; refresh_token?: string; expires_in: string };
type Credentials = { idToken: string; refreshToken: string; expiresAt: number };

export type Config = {
  apiUrl: string;
  firebaseApiKey: string;
  databaseUrl: string;
  authBaseUrl: string;
  deviceId: string;
  deviceSecret: string;
  parameterIds: string[];
  intervalMs: number;
  historyIntervalMs: number;
};

class HttpError extends Error {
  constructor(readonly status: number) { super(`Request failed with status ${status}`); }
}

const required = (env: NodeJS.ProcessEnv, name: string, fallback?: string) => {
  const value = env[name]?.trim() || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const positiveInteger = (env: NodeJS.ProcessEnv, name: string, fallback: string) => {
  const value = Number(required(env, name, fallback));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};

const httpUrl = (value: string, name: string) => {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} must use HTTP or HTTPS`);
  return value.replace(/\/$/, '');
};

export function loadSimulatorConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const deviceId = required(env, 'SIMULATOR_DEVICE_ID');
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(deviceId)) throw new Error('SIMULATOR_DEVICE_ID is invalid');
  const parameterIds = required(env, 'SIMULATOR_PARAMETER_IDS', 'parameter_1,parameter_2').split(',').map((value) => value.trim()).filter(Boolean);
  if (!parameterIds.length || new Set(parameterIds).size !== parameterIds.length || parameterIds.some((id) => !/^[a-zA-Z0-9_-]{1,64}$/.test(id))) throw new Error('SIMULATOR_PARAMETER_IDS is invalid');
  return {
    apiUrl: httpUrl(required(env, 'SIMULATOR_API_URL', 'http://localhost:3000'), 'SIMULATOR_API_URL'),
    firebaseApiKey: required(env, 'SIMULATOR_FIREBASE_API_KEY'),
    databaseUrl: httpUrl(required(env, 'SIMULATOR_DATABASE_URL'), 'SIMULATOR_DATABASE_URL'),
    authBaseUrl: httpUrl(required(env, 'SIMULATOR_AUTH_BASE_URL', 'https://identitytoolkit.googleapis.com'), 'SIMULATOR_AUTH_BASE_URL'),
    deviceId,
    deviceSecret: required(env, 'SIMULATOR_DEVICE_SECRET'),
    parameterIds,
    intervalMs: positiveInteger(env, 'SIMULATOR_INTERVAL_MS', '10000'),
    historyIntervalMs: positiveInteger(env, 'SIMULATOR_HISTORY_INTERVAL_MS', '60000')
  };
}

async function requestJson<T>(fetcher: typeof fetch, url: string, options: RequestInit): Promise<T> {
  const response = await fetcher(url, options);
  if (!response.ok) throw new HttpError(response.status);
  return await response.json().catch(() => ({})) as T;
}

export function createSimulator(config: Config, dependencies: { fetch?: typeof fetch; now?: () => number; randomUUID?: () => string } = {}) {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const tokenBaseUrl = config.authBaseUrl.replace('identitytoolkit.googleapis.com', 'securetoken.googleapis.com');
  let credentials: Credentials | null = null;
  let lastHistoryAt = 0;
  let lastTimestamp = 0;

  const setCredentials = (result: SignInResponse, timestamp: number) => {
    const expiresIn = Number(result.expiresIn);
    if (!result.idToken || !result.refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Firebase sign-in response is invalid');
    credentials = { idToken: result.idToken, refreshToken: result.refreshToken, expiresAt: timestamp + expiresIn * 1000 };
  };

  async function login(): Promise<void> {
    const result = await requestJson<DeviceLoginResponse>(fetcher, `${config.apiUrl}/api/device-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: config.deviceId, secret: config.deviceSecret })
    });
    if (result.deviceId !== config.deviceId || !Number.isSafeInteger(result.credentialVersion) || result.credentialVersion <= 0) throw new Error('Device login response is invalid');
    const auth = await requestJson<SignInResponse>(fetcher, `${config.authBaseUrl}/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(config.firebaseApiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: result.customToken, returnSecureToken: true })
    });
    setCredentials(auth, now());
  }

  async function refresh(): Promise<void> {
    if (!credentials) return login();
    const result = await requestJson<RefreshResponse>(fetcher, `${tokenBaseUrl}/v1/token?key=${encodeURIComponent(config.firebaseApiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken })
    });
    const expiresIn = Number(result.expires_in);
    if (!result.id_token || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Firebase refresh response is invalid');
    credentials = { idToken: result.id_token, refreshToken: result.refresh_token || credentials.refreshToken, expiresAt: now() + expiresIn * 1000 };
  }

  function buildValues(timestamp: number): Record<string, { status: 'ok'; value: number }> {
    return Object.fromEntries(config.parameterIds.map((id, index) => [id, { status: 'ok' as const, value: Number((20 + index * 10 + Math.sin(timestamp / (80_000 + index * 10_000)) * 4).toFixed(2)) }]));
  }

  async function sendTelemetry(): Promise<void> {
    if (!credentials) await login();
    else if (credentials.expiresAt - now() <= 60_000) await refresh();
    const timestamp = Math.max(now(), lastTimestamp + 1);
    const writeId = randomUUID();
    const packet = { timestamp, writeId, values: buildValues(timestamp) };
    const includeHistory = timestamp - lastHistoryAt >= config.historyIntervalMs;
    const updates: Record<string, typeof packet> = { latest: packet };
    if (includeHistory) updates[`history/${writeId}`] = packet;
    const write = () => requestJson<unknown>(fetcher, `${config.databaseUrl}/telemetry/${encodeURIComponent(config.deviceId)}.json?auth=${encodeURIComponent(credentials!.idToken)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
    });
    try {
      await write();
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) throw error;
      await refresh();
      await write();
    }
    lastTimestamp = timestamp;
    if (includeHistory) lastHistoryAt = timestamp;
  }

  return { login, refresh, sendTelemetry };
}

export async function run(config = loadSimulatorConfig()): Promise<never> {
  const simulator = createSimulator(config);
  await simulator.login();
  while (true) {
    const startedAt = Date.now();
    try { await simulator.sendTelemetry(); }
    catch (error) { console.error('telemetry failed', error instanceof Error ? error.message : 'unknown error'); }
    await Bun.sleep(Math.max(0, config.intervalMs - (Date.now() - startedAt)));
  }
}

if (import.meta.main) await run();

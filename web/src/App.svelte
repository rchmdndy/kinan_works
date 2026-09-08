<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { browserLocalPersistence, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth';
  import { limitToLast, onValue, orderByChild, query, ref } from 'firebase/database';
  import { api } from './lib/api';
  import { drawChart } from './lib/chart';
  import { lastTelemetrySamples } from './lib/telemetry';
  import { hasDeviceDraftErrors, normalizeDeviceDraft, validateDeviceDraft, type DeviceDraftErrors, type ParameterDraft } from './lib/device-form';
  import { buildExportTable, formatReading } from './lib/export-data';
  import { exportTelemetry } from './lib/export';
  import { auth, database, firebaseSetupError } from './lib/firebase';
  import type { Device, Parameter, TelemetryPacket } from './lib/types';

  type Route = { page: 'devices' | 'new' | 'exports' } | { page: 'detail' | 'edit' | 'realtime'; id: string };
  const emptyErrors: DeviceDraftErrors = { parameter: [] };

  let user: User | null = null;
  let email = '';
  let password = '';
  let message = firebaseSetupError;
  let notice = '';
  let authBusy = false;
  let devicesBusy = false;
  let saveBusy = false;
  let createBusy = false;
  let secretBusy = false;
  let exportBusy = false;
  let devices: Device[] = [];
  let selectedId = '';
  let latest: TelemetryPacket | null = null;
  let history: TelemetryPacket[] = [];
  let chartParameterIds: string[] = [];
  let chartCanvas: HTMLCanvasElement;
  let chart: ReturnType<typeof drawChart> | null = null;
  let unsubscribeTelemetry: (() => void) | null = null;
  let unsubscribeAuth: (() => void) | null = null;
  let staleTimer: ReturnType<typeof setInterval> | null = null;
  let selectionVersion = 0;
  let now = Date.now();
  let route: Route = { page: 'devices' };
  let draftLabel = '';
  let draftParameters: Parameter[] = [];
  let secret = '';
  let secretDeviceId = '';
  let copyStatus = '';
  let createLabel = '';
  let createParameters: ParameterDraft[] = [{ label: '', unit: '', points: 1 }];
  let createErrors = emptyErrors;
  let exportDeviceId = '';
  let exportParameterIds: string[] = [];
  let startDate = toLocalDateTime(Date.now() - 24 * 60 * 60 * 1000);
  let endDate = toLocalDateTime(Date.now());

  $: selectedDevice = devices.find((device) => device.id === selectedId) || null;
  $: exportDevice = devices.find((device) => device.id === exportDeviceId) || null;
  $: stale = latest ? now - latest.timestamp > 2 * 60 * 1000 : true;

  function parseRoute(): Route {
    const path = window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (path[0] === 'devices' && path[1] === 'new') return { page: 'new' };
    if (path[0] === 'devices' && path[1]) {
      const id = decodeURIComponent(path[1]);
      if (path[2] === 'edit') return { page: 'edit', id };
      if (path[2] === 'realtime') return { page: 'realtime', id };
      return { page: 'detail', id };
    }
    if (path[0] === 'exports') return { page: 'exports' };
    return { page: 'devices' };
  }

  function go(path: string) {
    const hash = `#${path}`;
    if (window.location.hash === hash) void applyRoute();
    else window.location.hash = hash;
  }

  async function applyRoute() {
    const next = parseRoute();
    const previous = route;
    route = next;
    message = '';
    notice = '';
    if (next.page === 'detail' || next.page === 'edit' || next.page === 'realtime') {
      if (next.page !== 'detail' || (secretDeviceId && secretDeviceId !== next.id)) clearSecret();
      if (user && (selectedId !== next.id || previous.page !== next.page)) await selectDevice(next.id, next.page);
    } else {
      clearTelemetry();
      selectedId = '';
      clearSecret();
    }
    if (next.page === 'new') resetCreateForm();
    if (next.page === 'exports') syncExportDevice();
  }

  function toLocalDateTime(timestamp: number): string {
    const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
    return date.toISOString().slice(0, 16);
  }

  function readingValue(id: string): number | null {
    const reading = latest?.values[id];
    return reading?.status === 'ok' ? reading.value : null;
  }

  function readingError(id: string): string | null {
    const reading = latest?.values[id];
    return reading?.status === 'error' ? reading.error : null;
  }

  function toggleChartParameter(id: string) {
    chartParameterIds = chartParameterIds.includes(id) ? chartParameterIds.filter((item) => item !== id) : [...chartParameterIds, id];
    renderChart();
  }

  onMount(() => {
    staleTimer = setInterval(() => now = Date.now(), 15_000);
    window.addEventListener('hashchange', applyRoute);
    if (!window.location.hash) window.location.hash = '#devices';
    else void applyRoute();
    if (!auth) return;
    unsubscribeAuth = onAuthStateChanged(auth, async (next) => {
      clearTelemetry();
      selectedId = '';
      clearSecret();
      user = next;
      if (!next) {
        devices = [];
        return;
      }
      try {
        await loadDevices();
        await applyRoute();
      } catch (error) {
        message = error instanceof Error ? error.message : 'Gagal memuat perangkat.';
      }
    });
  });

  onDestroy(() => {
    window.removeEventListener('hashchange', applyRoute);
    unsubscribeAuth?.();
    if (staleTimer) clearInterval(staleTimer);
    clearTelemetry();
    clearSecret();
  });

  async function loadDevices() {
    devicesBusy = true;
    try {
      const result = await api<{ devices: Device[] }>('/api/devices');
      devices = result.devices;
      if (exportDeviceId && !devices.some((device) => device.id === exportDeviceId)) exportDeviceId = '';
    } finally {
      devicesBusy = false;
    }
  }

  function clearTelemetry() {
    selectionVersion += 1;
    unsubscribeTelemetry?.();
    unsubscribeTelemetry = null;
    chart?.destroy();
    chart = null;
    latest = null;
    history = [];
  }

  function clearSecret() {
    secret = '';
    secretDeviceId = '';
    copyStatus = '';
  }

  function renderChart() {
    chart?.destroy();
    chart = null;
    const device = devices.find((item) => item.id === selectedId);
    if (chartCanvas && device) chart = drawChart(chartCanvas, device, history, chartParameterIds);
  }

  async function selectDevice(id: string, page: 'detail' | 'edit' | 'realtime') {
    clearTelemetry();
    selectedId = id;
    const version = selectionVersion;
    const device = devices.find((item) => item.id === id);
    if (!device) {
      message = 'Perangkat tidak ditemukan.';
      return;
    }
    draftLabel = device.label;
    draftParameters = Object.values(device.parameters).map((parameter) => ({ ...parameter }));
    if (page !== 'realtime') return;

    chartParameterIds = Object.keys(device.parameters);
    if (!database) {
      message = firebaseSetupError || 'Realtime Database tidak tersedia.';
      return;
    }
    const latestRef = ref(database, `telemetry/${id}/latest`);
    const historyRef = query(ref(database, `telemetry/${id}/history`), orderByChild('timestamp'), limitToLast(10));
    const stopLatest = onValue(latestRef, (snapshot) => {
      if (version === selectionVersion && id === selectedId && route.page === 'realtime') latest = snapshot.exists() ? snapshot.val() : null;
    }, (error) => {
      if (version === selectionVersion) message = `Telemetry realtime gagal: ${error.message}`;
    });
    const stopHistory = onValue(historyRef, (snapshot) => {
      if (version !== selectionVersion || id !== selectedId || route.page !== 'realtime') return;
      history = lastTelemetrySamples(snapshot.val(), 10);
      setTimeout(renderChart, 0);
    }, (error) => {
      if (version === selectionVersion) message = `Riwayat realtime gagal: ${error.message}`;
    });
    const stop = () => { stopLatest(); stopHistory(); };
    if (version === selectionVersion && id === selectedId && route.page === 'realtime') unsubscribeTelemetry = stop;
    else stop();
  }

  async function submitAuth() {
    if (!auth) {
      message = firebaseSetupError;
      return;
    }
    authBusy = true;
    message = '';
    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, email, password);
      password = '';
    } catch (error) {
      message = error instanceof Error ? error.message : 'Autentikasi gagal.';
    } finally {
      authBusy = false;
    }
  }

  async function logout() {
    clearSecret();
    if (auth) await signOut(auth);
  }

  function resetCreateForm() {
    createLabel = '';
    createParameters = [{ label: '', unit: '', points: 1 }];
    createErrors = emptyErrors;
  }

  function addCreateParameter() {
    createParameters = [...createParameters, { label: '', unit: '', points: 1 }];
    createErrors = emptyErrors;
  }

  function removeCreateParameter(index: number) {
    createParameters = createParameters.filter((_, itemIndex) => itemIndex !== index);
    createErrors = emptyErrors;
  }

  async function createDevice() {
    createErrors = validateDeviceDraft(createLabel, createParameters);
    if (hasDeviceDraftErrors(createErrors)) return;
    createBusy = true;
    message = '';
    try {
      const result = await api<{ device: Device; secret: string }>('/api/devices', {
        method: 'POST',
        body: JSON.stringify(normalizeDeviceDraft(createLabel, createParameters))
      });
      devices = [...devices, result.device];
      secretDeviceId = result.device.id;
      secret = result.secret;
      copyStatus = '';
      go(`/devices/${encodeURIComponent(result.device.id)}`);
    } catch (error) {
      message = error instanceof Error ? error.message : 'Gagal membuat perangkat.';
    } finally {
      createBusy = false;
    }
  }

  async function saveDevice() {
    if (!selectedDevice) return;
    const errors = validateDeviceDraft(draftLabel, draftParameters);
    if (hasDeviceDraftErrors(errors)) {
      message = 'Periksa nama, label, satuan, dan desimal parameter.';
      return;
    }
    saveBusy = true;
    message = '';
    notice = '';
    try {
      const id = selectedDevice.id;
      const normalized = normalizeDeviceDraft(draftLabel, draftParameters);
      const parameters = draftParameters.map((parameter, index) => ({ id: parameter.id, ...normalized.parameters[index] }));
      const result = await api<{ device: Device }>(`/api/devices/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ label: normalized.label, parameters })
      });
      devices = devices.map((device) => device.id === id ? result.device : device);
      chartParameterIds = Object.keys(result.device.parameters);
      draftLabel = result.device.label;
      draftParameters = Object.values(result.device.parameters).map((parameter) => ({ ...parameter }));
      notice = 'Perubahan tersimpan.';
    } catch (error) {
      message = error instanceof Error ? error.message : 'Gagal menyimpan perangkat.';
    } finally {
      saveBusy = false;
    }
  }

  function addParameter() {
    let id: string;
    do id = `parameter_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    while (draftParameters.some((parameter) => parameter.id === id));
    draftParameters = [...draftParameters, { id, label: 'Parameter baru', unit: '', points: 0 }];
  }

  function removeParameter(id: string) {
    if (draftParameters.length > 1) draftParameters = draftParameters.filter((parameter) => parameter.id !== id);
  }

  async function revealSecret() {
    if (!selectedDevice) return;
    secretBusy = true;
    message = '';
    try {
      const result = await api<{ secret: string }>(`/api/devices/${encodeURIComponent(selectedDevice.id)}/secret`);
      secretDeviceId = selectedDevice.id;
      secret = result.secret;
      copyStatus = '';
    } catch (error) {
      message = error instanceof Error ? error.message : 'Secret tidak tersedia.';
    } finally {
      secretBusy = false;
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      copyStatus = 'Secret disalin.';
    } catch {
      copyStatus = 'Salin manual dari kolom secret.';
    }
  }

  async function toggleDevice() {
    if (!selectedDevice || saveBusy) return;
    saveBusy = true;
    message = '';
    try {
      const result = await api<{ device: Device }>(`/api/devices/${encodeURIComponent(selectedDevice.id)}`, {
        method: 'PATCH', body: JSON.stringify({ active: !selectedDevice.active })
      });
      devices = devices.map((device) => device.id === result.device.id ? result.device : device);
      notice = result.device.active ? 'Perangkat diaktifkan.' : 'Perangkat dinonaktifkan.';
    } catch (error) {
      message = error instanceof Error ? error.message : 'Gagal mengubah status.';
    } finally {
      saveBusy = false;
    }
  }

  function syncExportDevice() {
    const device = devices.find((item) => item.id === exportDeviceId) || devices[0];
    exportDeviceId = device?.id || '';
    exportParameterIds = device ? Object.keys(device.parameters) : [];
  }

  function changeExportDevice(id: string) {
    exportDeviceId = id;
    const device = devices.find((item) => item.id === id);
    exportParameterIds = device ? Object.keys(device.parameters) : [];
  }

  function toggleExportParameter(id: string) {
    exportParameterIds = exportParameterIds.includes(id) ? exportParameterIds.filter((item) => item !== id) : [...exportParameterIds, id];
  }

  async function exportReport() {
    if (!exportDevice || !exportParameterIds.length) {
      message = 'Pilih perangkat dan minimal satu parameter.';
      return;
    }
    const requestedDeviceId = exportDevice.id;
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start) {
      message = 'Rentang waktu tidak valid.';
      return;
    }
    exportBusy = true;
    message = '';
    notice = '';
    try {
      const result = await api<{ device: Device; samples: TelemetryPacket[] }>(`/api/devices/${encodeURIComponent(requestedDeviceId)}/history?start=${start.getTime()}&end=${end.getTime()}&limit=500`);
      if (requestedDeviceId !== exportDeviceId) return;
      if (result.samples.length === 500) {
        message = 'Ekspor dibatalkan karena mencapai batas 500 sampel dan mungkin tidak lengkap. Persempit rentang waktu.';
        return;
      }
      const availableIds = exportParameterIds.filter((id) => result.device.parameters[id]);
      if (!availableIds.length) {
        message = 'Parameter yang dipilih tidak lagi tersedia.';
        return;
      }
      await exportTelemetry(result.device, result.samples, start, end, availableIds);
      const count = buildExportTable(result.device, result.samples, start, end, availableIds).rows.length;
      notice = `${count} sampel diekspor dengan metadata perangkat terbaru.`;
    } catch (error) {
      message = error instanceof Error ? error.message : 'Ekspor gagal.';
    } finally {
      exportBusy = false;
    }
  }
</script>

<svelte:head><title>Kinan Works | Telemetry</title></svelte:head>

{#if !user}
  <main class="auth-shell">
    <section class="auth-card" aria-labelledby="login-title">
      <div class="brand-mark">KW</div>
      <p class="eyebrow">KINAN WORKS</p>
      <h1 id="login-title">Telemetry, tanpa kerumitan.</h1>
      <p class="muted">Pantau perangkat dan data sensor dari satu ruang kerja yang tenang.</p>
      {#if firebaseSetupError}<div class="callout danger" role="alert"><strong>Konfigurasi belum lengkap</strong><span>{firebaseSetupError} Isi variabel VITE_FIREBASE_* lalu muat ulang aplikasi.</span></div>{/if}
      <form onsubmit={(event) => { event.preventDefault(); void submitAuth(); }}>
        <label>Email<input type="email" bind:value={email} required autocomplete="email" disabled={!auth || authBusy} /></label>
        <label>Password<input type="password" bind:value={password} required minlength="6" autocomplete="current-password" disabled={!auth || authBusy} /></label>
        <button type="submit" disabled={!auth || authBusy}>{authBusy ? 'Memeriksa…' : 'Masuk'}</button>
      </form>
      <p class="auth-note">Akun dikelola administrator melalui Firebase Console.</p>
      {#if message && !firebaseSetupError}<p class="form-error" role="alert">{message}</p>{/if}
    </section>
  </main>
{:else}
  <div class="app-layout">
    <aside class="sidebar">
      <a class="brand" href="#devices" aria-label="Kinan Works"><span class="brand-mark small">KW</span><span><strong>Kinan Works</strong><small>Telemetry console</small></span></a>
      <nav aria-label="Navigasi utama">
        <a href="#devices" class:active={route.page === 'devices' || route.page === 'detail' || route.page === 'edit' || route.page === 'realtime' || route.page === 'new'}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="3"></rect><path d="M8 8h8M8 12h8M8 16h4"></path></svg>
          Devices
        </a>
        <a href="#exports" class:active={route.page === 'exports'}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4"></path><path d="M5 17v3h14v-3"></path></svg>
          Exports
        </a>
      </nav>
      <div class="sidebar-account"><span class="avatar">{(user.email || 'U').slice(0, 1).toUpperCase()}</span><span><strong>{user.email}</strong><button class="text-button" onclick={() => void logout()}>Keluar</button></span></div>
    </aside>

    <main class="main-content">
      {#if route.page === 'devices'}
        <header class="page-header"><div><p class="eyebrow">WORKSPACE</p><h1>Devices</h1><p>Kelola perangkat dan lihat kondisi telemetry terbaru.</p></div><a class="button" href="#/devices/new">Tambah device</a></header>
        {#if devicesBusy}
          <section class="panel empty"><div class="spinner"></div><p>Memuat perangkat…</p></section>
        {:else if devices.length}
          <section class="device-grid" aria-label="Daftar perangkat">
            {#each devices as device}
              <a class="device-card" href={`#/devices/${encodeURIComponent(device.id)}`}>
                <div class="device-card-top"><span class:inactive={!device.active} class="device-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="3"></rect><circle cx="12" cy="16" r="1"></circle><path d="M9 8h6M9 11h6"></path></svg></span><span class:offline={!device.active} class="status-pill">{device.active ? 'Active' : 'Inactive'}</span></div>
                <div><h2>{device.label}</h2><p>{Object.keys(device.parameters).length} parameter</p></div>
                <code>{device.id}</code><span class="card-link">Lihat detail <span aria-hidden="true">→</span></span>
              </a>
            {/each}
          </section>
        {:else}
          <section class="panel empty"><span class="empty-icon">＋</span><h2>Belum ada device</h2><p>Tambahkan perangkat pertama untuk mulai menerima telemetry.</p><a class="button" href="#/devices/new">Tambah device</a></section>
        {/if}
      {:else if route.page === 'new'}
        <header class="page-header compact"><div><a class="back-link" href="#devices">← Devices</a><p class="eyebrow">NEW DEVICE</p><h1>Tambah device</h1><p>Buat perangkat dan tentukan data yang akan dikirim.</p></div></header>
        <form class="panel form-panel" onsubmit={(event) => { event.preventDefault(); void createDevice(); }} novalidate>
          <div class="section-heading"><span>01</span><div><h2>Informasi perangkat</h2><p>Nama ini tampil di daftar dan laporan.</p></div></div>
          <label class="wide-field">Nama device <span aria-hidden="true">*</span><input bind:value={createLabel} maxlength="100" placeholder="Contoh: Sensor ruang produksi" aria-invalid={Boolean(createErrors.label)} aria-describedby={createErrors.label ? 'create-label-error' : undefined} disabled={createBusy} />{#if createErrors.label}<small class="field-error" id="create-label-error">{createErrors.label}</small>{/if}</label>
          <div class="form-divider"></div>
          <div class="section-heading"><span>02</span><div><h2>Parameter</h2><p>ID permanen dibuat oleh server setelah device disimpan.</p></div></div>
          <div class="parameter-list">
            {#each createParameters as parameter, index}
              <fieldset class="parameter-card"><legend>Parameter {index + 1}</legend><div class="parameter-fields"><label>Label <span aria-hidden="true">*</span><input bind:value={parameter.label} maxlength="100" placeholder="Suhu" aria-invalid={Boolean(createErrors.parameter[index]?.label)} disabled={createBusy} />{#if createErrors.parameter[index]?.label}<small class="field-error">{createErrors.parameter[index].label}</small>{/if}</label><label>Satuan<input bind:value={parameter.unit} maxlength="32" placeholder="°C" aria-invalid={Boolean(createErrors.parameter[index]?.unit)} disabled={createBusy} />{#if createErrors.parameter[index]?.unit}<small class="field-error">{createErrors.parameter[index].unit}</small>{/if}</label><label>Desimal <span aria-hidden="true">*</span><input bind:value={parameter.points} type="number" min="0" max="10" step="1" aria-invalid={Boolean(createErrors.parameter[index]?.points)} disabled={createBusy} />{#if createErrors.parameter[index]?.points}<small class="field-error">{createErrors.parameter[index].points}</small>{/if}</label></div><button class="icon-button" type="button" aria-label={`Hapus parameter ${index + 1}`} title="Hapus parameter" onclick={() => removeCreateParameter(index)} disabled={createBusy || createParameters.length === 1}>×</button></fieldset>
            {/each}
          </div>
          {#if createErrors.parameters}<p class="field-error">{createErrors.parameters}</p>{/if}
          <button class="add-row" type="button" onclick={addCreateParameter} disabled={createBusy || createParameters.length >= 100}>＋ Tambah parameter</button>
          {#if message}<p class="form-error" role="alert">{message}</p>{/if}
          <div class="form-actions"><a class="button secondary" href="#devices">Batal</a><button type="submit" disabled={createBusy}>{createBusy ? 'Membuat…' : 'Buat device'}</button></div>
        </form>
      {:else if route.page === 'detail' || route.page === 'edit' || route.page === 'realtime'}
        {#if selectedDevice}
          <header class="page-header detail-header"><div><a class="back-link" href="#devices">← Devices</a><div class="title-status"><h1>{selectedDevice.label}</h1><span class:offline={!selectedDevice.active} class="status-pill">{selectedDevice.active ? 'Active' : 'Inactive'}</span></div><code>{selectedDevice.id}</code></div>{#if route.page === 'detail'}<div class="header-buttons"><button class="secondary" onclick={() => void toggleDevice()} disabled={saveBusy}>{selectedDevice.active ? 'Nonaktifkan' : 'Aktifkan'}</button></div>{/if}</header>
          <nav class="device-tabs" aria-label="Halaman perangkat"><a href={`#/devices/${encodeURIComponent(selectedDevice.id)}`} class:active={route.page === 'detail'} aria-current={route.page === 'detail' ? 'page' : undefined}>Detail</a><a href={`#/devices/${encodeURIComponent(selectedDevice.id)}/edit`} class:active={route.page === 'edit'} aria-current={route.page === 'edit' ? 'page' : undefined}>Edit device</a><a href={`#/devices/${encodeURIComponent(selectedDevice.id)}/realtime`} class:active={route.page === 'realtime'} aria-current={route.page === 'realtime' ? 'page' : undefined}>Realtime</a></nav>
          {#if route.page === 'detail'}
            <section id="device-metadata" class="panel metadata-panel" aria-labelledby="metadata-title"><div class="panel-heading"><div><p class="eyebrow">DEVICE</p><h2 id="metadata-title">Detail perangkat</h2><p>Metadata perangkat terbaru.</p></div><a class="button secondary" href={`#/devices/${encodeURIComponent(selectedDevice.id)}/edit`}>Edit device</a></div><dl class="metadata-grid"><div><dt>Device ID</dt><dd><code>{selectedDevice.id}</code></dd></div><div><dt>Status</dt><dd>{selectedDevice.active ? 'Active' : 'Inactive'}</dd></div><div><dt>Dibuat</dt><dd>{new Date(selectedDevice.createdAt).toLocaleString('id-ID')}</dd></div><div><dt>Diperbarui</dt><dd>{new Date(selectedDevice.updatedAt).toLocaleString('id-ID')}</dd></div><div><dt>Versi kredensial</dt><dd>{selectedDevice.credentialVersion}</dd></div><div><dt>Parameter</dt><dd>{Object.keys(selectedDevice.parameters).length}</dd></div></dl></section>
            <section id="device-credentials" class="panel credentials-panel" aria-labelledby="credentials-title"><div><p class="eyebrow">CREDENTIALS</p><h2 id="credentials-title">Kredensial perangkat</h2><p>Gunakan Device ID dan secret untuk mengautentikasi perangkat. Secret tidak disimpan di browser.</p></div><button class="secondary" onclick={() => void revealSecret()} disabled={secretBusy}>{secretBusy ? 'Memuat…' : 'Tampilkan secret'}</button></section>
            {#if secret && secretDeviceId === selectedDevice.id}<section class="callout secret-panel" aria-labelledby="secret-title"><div><strong id="secret-title">Secret perangkat</strong><p>Simpan dengan aman.</p></div><div class="secret-copy"><input value={secret} readonly aria-label="Secret perangkat" /><button onclick={() => void copySecret()}>Salin</button></div><p class="copy-status" aria-live="polite">{copyStatus}</p></section>{/if}
          {:else if route.page === 'edit'}
            <section id="device-editor" class="panel editor-panel"><div class="panel-heading"><div><p class="eyebrow">SETTINGS</p><h2>Konfigurasi device</h2><p>ID parameter tetap; label, satuan, dan desimal dapat diedit.</p></div><button onclick={() => void saveDevice()} disabled={saveBusy}>{saveBusy ? 'Menyimpan…' : 'Simpan perubahan'}</button></div><label class="wide-field">Nama device<input bind:value={draftLabel} maxlength="100" disabled={saveBusy} /></label><div class="table-wrap"><div class="parameter-table table-head"><span>ID</span><span>Label</span><span>Satuan</span><span>Desimal</span><span></span></div>{#each draftParameters as parameter}<div class="parameter-table"><input aria-label="ID parameter" value={parameter.id} readonly /><input aria-label="Label parameter" bind:value={parameter.label} maxlength="100" disabled={saveBusy} /><input aria-label="Satuan parameter" bind:value={parameter.unit} maxlength="32" disabled={saveBusy} /><input aria-label="Desimal parameter" type="number" min="0" max="10" step="1" bind:value={parameter.points} disabled={saveBusy} /><button class="icon-button" aria-label={`Hapus ${parameter.label}`} onclick={() => removeParameter(parameter.id)} disabled={saveBusy || draftParameters.length === 1}>×</button></div>{/each}</div><button class="add-row" onclick={addParameter} disabled={saveBusy || draftParameters.length >= 100}>＋ Tambah parameter</button></section>
          {:else}
            <section id="realtime-summary" class="summary-bar"><div><span class:offline={stale} class="live-dot"></span><span><strong>{stale ? 'Menunggu data terbaru' : 'Telemetry terhubung'}</strong><small>{latest ? `Pembaruan ${new Date(latest.timestamp).toLocaleString('id-ID')}` : 'Belum ada data'}</small></span></div><a href="#exports">Ekspor data →</a></section>
            <section id="latest-values" class="metric-grid" aria-label="Nilai parameter terbaru">{#each Object.values(selectedDevice.parameters) as parameter}<article class="metric-card"><div><span>{parameter.label}</span><small>{parameter.unit || 'Tanpa satuan'}</small></div>{#if readingValue(parameter.id) !== null}<strong>{formatReading(readingValue(parameter.id)!, parameter.points)}</strong>{:else}<strong>—</strong>{#if readingError(parameter.id)}<small class="reading-error">Error: {readingError(parameter.id)}</small>{:else}<small>Belum ada nilai</small>{/if}{/if}<time datetime={latest ? new Date(latest.timestamp).toISOString() : undefined}>{latest ? new Date(latest.timestamp).toLocaleString('id-ID') : 'Belum ada timestamp'}</time></article>{/each}</section>
            <section id="realtime-chart" class="panel chart-panel"><div class="panel-heading"><div><p class="eyebrow">LAST 10</p><h2>Riwayat telemetry realtime</h2><p>10 sampel history terakhir, berurutan berdasarkan timestamp. Data error tetap kosong.</p></div></div><fieldset class="parameter-selector"><legend>Parameter grafik</legend>{#each Object.values(selectedDevice.parameters) as parameter}<label><input type="checkbox" checked={chartParameterIds.includes(parameter.id)} onchange={() => toggleChartParameter(parameter.id)} />{parameter.label}</label>{/each}</fieldset><div class="chart"><canvas bind:this={chartCanvas}></canvas></div></section>
          {/if}
          {#if notice}<p class="toast success" role="status">{notice}</p>{/if}{#if message}<p class="toast error" role="alert">{message}</p>{/if}
        {:else}<section class="panel empty"><h2>Device tidak ditemukan</h2><p>Perangkat ini tidak tersedia atau sudah dihapus.</p><a class="button" href="#devices">Kembali ke devices</a></section>{/if}
      {:else if route.page === 'exports'}
        <header class="page-header"><div><p class="eyebrow">DATA TOOLS</p><h1>Exports</h1><p>Unduh telemetry sebagai XLSX dengan metadata dan format numerik yang tepat.</p></div></header>
        {#if devices.length}
          <form class="panel export-panel" onsubmit={(event) => { event.preventDefault(); void exportReport(); }}>
            <div class="section-heading"><span>01</span><div><h2>Pilih data</h2><p>Rentang akhir bersifat eksklusif. Maksimal 499 sampel untuk memastikan file lengkap.</p></div></div>
            <div class="export-grid"><label>Device<select value={exportDeviceId} onchange={(event) => changeExportDevice((event.currentTarget as HTMLSelectElement).value)} disabled={exportBusy}>{#each devices as device}<option value={device.id}>{device.label}</option>{/each}</select></label><label>Mulai<input type="datetime-local" bind:value={startDate} required disabled={exportBusy} /></label><label>Akhir (eksklusif)<input type="datetime-local" bind:value={endDate} required disabled={exportBusy} /></label></div>
            {#if exportDevice}<fieldset class="export-parameters"><legend>Parameter yang disertakan</legend>{#each Object.values(exportDevice.parameters) as parameter}<label><input type="checkbox" checked={exportParameterIds.includes(parameter.id)} onchange={() => toggleExportParameter(parameter.id)} disabled={exportBusy} /><span><strong>{parameter.label}</strong><small>{parameter.id} · {parameter.unit || 'tanpa satuan'} · {parameter.points} desimal</small></span></label>{/each}</fieldset>{/if}
            <div class="export-note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5m0-8h.01"></path></svg><p>File memuat sheet <strong>Data</strong> dan <strong>Informasi</strong>. Metadata terbaru diterapkan tanpa mengonversi nilai histori.</p></div>
            {#if notice}<p class="form-success" role="status">{notice}</p>{/if}{#if message}<p class="form-error" role="alert">{message}</p>{/if}
            <div class="form-actions end"><button type="submit" disabled={exportBusy || !exportParameterIds.length}>{exportBusy ? 'Menyiapkan…' : 'Unduh XLSX'}</button></div>
          </form>
        {:else}<section class="panel empty"><h2>Belum ada data untuk diekspor</h2><p>Tambahkan device terlebih dahulu.</p><a class="button" href="#/devices/new">Tambah device</a></section>{/if}
      {/if}
    </main>
  </div>
{/if}

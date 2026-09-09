<script lang="ts">
  import { Switch } from 'bits-ui';
  import { api } from '../lib/api';
  import DeviceTabs from '../components/DeviceTabs.svelte';
  import type { Device } from '../lib/types';
  import { devicePath } from '../lib/routes';

  let {
    device,
    secret = '',
    ondevicechange,
  }: {
    device: Device;
    secret?: string;
    ondevicechange: (device: Device) => void;
  } = $props();
  let secretBusy = $state(false);
  let copyStatus = $state('');
  let message = $state('');
  let notice = $state('');
  let busy = $state(false);

  async function toggleDevice() {
    busy = true;
    message = '';
    try {
      const result = await api<{ device: Device }>(
        `/api/devices/${encodeURIComponent(device.id)}`,
        { method: 'PATCH', body: JSON.stringify({ active: !device.active }) },
      );
      ondevicechange(result.device);
      notice = result.device.active
        ? 'Perangkat diaktifkan.'
        : 'Perangkat dinonaktifkan.';
    } catch (error) {
      message =
        error instanceof Error ? error.message : 'Gagal mengubah status.';
    } finally {
      busy = false;
    }
  }
  async function revealSecret() {
    secretBusy = true;
    message = '';
    try {
      const result = await api<{ secret: string }>(
        `/api/devices/${encodeURIComponent(device.id)}/secret`,
      );
      secret = result.secret;
      copyStatus = '';
    } catch (error) {
      message =
        error instanceof Error ? error.message : 'Secret tidak tersedia.';
    } finally {
      secretBusy = false;
    }
  }
  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      copyStatus = 'Secret disalin.';
    } catch {
      copyStatus = 'Salin manual dari kolom secret.';
    }
  }
</script>

<header class="page-header detail-header">
  <div>
    <a class="back-link" href="#devices">← Devices</a>
    <div class="title-status">
      <h1>{device.label}</h1>
      <span class:offline={!device.active} class="status-pill"
        >{device.active ? 'Active' : 'Inactive'}</span
      >
    </div>
    <code>{device.id}</code>
  </div>
  <div class="header-buttons">
    <label class="switch-label">
      <Switch.Root
        class="switch-root"
        checked={device.active}
        disabled={busy}
        onCheckedChange={() => void toggleDevice()}
      >
        <Switch.Thumb class="switch-thumb" />
      </Switch.Root>
      <span>{device.active ? 'Aktif' : 'Nonaktif'}</span>
    </label>
  </div>
</header>
<DeviceTabs deviceId={device.id} page="detail" />
<section
  id="device-metadata"
  class="panel metadata-panel"
  aria-labelledby="metadata-title"
>
  <div class="panel-heading">
    <div>
      <h2 id="metadata-title">Detail perangkat</h2>
      <p>Metadata perangkat terbaru.</p>
    </div>
    <a class="button secondary" href={`#${devicePath(device.id, '/edit')}`}
      >Edit device</a
    >
  </div>
  <dl class="metadata-grid">
    <div>
      <dt>Device ID</dt>
      <dd><code>{device.id}</code></dd>
    </div>
    <div>
      <dt>Status</dt>
      <dd>{device.active ? 'Active' : 'Inactive'}</dd>
    </div>
    <div>
      <dt>Dibuat</dt>
      <dd>{new Date(device.createdAt).toLocaleString('id-ID')}</dd>
    </div>
    <div>
      <dt>Diperbarui</dt>
      <dd>{new Date(device.updatedAt).toLocaleString('id-ID')}</dd>
    </div>
    <div>
      <dt>Versi kredensial</dt>
      <dd>{device.credentialVersion}</dd>
    </div>
    <div>
      <dt>Parameter</dt>
      <dd>{Object.keys(device.parameters).length}</dd>
    </div>
  </dl>
</section>
<section
  id="device-credentials"
  class="panel credentials-panel"
  aria-labelledby="credentials-title"
>
  <div>
    <h2 id="credentials-title">Kredensial perangkat</h2>
    <p>
      Gunakan Device ID dan secret untuk mengautentikasi perangkat. Secret tidak
      disimpan di browser.
    </p>
  </div>
  <button
    class="secondary"
    onclick={() => void revealSecret()}
    disabled={secretBusy}>{secretBusy ? 'Memuat…' : 'Tampilkan secret'}</button
  >
</section>
{#if secret}<section
    class="callout secret-panel"
    aria-labelledby="secret-title"
  >
    <div>
      <strong id="secret-title">Secret perangkat</strong>
      <p>Simpan dengan aman.</p>
    </div>
    <div class="secret-copy">
      <input value={secret} readonly aria-label="Secret perangkat" /><button
        onclick={() => void copySecret()}>Salin</button
      >
    </div>
    <p class="copy-status" aria-live="polite">{copyStatus}</p>
  </section>{/if}
{#if notice}<p class="toast success" role="status">
    {notice}
  </p>{/if}{#if message}<p class="toast error" role="alert">{message}</p>{/if}

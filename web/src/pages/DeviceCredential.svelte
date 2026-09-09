<script lang="ts">
  import { api } from '../lib/api';
  import DeviceTabs from '../components/DeviceTabs.svelte';
  import type { Device } from '../lib/types';
  import {
    defaultMqttHost,
    firmwareSnippet,
    PLACEHOLDER_SECRET,
  } from '../lib/firmware';

  let {
    device,
    secret = '',
  }: {
    device: Device;
    secret?: string;
  } = $props();

  let secretBusy = $state(false);
  let copyStatus = $state('');
  let message = $state('');
  let hostOverride = $state('');
  let portOverride = $state('');
  let tlsPortOverride = $state('');

  const DEFAULT_PORT = 1883;
  const DEFAULT_TLS_PORT = 8883;

  const snippet = $derived(
    firmwareSnippet(device, {
      mqttHost: hostOverride.trim() || defaultMqttHost(),
      mqttPort: Number(portOverride) || DEFAULT_PORT,
      mqttTlsPort: Number(tlsPortOverride) || DEFAULT_TLS_PORT,
      deviceSecret: secret || PLACEHOLDER_SECRET,
    }),
  );

  async function revealSecret() {
    secretBusy = true;
    message = '';
    copyStatus = '';
    try {
      const result = await api<{ secret: string }>(
        `/api/devices/${encodeURIComponent(device.id)}/secret`,
      );
      secret = result.secret;
    } catch (error) {
      message =
        error instanceof Error ? error.message : 'Secret tidak tersedia.';
    } finally {
      secretBusy = false;
    }
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      copyStatus = 'Snippet disalin ke clipboard.';
    } catch {
      copyStatus = 'Salin manual dari blok kode di bawah.';
    }
  }
</script>

<header class="page-header">
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
</header>
<DeviceTabs deviceId={device.id} page="credential" />

<section class="panel credential-panel" aria-labelledby="credential-title">
  <div class="panel-heading">
    <div>
      <h2 id="credential-title">Snippet kredensial firmware</h2>
      <p>
        Salin blok berikut ke firmware perangkat — nilai variabel sudah terisi
        sesuai perangkat ini. Secret hanya tampil setelah Anda tampilkan.
      </p>
    </div>
    <button
      class="button secondary"
      onclick={() => void revealSecret()}
      disabled={secretBusy}
      >{secretBusy
        ? 'Memuat…'
        : secret
          ? 'Sembunyikan secret'
          : 'Tampilkan secret'}</button
    >
  </div>

  <div class="snippet-options">
    <label>
      MQTT host
      <input
        placeholder={defaultMqttHost()}
        bind:value={hostOverride}
        aria-label="MQTT host override"
      />
    </label>
    <label>
      Port
      <input
        placeholder={String(DEFAULT_PORT)}
        bind:value={portOverride}
        inputmode="numeric"
        aria-label="MQTT port override"
      />
    </label>
    <label>
      Port TLS
      <input
        placeholder={String(DEFAULT_TLS_PORT)}
        bind:value={tlsPortOverride}
        inputmode="numeric"
        aria-label="MQTT TLS port override"
      />
    </label>
  </div>

  <div class="snippet-actions">
    <button onclick={() => void copySnippet()}>Salin snippet</button>
    <span class="copy-status" aria-live="polite">{copyStatus}</span>
  </div>
  <pre class="snippet-code"><code>{snippet}</code></pre>
</section>

{#if message}<p class="toast error" role="alert">{message}</p>{/if}

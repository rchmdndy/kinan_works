<script lang="ts">
  import type { Device } from '../lib/types';
  import { devicePath } from '../lib/routes';
  let { devices, busy = false }: { devices: Device[]; busy?: boolean } = $props();
</script>

<header class="page-header"><div><p class="eyebrow">WORKSPACE</p><h1>Devices</h1><p>Kelola perangkat dan lihat kondisi telemetry terbaru.</p></div><a class="button" href="#/devices/new">Tambah device</a></header>
{#if busy}
  <section class="panel empty"><div class="spinner"></div><p>Memuat perangkat…</p></section>
{:else if devices.length}
  <section class="device-grid" aria-label="Daftar perangkat">
    {#each devices as device}
      <a class="device-card" href={`#${devicePath(device.id)}`}><div class="device-card-top"><span class:inactive={!device.active} class="device-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="3"></rect><circle cx="12" cy="16" r="1"></circle><path d="M9 8h6M9 11h6"></path></svg></span><span class:offline={!device.active} class="status-pill">{device.active ? 'Active' : 'Inactive'}</span></div><div><h2>{device.label}</h2><p>{Object.keys(device.parameters).length} parameter</p></div><code>{device.id}</code><span class="card-link">Lihat detail <span aria-hidden="true">→</span></span></a>
    {/each}
  </section>
{:else}
  <section class="panel empty"><span class="empty-icon">＋</span><h2>Belum ada device</h2><p>Tambahkan perangkat pertama untuk mulai menerima telemetry.</p><a class="button" href="#/devices/new">Tambah device</a></section>
{/if}

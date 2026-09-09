<script lang="ts">
  import { api } from '../lib/api';
  import { buildExportTable } from '../lib/export-data';
  import { exportTelemetry } from '../lib/export';
  import type { Device, TelemetryPacket } from '../lib/types';

  const toLocalDateTime = (timestamp: number) => new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  let { devices }: { devices: Device[] } = $props();
  let deviceId = $state('');
  let parameterIds = $state<string[]>([]);
  let startDate = $state(toLocalDateTime(Date.now() - 24 * 60 * 60 * 1000));
  let endDate = $state(toLocalDateTime(Date.now()));
  let busy = $state(false);
  let message = $state('');
  let notice = $state('');
  let knownDevices = $state('');
  const device = () => devices.find((item) => item.id === deviceId) || null;

  $effect(() => {
    const ids = devices.map((item) => item.id).join('|');
    if (ids === knownDevices) return;
    knownDevices = ids;
    const current = device() || devices[0];
    deviceId = current?.id || '';
    parameterIds = current ? Object.keys(current.parameters) : [];
  });
  function changeDevice(id: string) { deviceId = id; parameterIds = Object.keys(devices.find((item) => item.id === id)?.parameters || {}); }
  function toggleParameter(id: string) { parameterIds = parameterIds.includes(id) ? parameterIds.filter((item) => item !== id) : [...parameterIds, id]; }
  async function exportReport() {
    const selected = device();
    if (!selected || !parameterIds.length) { message = 'Pilih perangkat dan minimal satu parameter.'; return; }
    const requestedDeviceId = selected.id;
    const start = new Date(startDate); const end = new Date(endDate);
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end <= start) { message = 'Rentang waktu tidak valid.'; return; }
    busy = true; message = ''; notice = '';
    try {
      const result = await api<{ device: Device; samples: TelemetryPacket[] }>(`/api/devices/${encodeURIComponent(requestedDeviceId)}/history?start=${start.getTime()}&end=${end.getTime()}&limit=500`);
      if (requestedDeviceId !== deviceId) return;
      if (result.samples.length === 500) { message = 'Ekspor dibatalkan karena mencapai batas 500 sampel dan mungkin tidak lengkap. Persempit rentang waktu.'; return; }
      const availableIds = parameterIds.filter((id) => result.device.parameters[id]);
      if (!availableIds.length) { message = 'Parameter yang dipilih tidak lagi tersedia.'; return; }
      await exportTelemetry(result.device, result.samples, start, end, availableIds);
      notice = `${buildExportTable(result.device, result.samples, start, end, availableIds).rows.length} sampel diekspor dengan metadata perangkat terbaru.`;
    } catch (error) { message = error instanceof Error ? error.message : 'Ekspor gagal.'; }
    finally { busy = false; }
  }
</script>

<header class="page-header"><div><p class="eyebrow">DATA TOOLS</p><h1>Exports</h1><p>Unduh telemetry sebagai XLSX dengan metadata dan format numerik yang tepat.</p></div></header>
{#if devices.length}
  <form class="panel export-panel" onsubmit={(event) => { event.preventDefault(); void exportReport(); }}><div class="section-heading"><span>01</span><div><h2>Pilih data</h2><p>Rentang akhir bersifat eksklusif. Maksimal 499 sampel untuk memastikan file lengkap.</p></div></div><div class="export-grid"><label>Device<select value={deviceId} onchange={(event) => changeDevice((event.currentTarget as HTMLSelectElement).value)} disabled={busy}>{#each devices as item}<option value={item.id}>{item.label}</option>{/each}</select></label><label>Mulai<input type="datetime-local" bind:value={startDate} required disabled={busy} /></label><label>Akhir (eksklusif)<input type="datetime-local" bind:value={endDate} required disabled={busy} /></label></div>{#if device()}<fieldset class="export-parameters"><legend>Parameter yang disertakan</legend>{#each Object.values(device()!.parameters) as parameter}<label><input type="checkbox" checked={parameterIds.includes(parameter.id)} onchange={() => toggleParameter(parameter.id)} disabled={busy} /><span><strong>{parameter.label}</strong><small>{parameter.id} · {parameter.unit || 'tanpa satuan'} · {parameter.points} desimal</small></span></label>{/each}</fieldset>{/if}<div class="export-note"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5m0-8h.01"></path></svg><p>File memuat sheet <strong>Data</strong> dan <strong>Informasi</strong>. Metadata terbaru diterapkan tanpa mengonversi nilai histori.</p></div>{#if notice}<p class="form-success" role="status">{notice}</p>{/if}{#if message}<p class="form-error" role="alert">{message}</p>{/if}<div class="form-actions end"><button type="submit" disabled={busy || !parameterIds.length}>{busy ? 'Menyiapkan…' : 'Unduh XLSX'}</button></div></form>
{:else}<section class="panel empty"><h2>Belum ada data untuk diekspor</h2><p>Tambahkan device terlebih dahulu.</p><a class="button" href="#/devices/new">Tambah device</a></section>
{/if}

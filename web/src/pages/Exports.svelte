<script lang="ts">
  import { Checkbox, Select } from 'bits-ui';
  import { api } from '../lib/api';
  import type { Device } from '../lib/types';
  import type { ExportJob, ExportRecord } from '../lib/export-jobs';

  const toLocalDateTime = (timestamp: number) =>
    new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  let { devices }: { devices: Device[] } = $props();
  let deviceId = $state('');
  let parameterIds = $state<string[]>([]);
  let startDate = $state(toLocalDateTime(Date.now() - 24 * 60 * 60 * 1000));
  let endDate = $state(toLocalDateTime(Date.now()));
  let busy = $state(false);
  let message = $state('');
  let notice = $state('');
  let knownDevices = $state('');
  let exports = $state<ExportRecord[]>([]);
  let activeJobId = $state('');
  const device = () => devices.find((item) => item.id === deviceId) || null;
  const deviceOptions = $derived(
    devices.map((item) => ({ value: item.id, label: item.label })),
  );
  const selectedLabel = $derived(
    deviceOptions.find((option) => option.value === deviceId)?.label ?? '',
  );

  $effect(() => {
    const ids = devices.map((item) => item.id).join('|');
    if (ids === knownDevices) return;
    knownDevices = ids;
    const current = device() || devices[0];
    deviceId = current?.id || '';
    parameterIds = current
      ? Object.values(current.parameters)
          .filter((p) => (p.type ?? 'nilai') === 'nilai')
          .map((p) => p.id)
      : [];
  });
  $effect(() => {
    void refreshExports();
  });
  function changeDevice(id: string) {
    deviceId = id;
    parameterIds = Object.values(
      devices.find((item) => item.id === id)?.parameters || {},
    )
      .filter((p) => (p.type ?? 'nilai') === 'nilai')
      .map((p) => p.id);
  }
  function toggleParameter(id: string) {
    parameterIds = parameterIds.includes(id)
      ? parameterIds.filter((item) => item !== id)
      : [...parameterIds, id];
  }
  async function refreshExports() {
    try {
      const result = await api<{ exports: ExportRecord[] }>('/api/exports');
      exports = result.exports;
    } catch {
      exports = [];
    }
  }
  async function submitExport() {
    const selected = device();
    if (!selected || !parameterIds.length) {
      message = 'Pilih perangkat dan minimal satu parameter.';
      return;
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (
      Number.isNaN(start.valueOf()) ||
      Number.isNaN(end.valueOf()) ||
      end <= start
    ) {
      message = 'Rentang waktu tidak valid.';
      return;
    }
    busy = true;
    message = '';
    notice = '';
    try {
      const result = await api<{ job: ExportJob }>('/api/exports', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: selected.id,
          parameterIds,
          start: start.getTime(),
          end: end.getTime(),
        }),
      });
      activeJobId = result.job.id;
      notice = 'Permintaan ekspor dibuat. Pekerjaan berjalan di server.';
      await refreshExports();
      void watchJob(result.job.id);
    } catch (error) {
      message = error instanceof Error ? error.message : 'Ekspor gagal.';
    } finally {
      busy = false;
    }
  }
  async function watchJob(jobId: string) {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const result = await api<{ job: ExportJob }>(
          `/api/exports/${encodeURIComponent(jobId)}`,
        );
        if (result.job.status === 'ready') {
          activeJobId = '';
          notice = `Ekspor selesai: ${result.job.rowCount ?? 0} baris.`;
          await refreshExports();
          return;
        }
        if (result.job.status === 'failed') {
          activeJobId = '';
          message = result.job.error || 'Ekspor gagal di server.';
          await refreshExports();
          return;
        }
      } catch {
        return;
      }
    }
  }
  function downloadExport(id: string) {
    window.location.href = `/api/exports/${encodeURIComponent(id)}/file`;
  }
  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString('id-ID');
  }
  function formatStatus(status: ExportRecord['status']): string {
    if (status === 'queued') return 'Antri';
    if (status === 'processing') return 'Diproses';
    if (status === 'ready') return 'Siap';
    return 'Gagal';
  }
</script>

<header class="page-header">
  <div>
    <h1>Exports</h1>
    <p>
      Pekerjaan ekspor dijalankan di server; halaman ini hanya memantau status
      dan mengunduh hasilnya.
    </p>
  </div>
</header>
{#if devices.length}
  <form
    class="panel export-panel"
    onsubmit={(event) => {
      event.preventDefault();
      void submitExport();
    }}
  >
    <div class="export-steps">
      <section>
        <div class="section-heading">
          <h2>Sumber data</h2>
          <p>Rentang akhir bersifat eksklusif; seluruh sampel diekspor.</p>
        </div>
        <div class="export-grid">
          <label
            >Device
            <Select.Root
              type="single"
              value={deviceId}
              onValueChange={(value) => value && changeDevice(value)}
              disabled={busy}
            >
              <Select.Trigger class="select-trigger">
                <Select.Value placeholder="Pilih device"
                  >{selectedLabel}</Select.Value
                >
                <svg viewBox="0 0 24 24" aria-hidden="true"
                  ><path d="M6 9l6 6 6-6"></path></svg
                >
              </Select.Trigger>
              <Select.Portal>
                <Select.Content class="select-content">
                  <Select.Viewport>
                    {#each deviceOptions as option (option.value)}
                      <Select.Item
                        value={option.value}
                        label={option.label}
                        class="select-item">{option.label}</Select.Item
                      >
                    {/each}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root></label
          ><label
            >Mulai<input
              type="datetime-local"
              bind:value={startDate}
              required
              disabled={busy}
            /></label
          ><label
            >Akhir (eksklusif)<input
              type="datetime-local"
              bind:value={endDate}
              required
              disabled={busy}
            /></label
          >
        </div>
      </section>
      {#if device()}
        <section>
          <div class="section-heading">
            <h2>Parameter yang disertakan</h2>
            <p>
              {parameterIds.length} dari {Object.values(
                device()!.parameters,
              ).filter((p) => (p.type ?? 'nilai') === 'nilai').length}
              parameter dipilih.
            </p>
          </div>
          <div class="option-grid">
            {#each Object.values(device()!.parameters).filter((p) => (p.type ?? 'nilai') === 'nilai') as parameter (parameter.id)}
              <label class="option-label">
                <Checkbox.Root
                  class="checkbox-root"
                  checked={parameterIds.includes(parameter.id)}
                  onCheckedChange={() => toggleParameter(parameter.id)}
                  disabled={busy}
                >
                  {#snippet children({ checked })}
                    {#if checked}
                      <svg
                        class="checkbox-indicator"
                        viewBox="0 0 12 12"
                        aria-hidden="true"
                        ><path
                          d="M2 6l2.5 2.5L10 3"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        ></path></svg
                      >
                    {/if}
                  {/snippet}
                </Checkbox.Root>
                <span>
                  <strong>{parameter.label}</strong>
                  <small
                    >{parameter.id} · {parameter.unit || 'tanpa satuan'} · {parameter.points}
                    desimal</small
                  >
                </span>
              </label>
            {/each}
          </div>
        </section>
      {/if}
      <div class="export-note">
        <svg viewBox="0 0 24 24" aria-hidden="true"
          ><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5m0-8h.01"
          ></path></svg
        >
        <p>
          File memuat sheet <strong>Data</strong> dan
          <strong>Informasi</strong>. Metadata terbaru diterapkan tanpa
          mengonversi nilai histori.
        </p>
      </div>
    </div>
    {#if notice}<p class="form-success" role="status">
        {notice}
      </p>{/if}{#if message}<p class="form-error" role="alert">
        {message}
      </p>{/if}
    <div class="form-actions end">
      <button type="submit" disabled={busy || !parameterIds.length}
        >{busy ? 'Mengirim…' : 'Buat ekspor'}</button
      >
    </div>
  </form>
  <section class="panel">
    <div class="section-heading">
      <h2>Riwayat ekspor</h2>
      <p>Daftar pekerjaan ekspor beserta statusnya.</p>
    </div>
    {#if exports.length}
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Rentang</th>
              <th>Status</th>
              <th>Baris</th>
              <th>Dibuat</th>
              <th>Unduh</th>
            </tr>
          </thead>
          <tbody>
            {#each exports as item (item.id)}
              <tr>
                <td>{item.deviceLabel}</td>
                <td>{formatTime(item.start)} – {formatTime(item.end)}</td>
                <td
                  >{formatStatus(item.status)}{item.id === activeJobId
                    ? ' (dipantau)'
                    : ''}</td
                >
                <td>{item.rowCount ?? '—'}</td>
                <td>{formatTime(item.createdAt)}</td>
                <td>
                  {#if item.status === 'ready'}
                    <button
                      type="button"
                      class="button small"
                      onclick={() => downloadExport(item.id)}>Unduh</button
                    >
                  {:else if item.status === 'failed'}
                    <span class="field-error">{item.error || 'Gagal'}</span>
                  {:else}—{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p>Belum ada pekerjaan ekspor.</p>
    {/if}
  </section>
{:else}<section class="panel empty">
    <h2>Belum ada data untuk diekspor</h2>
    <p>Tambahkan device terlebih dahulu.</p>
    <a class="button" href="#/devices/new">Tambah device</a>
  </section>
{/if}

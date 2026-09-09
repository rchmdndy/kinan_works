<script lang="ts">
  import { api } from '../lib/api';
  import DeviceTabs from '../components/DeviceTabs.svelte';
  import DeviceParameterForm from '../components/DeviceParameterForm.svelte';
  import { hasDeviceDraftErrors, normalizeDeviceDraft, validateDeviceDraft } from '../lib/device-form';
  import type { Device, Parameter } from '../lib/types';

  let { device, ondevicechange }: { device: Device; ondevicechange: (device: Device) => void } = $props();
  let label = $state('');
  let parameters = $state<Parameter[]>([]);
  let busy = $state(false);
  let message = $state('');
  let notice = $state('');
  let activeDeviceId = $state('');

  $effect(() => {
    if (device.id !== activeDeviceId) { activeDeviceId = device.id; label = device.label; parameters = Object.values(device.parameters).map((parameter) => ({ ...parameter })); message = ''; notice = ''; }
  });
  function addParameter() { let id: string; do id = `parameter_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`; while (parameters.some((parameter) => parameter.id === id)); parameters = [...parameters, { id, label: 'Parameter baru', unit: '', points: 0 }]; }
  function removeParameter(index: number) { if (parameters.length > 1) parameters = parameters.filter((_, itemIndex) => itemIndex !== index); }
  async function saveDevice() {
    const errors = validateDeviceDraft(label, parameters);
    if (hasDeviceDraftErrors(errors)) { message = 'Periksa nama, label, satuan, dan desimal parameter.'; return; }
    busy = true; message = ''; notice = '';
    try {
      const normalized = normalizeDeviceDraft(label, parameters);
      const updated = parameters.map((parameter, index) => ({ id: parameter.id, ...normalized.parameters[index] }));
      const result = await api<{ device: Device }>(`/api/devices/${encodeURIComponent(device.id)}`, { method: 'PATCH', body: JSON.stringify({ label: normalized.label, parameters: updated }) });
      ondevicechange(result.device); label = result.device.label; parameters = Object.values(result.device.parameters).map((parameter) => ({ ...parameter })); notice = 'Perubahan tersimpan.';
    } catch (error) { message = error instanceof Error ? error.message : 'Gagal menyimpan perangkat.'; }
    finally { busy = false; }
  }
</script>

<header class="page-header detail-header"><div><a class="back-link" href="#devices">← Devices</a><div class="title-status"><h1>{device.label}</h1><span class:offline={!device.active} class="status-pill">{device.active ? 'Active' : 'Inactive'}</span></div><code>{device.id}</code></div></header>
<DeviceTabs deviceId={device.id} page="edit" />
<section id="device-editor" class="panel editor-panel"><div class="panel-heading"><div><p class="eyebrow">SETTINGS</p><h2>Konfigurasi device</h2><p>ID parameter tetap; label, satuan, dan desimal dapat diedit.</p></div><button onclick={() => void saveDevice()} disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan perubahan'}</button></div><label class="wide-field">Nama device<input bind:value={label} maxlength="100" disabled={busy} /></label><div class="table-wrap"><div class="parameter-table table-head"><span>ID</span><span>Label</span><span>Satuan</span><span>Desimal</span><span></span></div><DeviceParameterForm bind:parameters {busy} immutableIds onadd={addParameter} onremove={removeParameter} /></div></section>
{#if notice}<p class="toast success" role="status">{notice}</p>{/if}{#if message}<p class="toast error" role="alert">{message}</p>{/if}

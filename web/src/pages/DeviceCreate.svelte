<script lang="ts">
  import { api } from '../lib/api';
  import DeviceParameterForm from '../components/DeviceParameterForm.svelte';
  import {
    hasDeviceDraftErrors,
    normalizeDeviceDraft,
    validateDeviceDraft,
    type DeviceDraftErrors,
    type ParameterDraft,
  } from '../lib/device-form';
  import type { Device } from '../lib/types';
  import { goTo, devicePath } from '../lib/routes';

  const emptyErrors: DeviceDraftErrors = { parameter: [] };
  let label = $state('');
  let parameters = $state<ParameterDraft[]>([
    { type: 'nilai', label: '', unit: '', points: 1 },
  ]);
  let errors = $state<DeviceDraftErrors>(emptyErrors);
  let busy = $state(false);
  let message = $state('');
  let { oncreated }: { oncreated: (device: Device, secret: string) => void } =
    $props();

  function addParameter() {
    parameters = [
      ...parameters,
      { type: 'nilai', label: '', unit: '', points: 1 },
    ];
    errors = emptyErrors;
  }
  function removeParameter(index: number) {
    parameters = parameters.filter((_, itemIndex) => itemIndex !== index);
    errors = emptyErrors;
  }
  async function createDevice() {
    errors = validateDeviceDraft(label, parameters);
    if (hasDeviceDraftErrors(errors)) return;
    busy = true;
    message = '';
    try {
      const result = await api<{ device: Device; secret: string }>(
        '/api/devices',
        {
          method: 'POST',
          body: JSON.stringify(normalizeDeviceDraft(label, parameters)),
        },
      );
      oncreated(result.device, result.secret);
      goTo(devicePath(result.device.id));
    } catch (error) {
      message =
        error instanceof Error ? error.message : 'Gagal membuat perangkat.';
    } finally {
      busy = false;
    }
  }
</script>

<header class="page-header compact">
  <div>
    <a class="back-link" href="#devices">← Devices</a>
    <h1>Tambah device</h1>
    <p>Buat perangkat dan tentukan data yang akan dikirim.</p>
  </div>
</header>
<form
  class="panel form-panel"
  onsubmit={(event) => {
    event.preventDefault();
    void createDevice();
  }}
  novalidate
>
  <div class="section-heading">
    <div>
      <h2>Informasi perangkat</h2>
      <p>Nama ini tampil di daftar dan laporan.</p>
    </div>
  </div>
  <label class="wide-field"
    >Nama device <span aria-hidden="true">*</span><input
      bind:value={label}
      maxlength="100"
      placeholder="Contoh: Sensor ruang produksi"
      aria-invalid={Boolean(errors.label)}
      aria-describedby={errors.label ? 'create-label-error' : undefined}
      disabled={busy}
    />{#if errors.label}<small class="field-error" id="create-label-error"
        >{errors.label}</small
      >{/if}</label
  >
  <div class="form-divider"></div>
  <div class="section-heading">
    <div>
      <h2>Parameter</h2>
      <p>ID permanen dibuat oleh server setelah device disimpan.</p>
    </div>
  </div>
  <DeviceParameterForm
    bind:parameters
    {errors}
    {busy}
    onadd={addParameter}
    onremove={removeParameter}
  />
  {#if message}<p class="form-error" role="alert">{message}</p>{/if}
  <div class="form-actions">
    <a class="button secondary" href="#devices">Batal</a><button
      type="submit"
      disabled={busy}>{busy ? 'Membuat…' : 'Buat device'}</button
    >
  </div>
</form>

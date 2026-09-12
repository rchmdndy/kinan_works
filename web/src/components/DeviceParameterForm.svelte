<script lang="ts">
  import type { DeviceDraftErrors, ParameterDraft } from '../lib/device-form';
  let {
    parameters = $bindable(),
    errors,
    busy = false,
    immutableIds = false,
    onadd,
    onremove,
  }: {
    parameters: (ParameterDraft & { id?: string })[];
    errors?: DeviceDraftErrors;
    busy?: boolean;
    immutableIds?: boolean;
    onadd: () => void;
    onremove: (index: number) => void;
  } = $props();
</script>

<p>
  Default nilai untuk sensor numerik. ID dan tipe tidak dapat diubah setelah
  disimpan; firmware memakai ID yang sama.
</p>
<div class="parameter-list">
  {#each parameters as parameter, index (parameter)}
    <fieldset class="parameter-card">
      <legend>Parameter {index + 1}</legend>
      {#if immutableIds && parameter.id}<label
          >ID parameter<input value={parameter.id} readonly /></label
        >{/if}
      <div class="parameter-fields">
        <label
          >Tipe<select
            bind:value={parameter.type}
            disabled={busy || Boolean(parameter.id)}
          >
            <option value="nilai">nilai — sensor numerik</option>
            <option value="control-state"
              >control-state — sakelar boolean</option
            >
            <option value="control-setpoint"
              >control-setpoint — target numerik</option
            >
          </select></label
        >
        <label
          >Label<input
            bind:value={parameter.label}
            maxlength="100"
            disabled={busy}
          /></label
        >
        {#if parameter.type !== 'control-state'}
          <label
            >Satuan<input
              bind:value={parameter.unit}
              maxlength="32"
              disabled={busy}
            /></label
          >
          <label
            >Desimal<input
              type="number"
              min="0"
              max="10"
              step="1"
              bind:value={parameter.points}
              disabled={busy}
            /></label
          >
        {/if}
        {#if parameter.type === 'control-setpoint'}
          <label
            >Minimum<input
              type="number"
              step="any"
              bind:value={parameter.min}
              disabled={busy}
              required
            /></label
          >
          <label
            >Maksimum<input
              type="number"
              step="any"
              bind:value={parameter.max}
              disabled={busy}
              required
            /></label
          >
        {/if}
      </div>
      {#each Object.values(errors?.parameter[index] ?? {}) as error (error)}<small
          class="field-error">{error}</small
        >{/each}
      <button
        class="icon-button"
        type="button"
        aria-label={`Hapus parameter ${index + 1}`}
        onclick={() => onremove(index)}
        disabled={busy || parameters.length === 1}>×</button
      >
    </fieldset>
  {/each}
</div>
{#if errors?.parameters}<p class="field-error">{errors.parameters}</p>{/if}
<button
  class="add-row"
  type="button"
  onclick={onadd}
  disabled={busy || parameters.length >= 100}>Tambah parameter</button
>

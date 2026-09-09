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

<div class={immutableIds ? 'table-wrap' : 'parameter-list'}>
  {#each parameters as parameter, index (parameter.id ?? index)}
    {#if immutableIds}
      <div class="parameter-table" class:table-head={false}>
        <input aria-label="ID parameter" value={parameter.id} readonly />
        <input
          aria-label="Label parameter"
          bind:value={parameter.label}
          maxlength="100"
          disabled={busy}
        />
        <input
          aria-label="Satuan parameter"
          bind:value={parameter.unit}
          maxlength="32"
          disabled={busy}
        />
        <input
          aria-label="Desimal parameter"
          type="number"
          min="0"
          max="10"
          step="1"
          bind:value={parameter.points}
          disabled={busy}
        />
        <button
          class="icon-button"
          type="button"
          aria-label={`Hapus ${parameter.label}`}
          onclick={() => onremove(index)}
          disabled={busy || parameters.length === 1}>×</button
        >
      </div>
    {:else}
      <fieldset class="parameter-card">
        <legend>Parameter {index + 1}</legend>
        <div class="parameter-fields">
          <label
            >Label <span aria-hidden="true">*</span><input
              bind:value={parameter.label}
              maxlength="100"
              placeholder="Suhu"
              aria-invalid={Boolean(errors?.parameter[index]?.label)}
              disabled={busy}
            />{#if errors?.parameter[index]?.label}<small class="field-error"
                >{errors.parameter[index].label}</small
              >{/if}</label
          ><label
            >Satuan<input
              bind:value={parameter.unit}
              maxlength="32"
              placeholder="°C"
              aria-invalid={Boolean(errors?.parameter[index]?.unit)}
              disabled={busy}
            />{#if errors?.parameter[index]?.unit}<small class="field-error"
                >{errors.parameter[index].unit}</small
              >{/if}</label
          ><label
            >Desimal <span aria-hidden="true">*</span><input
              bind:value={parameter.points}
              type="number"
              min="0"
              max="10"
              step="1"
              aria-invalid={Boolean(errors?.parameter[index]?.points)}
              disabled={busy}
            />{#if errors?.parameter[index]?.points}<small class="field-error"
                >{errors.parameter[index].points}</small
              >{/if}</label
          >
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label={`Hapus parameter ${index + 1}`}
          title="Hapus parameter"
          onclick={() => onremove(index)}
          disabled={busy || parameters.length === 1}>×</button
        >
      </fieldset>
    {/if}
  {/each}
</div>
{#if errors?.parameters}<p class="field-error">{errors.parameters}</p>{/if}
<button
  class="add-row"
  type="button"
  onclick={onadd}
  disabled={busy || parameters.length >= 100}>＋ Tambah parameter</button
>

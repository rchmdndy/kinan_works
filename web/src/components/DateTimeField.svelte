<script lang="ts">
  import { HOURS, MINUTES, type DateTimeParts } from '../lib/export-range';

  let {
    label,
    value = $bindable(),
    error = '',
    max,
    min,
    disabled = false,
  }: {
    label: string;
    value: DateTimeParts;
    error?: string;
    max?: string;
    min?: string;
    disabled?: boolean;
  } = $props();
  const errorId = $props.id();
  const invalid = $derived(error ? 'true' : undefined);
</script>

<fieldset class="datetime-field" {disabled}>
  <legend>{label} <small>(24 jam)</small></legend>
  <input
    type="date"
    aria-label={`Tanggal ${label.toLowerCase()}`}
    aria-invalid={invalid}
    aria-describedby={error ? errorId : undefined}
    bind:value={value.date}
    {max}
    {min}
    required
  />
  <div class="time-24h">
    <select
      aria-label={`Jam ${label.toLowerCase()}`}
      aria-invalid={invalid}
      aria-describedby={error ? errorId : undefined}
      bind:value={value.hour}
    >
      {#each HOURS as hour (hour)}<option value={hour}>{hour}</option>{/each}
    </select>
    <span aria-hidden="true">:</span>
    <select
      aria-label={`Menit ${label.toLowerCase()}`}
      aria-invalid={invalid}
      aria-describedby={error ? errorId : undefined}
      bind:value={value.minute}
    >
      {#each MINUTES as minute (minute)}<option value={minute}>{minute}</option
        >{/each}
    </select>
  </div>
  {#if error}<small class="field-error" id={errorId} role="alert">{error}</small
    >{/if}
</fieldset>

<style>
  .datetime-field {
    display: grid;
    gap: 6px;
    border: 0;
    padding: 0;
    margin: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 6px;
    color: #33415a;
    font-size: 0.85rem;
    font-weight: 500;
  }
  legend small {
    color: var(--muted);
    font-weight: 400;
  }
  .time-24h {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 6px;
  }
  .time-24h span {
    color: var(--muted);
    font-weight: 600;
  }
  select[aria-invalid='true'] {
    border-color: var(--red);
  }
</style>

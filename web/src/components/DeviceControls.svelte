<script lang="ts">
  import { api } from '../lib/api';
  import { Switch } from 'bits-ui';
  import { validTarget, stepTarget } from '../lib/control-input';
  import type {
    DeviceState,
    Availability,
    StoredCommand,
    CommandInput,
  } from '../../../api/src/control-contract';
  import type { Device } from '../lib/types';
  let { device }: { device: Device } = $props();
  const controls = $derived(
    Object.values(device.parameters).filter(
      (p) => p.type === 'control-state' || p.type === 'control-setpoint',
    ),
  );
  const actual = (id: string) =>
    snapshot?.state?.parameters.find((p) => p.id === id)?.value;
  type Snapshot = {
    state: DeviceState | null;
    availability: Availability | null;
    online: boolean;
    commands: StoredCommand[];
  };
  let snapshot = $state.raw<Snapshot | null>(null);
  let connected = $state(false);
  let busy = $state(false);
  let message = $state('');
  let drafts = $state<Record<string, string>>({});
  let unresolved = $state<CommandInput | null>(null);
  const canSend = $derived(
    device.active &&
      connected &&
      snapshot?.online &&
      !busy &&
      !unresolved &&
      !snapshot.commands.some(
        (c) =>
          c.status === 'pending' ||
          (c.status === 'unknown' &&
            snapshot?.state?.connectionId === c.connectionId &&
            (snapshot?.state?.timestamp ?? 0) <= c.expiresAt),
      ),
  );
  $effect(() => {
    const source = new EventSource(
      `/api/devices/${encodeURIComponent(device.id)}/control/events`,
      { withCredentials: true },
    );
    snapshot = null;
    connected = false;
    unresolved = null;
    source.addEventListener('control', (event) => {
      try {
        snapshot = JSON.parse((event as MessageEvent).data);
        connected = true;
      } catch {
        connected = false;
      }
    });
    source.onerror = () => {
      connected = false;
    };
    return () => source.close();
  });
  async function send(input: CommandInput) {
    busy = true;
    unresolved = input;
    message = '';
    try {
      const { command } = await api<{ command: StoredCommand }>(
        `/api/devices/${device.id}/commands`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      message = `Perintah ${command.commandId}: ${command.status}. Tunggu hasil perangkat, bukan konfirmasi broker.`;
      unresolved = null;
    } catch (error) {
      message = `${error instanceof Error ? error.message : 'Permintaan gagal'}. Hasil mungkin belum diketahui. Periksa riwayat atau periksa ulang ID yang sama.`;
    } finally {
      busy = false;
    }
  }
  function issue(parameterId: string, value: CommandInput['value']) {
    if (!canSend) return;
    void send({ commandId: crypto.randomUUID(), parameterId, value });
  }
</script>

<section class="control-panel" aria-label="Kontrol perangkat">
  <div class="panel-heading">
    <div>
      <h2>Kontrol perangkat</h2>
      <p>
        Nilai aktual berasal dari perangkat. Perintah tidak disimpan untuk
        perangkat offline.
      </p>
    </div>
    <span class="status-pill" class:offline={!canSend}
      >{connected && snapshot?.online
        ? 'Online'
        : 'Offline / belum terverifikasi'}</span
    >
  </div>
  {#if !controls.length}<p>
      Belum ada parameter kontrol di dashboard. Hubungkan simulator atau
      perangkat dengan protokol kontrol.
    </p>{/if}
  <div class="metric-grid control-grid">
    {#each controls as actuator (actuator.id)}
      {@const value = actual(actuator.id)}
      {@const disabled = !canSend || value === undefined}
      {@const draft = drafts[actuator.id] ?? ''}
      <article class="metric-card control-card" aria-label={actuator.label}>
        <header>
          <h3>{actuator.label}</h3>
          <p>
            Aktual: <b
              >{value === undefined
                ? 'Belum dilaporkan'
                : actuator.type === 'control-state'
                  ? value
                    ? 'Nyala'
                    : 'Mati'
                  : String(value)}</b
            >{actuator.type === 'control-setpoint' ? ` ${actuator.unit}` : ''}
          </p>
        </header>
        {#if actuator.type === 'control-state'}
          <div class="state-input">
            <Switch.Root
              class="control-switch"
              aria-label={`Ubah ${actuator.label}`}
              bind:checked={
                () => actual(actuator.id) === true,
                (checked) => issue(actuator.id, checked)
              }
              {disabled}
            >
              <Switch.Thumb class="control-switch-thumb" />
            </Switch.Root>
            <span class="state-label" class:disabled
              >{value === undefined
                ? 'Menunggu perangkat'
                : value
                  ? 'Nyala'
                  : 'Mati'}</span
            >
          </div>
        {:else}
          <div class="control-input">
            <label for={`control-${actuator.id}`}
              >Target ({actuator.min}–{actuator.max} {actuator.unit})</label
            >
            <div class="stepper">
              <button
                class="button secondary step-button"
                aria-label={`Kurangi ${actuator.label}`}
                disabled={disabled ||
                  stepTarget(draft, value, actuator, -1) === null ||
                  Number(draft === '' ? value : draft) <= actuator.min!}
                onclick={() => {
                  const next = stepTarget(draft, value, actuator, -1);
                  if (next !== null) drafts[actuator.id] = next;
                }}>−</button
              >
              <input
                id={`control-${actuator.id}`}
                type="number"
                min={actuator.min}
                max={actuator.max}
                step={10 ** -actuator.points}
                value={draft}
                oninput={(event) =>
                  (drafts[actuator.id] = event.currentTarget.value)}
                aria-invalid={draft !== '' && !validTarget(draft, actuator)}
                aria-describedby={`hint-${actuator.id}`}
                {disabled}
              />
              <button
                class="button secondary step-button"
                aria-label={`Tambah ${actuator.label}`}
                disabled={disabled ||
                  stepTarget(draft, value, actuator, 1) === null ||
                  Number(draft === '' ? value : draft) >= actuator.max!}
                onclick={() => {
                  const next = stepTarget(draft, value, actuator, 1);
                  if (next !== null) drafts[actuator.id] = next;
                }}>+</button
              >
            </div>
            <p
              id={`hint-${actuator.id}`}
              class:invalid={draft !== '' && !validTarget(draft, actuator)}
            >
              {draft !== '' && !validTarget(draft, actuator)
                ? `Masukkan angka antara ${actuator.min} dan ${actuator.max}.`
                : 'Ubah target, lalu kirim untuk menerapkan.'}
            </p>
            <button
              class="button secondary"
              disabled={disabled || !validTarget(draft, actuator)}
              onclick={() => {
                if (validTarget(draft, actuator))
                  issue(actuator.id, Number(draft));
              }}>Kirim target</button
            >
          </div>
        {/if}
      </article>
    {/each}
  </div>
  <div class="panel control-history">
    {#if snapshot?.state}<p class="control-note">
        State aktual: {new Date(snapshot.state.timestamp).toLocaleString(
          'id-ID',
        )}
        · revisi {snapshot.state.revision}
      </p>{/if}
    {#if message}<p role="status">{message}</p>{/if}
    {#if unresolved}<button
        class="button secondary"
        disabled={busy || !connected}
        onclick={() => unresolved && send(unresolved)}
        >Periksa ulang ID yang sama</button
      >{/if}
    <h3>Perintah terakhir</h3>
    <p class="control-note">
      Pending berarti menunggu hasil. Unknown berarti perangkat mungkin sudah
      menjalankan perintah. Jangan menganggap timeout sebagai kegagalan
      eksekusi.
    </p>
    <ul>
      {#each snapshot?.commands.slice(0, 10) ?? [] as command (command.commandId)}<li
        >
          <strong>{command.parameterId}: {String(command.value)}</strong> — {command.status}{command.reason
            ? ` (${command.reason})`
            : ''}<small
            >{new Date(command.timestamp).toLocaleString('id-ID')} · {command.commandId}</small
          >
        </li>{/each}
    </ul>
  </div>
</section>

<style>
  .control-panel {
    margin-block: 1.5rem;
  }
  .control-grid {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr));
  }
  .control-card {
    justify-content: flex-start;
    gap: 20px;
    padding: 20px;
  }
  .control-card h3 {
    margin: 0 0 8px;
    font-size: 0.95rem;
    overflow-wrap: anywhere;
  }
  .control-card p,
  .control-note {
    margin: 0;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .control-card .state-input {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
  }
  /* Bits UI renders a button; override the app's generic button geometry. */
  .state-input :global(.control-switch) {
    position: relative;
    display: inline-flex;
    flex: 0 0 44px;
    align-items: center;
    justify-content: flex-start;
    width: 44px;
    min-width: 44px;
    height: 24px;
    min-height: 24px;
    gap: 0;
    padding: 2px;
    border: 0;
    border-radius: 999px;
    background: #e5e7eb;
    appearance: none;
    transition: background-color 150ms ease;
  }
  .state-input :global(.control-switch:hover:not(:disabled)) {
    background: #d1d5db;
  }
  .state-input :global(.control-switch[data-state='checked']) {
    background: #2563eb;
  }
  .state-input
    :global(.control-switch[data-state='checked']:hover:not(:disabled)) {
    background: #1d4ed8;
  }
  .state-input :global(.control-switch:focus-visible) {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
    box-shadow: 0 0 0 4px #dbeafe;
  }
  .state-input :global(.control-switch:disabled) {
    cursor: not-allowed;
    opacity: 0.5;
  }
  .state-input :global(.control-switch-thumb) {
    display: block;
    flex: 0 0 20px;
    width: 20px;
    height: 20px;
    border: 1px solid #d1d5db;
    border-radius: 50%;
    background: #fff;
    transform: translateX(0);
    transition:
      transform 150ms ease,
      border-color 150ms ease;
  }
  .state-input
    :global(.control-switch[data-state='checked'] .control-switch-thumb) {
    border-color: #fff;
    transform: translateX(20px);
  }
  .state-input .state-label {
    min-width: 0;
    color: var(--ink);
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.4;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .state-label.disabled {
    color: var(--muted);
  }
  @media (prefers-reduced-motion: reduce) {
    .state-input :global(.control-switch),
    .state-input :global(.control-switch-thumb) {
      transition: none;
    }
  }
  .control-card .control-input {
    display: grid;
    gap: 10px;
  }
  .control-input label {
    font-size: 0.8rem;
  }
  .stepper {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) 44px;
    gap: 8px;
  }
  .step-button {
    min-height: 44px;
    padding: 0;
    font-size: 1.25rem;
  }
  input {
    width: 100%;
    min-width: 0;
    min-height: 44px;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    text-align: center;
    appearance: textfield;
  }
  input::-webkit-inner-spin-button,
  input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  input[aria-invalid='true'] {
    border-color: var(--red);
  }
  .control-input .invalid {
    color: var(--red);
  }
  .control-history {
    padding: 20px;
  }
  .control-history h3 {
    margin-block: 16px 8px;
  }
  .control-history ul {
    margin-bottom: 0;
    padding-left: 20px;
  }
  small {
    display: block;
    overflow-wrap: anywhere;
    color: var(--muted);
  }
  li {
    padding-block: 8px;
    overflow-wrap: anywhere;
  }
  @media (max-width: 640px) {
    .control-card,
    .control-history {
      padding: 16px;
    }
  }
</style>

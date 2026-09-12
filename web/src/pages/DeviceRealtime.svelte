<script lang="ts">
  import { onDestroy } from 'svelte';
  import DeviceTabs from '../components/DeviceTabs.svelte';
  import DeviceControls from '../components/DeviceControls.svelte';
  import { drawChart, updateChart } from '../lib/chart';
  import {
    connectTelemetryEvents,
    mergeTelemetrySamples,
    type TelemetryConnectionState,
  } from '../lib/telemetry';
  import { formatReading } from '../lib/export-data';
  import type { Device, TelemetryPacket } from '../lib/types';

  let { device }: { device: Device } = $props();
  let latest = $state<TelemetryPacket | null>(null);
  let history = $state<TelemetryPacket[]>([]);
  let selectedParameters = $state<string[]>([]);
  let canvas: HTMLCanvasElement;
  let chart: ReturnType<typeof drawChart> | null = null;
  let unsubscribe: (() => void) | null = null;
  let telemetryState = $state<TelemetryConnectionState>('connecting');
  let message = $state('');
  let now = $state(Date.now());
  let activeId = $state('');
  let generation = $state(0);
  let interval: ReturnType<typeof setInterval> | null = null;
  const stale = () => !latest || now - latest.timestamp > 2 * 60 * 1000;
  const unavailable = () => telemetryState !== 'open' || stale();
  const status = () =>
    telemetryState === 'error'
      ? 'Koneksi realtime terputus'
      : telemetryState === 'connecting'
        ? 'Menghubungkan realtime'
        : stale()
          ? 'Menunggu data terbaru'
          : 'Telemetry terhubung';

  function renderChart() {
    if (!canvas) return;
    if (!chart) {
      chart = drawChart(canvas, device, history, selectedParameters);
      return;
    }
    updateChart(chart, device, history, selectedParameters);
  }
  function reset() {
    generation += 1;
    unsubscribe?.();
    unsubscribe = null;
    chart?.destroy();
    chart = null;
    latest = null;
    history = [];
    telemetryState = 'connecting';
  }
  function start() {
    reset();
    activeId = device.id;
    selectedParameters = Object.values(device.parameters)
      .filter((p) => (p.type ?? 'nilai') === 'nilai')
      .map((p) => p.id);
    const current = generation;
    const isCurrent = () => current === generation && activeId === device.id;
    unsubscribe = connectTelemetryEvents(device.id, {
      snapshot(snapshot) {
        if (!isCurrent()) return;
        history = snapshot.last10;
        latest = snapshot.latest ?? history.at(-1) ?? null;
        message = '';
        setTimeout(() => {
          if (isCurrent()) renderChart();
        });
      },
      telemetry(packet) {
        if (!isCurrent()) return;
        history = mergeTelemetrySamples(history, [packet], 10);
        if (!latest || packet.timestamp >= latest.timestamp) latest = packet;
        message = '';
        setTimeout(() => {
          if (isCurrent()) renderChart();
        });
      },
      state(next) {
        if (!isCurrent()) return;
        telemetryState = next;
        if (next === 'open') message = '';
        else if (next === 'error')
          message = 'Koneksi realtime terputus. Mencoba menghubungkan kembali…';
      },
      malformed() {
        if (isCurrent())
          message = 'Server mengirim data realtime yang tidak valid.';
      },
    });
  }
  function toggleParameter(id: string) {
    selectedParameters = selectedParameters.includes(id)
      ? selectedParameters.filter((item) => item !== id)
      : [...selectedParameters, id];
    chart?.destroy();
    chart = null;
    renderChart();
  }
  function readingValue(id: string) {
    const reading = latest?.values[id];
    return reading?.status === 'ok' ? reading.value : null;
  }
  function readingError(id: string) {
    const reading = latest?.values[id];
    return reading?.status === 'error' ? reading.error : null;
  }
  $effect(() => {
    if (device.id !== activeId) start();
  });
  onDestroy(() => {
    reset();
    if (interval) clearInterval(interval);
  });
  $effect(() => {
    interval = setInterval(() => (now = Date.now()), 15_000);
    return () => {
      if (interval) clearInterval(interval);
      interval = null;
    };
  });
</script>

<header class="page-header detail-header">
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
<DeviceTabs deviceId={device.id} page="realtime" />
<DeviceControls {device} />
<section id="realtime-summary" class="summary-bar">
  <div>
    <span class:offline={unavailable()} class="live-dot"></span><span
      ><strong>{status()}</strong><small
        >{latest
          ? `Pembaruan ${new Date(latest.timestamp).toLocaleString('id-ID')}`
          : 'Belum ada data'}</small
      ></span
    >
  </div>
  <a href="#exports">Ekspor data</a>
</section>
<section
  id="latest-values"
  class="metric-grid"
  aria-label="Nilai parameter terbaru"
>
  {#each Object.values(device.parameters).filter((p) => (p.type ?? 'nilai') === 'nilai') as parameter (parameter.id)}<article
      class="metric-card"
    >
      <div>
        <span>{parameter.label}</span>
      </div>
      {#if readingValue(parameter.id) !== null}<strong
          >{formatReading(
            readingValue(parameter.id)!,
            parameter.points,
          )}{#if parameter.unit}<small class="metric-unit"
              >{parameter.unit}</small
            >{/if}</strong
        >{:else}<strong>—</strong>{#if readingError(parameter.id)}<small
            class="reading-error">Error: {readingError(parameter.id)}</small
          >{:else}<small>Belum ada nilai</small>{/if}{/if}<time
        datetime={latest ? new Date(latest.timestamp).toISOString() : undefined}
        >{latest
          ? new Date(latest.timestamp).toLocaleString('id-ID')
          : 'Belum ada timestamp'}</time
      >
    </article>{/each}
</section>
<section id="realtime-chart" class="panel chart-panel">
  <div class="panel-heading">
    <div>
      <h2>Riwayat telemetry realtime</h2>
      <p>
        10 sampel history terakhir, berurutan berdasarkan timestamp. Data error
        tetap kosong.
      </p>
    </div>
  </div>
  <fieldset class="parameter-selector">
    <legend>Parameter grafik</legend
    >{#each Object.values(device.parameters).filter((p) => (p.type ?? 'nilai') === 'nilai') as parameter (parameter.id)}<label
        ><input
          type="checkbox"
          checked={selectedParameters.includes(parameter.id)}
          onchange={() => toggleParameter(parameter.id)}
        />{parameter.label}</label
      >{/each}
  </fieldset>
  <div class="chart"><canvas bind:this={canvas}></canvas></div>
</section>
{#if message}<p class="toast error" role="alert">{message}</p>{/if}

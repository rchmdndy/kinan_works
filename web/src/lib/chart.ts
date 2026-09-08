import { Chart, type ChartConfiguration } from 'chart.js/auto';
import type { Device, TelemetryPacket } from './types';

export function drawChart(canvas: HTMLCanvasElement, device: Device, samples: TelemetryPacket[], parameterIds: string[]): Chart {
  const labels = samples.map((sample) => new Date(sample.timestamp).toLocaleString());
  const datasets = parameterIds.filter((id) => device.parameters[id]).map((id) => {
    const parameter = device.parameters[id];
    return {
      label: `${parameter.label} (${parameter.unit})`,
      data: samples.map((sample) => sample.values[id]?.status === 'ok' ? sample.values[id].value : null),
      spanGaps: false,
      borderWidth: 2,
      tension: 0.25
    };
  });
  const config: ChartConfiguration<'line'> = { type: 'line', data: { labels, datasets }, options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: false } } } };
  return new Chart(canvas, config);
}

import { Chart, type ChartConfiguration } from 'chart.js/auto';
import type { Device, TelemetryPacket } from './types';

function sampleData(
  samples: TelemetryPacket[],
  id: string,
): (number | null)[] {
  return samples.map((sample) =>
    sample.values[id]?.status === 'ok' ? sample.values[id].value : null,
  );
}

export function drawChart(
  canvas: HTMLCanvasElement,
  device: Device,
  samples: TelemetryPacket[],
  parameterIds: string[],
): Chart {
  const labels = samples.map((sample) =>
    new Date(sample.timestamp).toLocaleString(),
  );
  const datasets = parameterIds
    .filter((id) => device.parameters[id])
    .map((id) => {
      const parameter = device.parameters[id];
      return {
        label: `${parameter.label} (${parameter.unit})`,
        data: sampleData(samples, id),
        spanGaps: false,
        borderWidth: 2,
        tension: 0.25,
      };
    });
  const config: ChartConfiguration<'line'> = {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: false } },
    },
  };
  return new Chart(canvas, config);
}

// Mutates an existing chart in place so the line slides left as new samples
// arrive, instead of rebuilding the whole chart.
export function updateChart(
  chart: Chart,
  device: Device,
  samples: TelemetryPacket[],
  parameterIds: string[],
): void {
  chart.data.labels = samples.map((sample) =>
    new Date(sample.timestamp).toLocaleString(),
  );
  const activeIds = parameterIds.filter((id) => device.parameters[id]);
  chart.data.datasets.forEach((dataset, index) => {
    const id = activeIds[index];
    dataset.data = id ? sampleData(samples, id) : [];
  });
  chart.update();
}

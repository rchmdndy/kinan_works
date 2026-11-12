import {
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { Device, TelemetryPacket } from './types';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Filler,
  Tooltip,
  Legend,
);

const timestampFormatter = new Intl.DateTimeFormat();

function buildDatasets(
  device: Device,
  samples: TelemetryPacket[],
  parameterIds: string[],
) {
  return parameterIds
    .filter(
      (id) =>
        device.parameters[id] &&
        (device.parameters[id].type ?? 'nilai') === 'nilai',
    )
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
}

function sampleData(samples: TelemetryPacket[], id: string): (number | null)[] {
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
  const config: ChartConfiguration<'line'> = {
    type: 'line',
    data: {
      labels: samples.map((sample) =>
        timestampFormatter.format(sample.timestamp),
      ),
      datasets: buildDatasets(device, samples, parameterIds),
    },
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
    timestampFormatter.format(sample.timestamp),
  );
  chart.data.datasets = buildDatasets(device, samples, parameterIds);
  chart.update('none');
}

import type { Device } from './types';

export type FirmwareSnippetOptions = {
  mqttHost: string;
  mqttPort: number;
  mqttTlsPort: number;
  deviceSecret: string;
};

export function defaultMqttHost(): string {
  return typeof window === 'undefined' ? 'localhost' : window.location.hostname;
}

export const PLACEHOLDER_SECRET = 'KLIK_TAMPILKAN_SECRET_DULU';

const SEPARATOR = '#'.repeat(40);

function parameterDocs(device: Device): string {
  const parameters = Object.values(device.parameters);
  if (parameters.length === 0)
    return (
      'PARAMETER NAME : (belum ada parameter)\n' +
      'PARAMETER ID   : -\n' +
      'TYPE           : -'
    );
  return parameters
    .map(
      (parameter) =>
        `PARAMETER NAME : ${parameter.label}\n` +
        `PARAMETER ID   : ${parameter.id}\n` +
        `TYPE           : value (unit ${parameter.unit})`,
    )
    .join(`\n${SEPARATOR}\n`);
}

function exampleData(device: Device): string {
  const parameters = Object.values(device.parameters);
  const ids =
    parameters.length > 0 ? parameters.map((p) => p.id) : ['parameter_1'];
  const values = ids.map((_, index) => String(20 + index * 10)).join(', ');
  return `{\n    "data": [\n        ${values}\n    ]\n}`;
}

/**
 * Generates a copy-paste-ready C/C++ snippet for device firmware,
 * following the user's reference snippet format.
 */
export function firmwareSnippet(
  device: Device,
  options: FirmwareSnippetOptions,
): string {
  const parameters = Object.values(device.parameters);
  const valuesExample =
    parameters.length > 0
      ? parameters
          .map(
            (parameter) => `"${parameter.id}": { "status": "ok", "value": 65 }`,
          )
          .join(',\n        ')
      : '"parameter_1": { "status": "ok", "value": 65 }';

  return `/*
DEVICE LABEL    : ${device.label}
DEVICE ID       : ${device.id}
MQTT USER       : ${device.id}
MQTT TOPIC      : devices/${device.id}/${device.credentialVersion}/telemetry
MQTT QOS        : 1
${SEPARATOR}
${parameterDocs(device)}
${SEPARATOR}
EXAMPLE DATA    : ${exampleData(device)}
PAYLOAD FORMAT  : {
    "timestamp": <epoch-milliseconds>,
    "writeId": "<uuid4>",
    "credentialVersion": ${device.credentialVersion},
    "values": {
        ${valuesExample}
    }
}
*/
const char* mqtt_server = "${options.mqttHost}";
const int mqtt_port = ${options.mqttPort};
const int mqtt_secure_port = ${options.mqttTlsPort};
const char* mqtt_user = "${device.id}";
const char* mqtt_pass = "${options.deviceSecret}";
const char* mqtt_client_id = "${device.id}";

// ========================================
// MQTT TOPICS
// ========================================
// Publish topic (device -> broker)
const char* mqtt_topic_telemetry = "devices/${device.id}/${device.credentialVersion}/telemetry";

// Payload: JSON string, contoh:
// {"timestamp":1737021600000,"writeId":"<uuid4>","credentialVersion":${device.credentialVersion},"values":{${parameters.map((p) => `"${p.id}":{"status":"ok","value":65}`).join(',')}}}
`;
}

/**
 * Placeholder secret shown before the user reveals the real one.
 */
export { PLACEHOLDER_SECRET as PLACEHOLDER_SECRET_VALUE };

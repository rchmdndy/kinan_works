import type { Device } from './types';

export type FirmwareSnippetOptions = {
  mqttHost: string;
  mqttPort: number;
  mqttTlsPort: number;
  deviceSecret: string;
};

export function defaultMqttHost(): string {
  return 'mqtt.growsense.my.id';
}

export const PLACEHOLDER_SECRET = 'KLIK_TAMPILKAN_SECRET_DULU';

/** Compact protocol reference, not a complete or directly compilable sketch. */
export function firmwareSnippet(
  device: Device,
  options: FirmwareSnippetOptions,
): string {
  const parameters = Object.values(device.parameters);
  const sensors = parameters.filter((p) => (p.type ?? 'nilai') === 'nilai');
  const controls = parameters.filter(
    (p) => p.type === 'control-state' || p.type === 'control-setpoint',
  );
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const sampleValue = (p: (typeof parameters)[number]) =>
    p.type === 'control-state' ? false : (p.min ?? 0);
  const envelope = {
    credentialVersion: device.credentialVersion,
    timestamp: 1737021600000,
    connectionId: '00000000-0000-4000-8000-000000000001',
  };
  const commandId = '00000000-0000-4000-8000-000000000002';
  const target = controls[0];

  return `// REFERENSI MQTT — contoh JSON + pseudocode, bukan sketch siap kompilasi.
// DEVICE: ${device.label} (${device.id})
const char* api_origin = "https://growsense.my.id";
const char* mqtt_server = ${json(options.mqttHost)};
const int mqtt_port = ${options.mqttPort};
const int mqtt_secure_port = ${options.mqttTlsPort};
const char* mqtt_user = ${json(`${device.id}-v${device.credentialVersion}`)};
const char* mqtt_pass = ${json(options.deviceSecret)};
const char* mqtt_client_id = ${json(device.id)};
// Hubungkan melalui TLS pada port 8883 dengan verifikasi CA, bukan MQTT plaintext.
// mqtt_secure_port adalah port TLS alternatif; jangan cetak secret ke log.

PARAMETER DASHBOARD (ID immutable; label bukan key payload)
${parameters.map((p) => `${p.id} | ${p.label} | ${p.type ?? 'nilai'}${p.type === 'control-state' ? ' | boolean' : ` | unit ${p.unit}, precision ${p.points}`}${p.type === 'control-setpoint' ? ` | min ${p.min}, max ${p.max}` : ''}`).join('\n') || '(belum ada parameter)'}
// Firmware umum: petakan variabel/pin lokal ke ID di atas secara eksplisit.
// Jangan menebak pemetaan dari label atau urutan; jangan kirim sourceKey sebagai ID.
// Khusus Growth Chamber: GET /api/firmware/${device.id}/config
// dengan Authorization: Bearer <device-secret> hanya tersedia untuk profil khusus.
// Validasi schemaVersion=1, profile=growth-chamber-v1, deviceId, credentialVersion,
// kelima sourceKey/type/ID unik dan bounds; simpan mapping sourceKey -> id:
// tempSensor, rhSensor -> nilai; setpointTemp, setpointRH -> control-setpoint;
// systemRunning -> control-state. ID dari config tetap immutable, bukan nama variabel.
// revision config adalah hash metadata, BUKAN revision state (counter integer).
// Refresh config tiap 60 detik; gagal validasi/versi kredensial berubah: putus dan reconnect.
// Metadata config tidak boleh menimpa setpoint aktual, pin, atau control loop lokal.

TOPIK (semua QoS 1; arah dari sudut perangkat)
PUBLISH   devices/${device.id}/telemetry       retain=false
PUBLISH   devices/${device.id}/state           retain=true
PUBLISH   devices/${device.id}/availability    retain=true (termasuk LWT)
SUBSCRIBE devices/${device.id}/commands        QoS=1; pengirim retain=false
PUBLISH   devices/${device.id}/command-results retain=false

// Angka/UUID di contoh berikut hanya ilustrasi, bukan nilai sensor aktual.
// Runtime: timestamp=epoch MILIDETIK tersinkron; UUID baru, jangan salin konstanta contoh.

1. TELEMETRY — hanya sensor nilai, seluruh sensor perangkat ini
${json({ timestamp: envelope.timestamp, writeId: '00000000-0000-4000-8000-000000000003', credentialVersion: device.credentialVersion, values: Object.fromEntries(sensors.map((p) => [p.id, { status: 'ok', value: 0 }])) })}
// values[id] = {status:"ok", value:readSensor(id)} untuk angka finite;
// jika pembacaan gagal: {status:"error", error:"Sensor reading unavailable"} tanpa value.
// writeId=UUID baru per sampel; gunakan writeId yang sama saat retry sampel itu.
// Tidak ada control-state/control-setpoint di telemetry; tidak ada array data legacy.

2. STATE — SEMUA control-state dan control-setpoint, nilai aktual lokal
${json({ ...envelope, revision: 0, parameters: controls.map((p) => ({ id: p.id, value: sampleValue(p) })) })}
// parameters = semua kontrol dengan readActualLocalValue(id), bukan desired value dari UI.
// Boolean untuk control-state; angka finite dalam min/max dashboard untuk control-setpoint.
// Sensor nilai tidak masuk state. Tanpa kontrol: parameters=[].
// revision mulai 0 tiap koneksi; naik setelah perubahan lokal atau command diterapkan.
// Jangan naik hanya karena heartbeat. Publish snapshot lengkap setelah command dan berkala.

3. AVAILABILITY — heartbeat online + Last Will offline
${json({ ...envelope, online: true })}
// SEBELUM CONNECT: connectionId=UUID baru; revision=0; kosongkan cache dedup sesi.
// Pasang LWT dengan envelope sesi yang sama, online=false, QoS=1, retain=true.
// Timestamp LWT dibuat saat pemasangan will, bukan ditebak saat broker menerbitkannya.
// Setelah CONNECT dan SUBSCRIBE berhasil: publish online=true dan state.
// Growth Chamber: online + state + telemetry tiap 10 detik; freshness backend 45 detik.
// Disconnect terencana: publish online=false sebelum disconnect bila memungkinkan.

4. COMMANDS — terima dari backend, jangan publish command dari firmware
${json({ commandId, parameterId: target?.id ?? '<ID-kontrol-dashboard>', value: target ? sampleValue(target) : false, ...envelope, expiresAt: envelope.timestamp + 10000, revision: 0 })}
${target ? '// Target contoh adalah kontrol pertama; handler wajib mendukung SEMUA ID kontrol di atas.' : '// Tidak ada kontrol pada perangkat ini: contoh bentuk saja, jangan eksekusi target placeholder.'}
// Pseudocode handler (di luar callback MQTT; publish QoS 1 dapat memanggil poll):
//   parse + validasi bentuk; abaikan malformed/retained command.
//   jika commandId sudah diproses dalam sesi: jangan eksekusi ulang (adapter: cache 32 ID).
//   cek credentialVersion, connectionId, revision == sesi/state lokal saat ini.
//   cek expiresAt > nowMs(), timestamp <= nowMs()+5000; TTL backend 10 detik.
//   cek parameterId adalah kontrol dikenal, tipe value tepat, angka finite dan bounds.
//   cache commandId; jika tidak valid: rejected + reason, tanpa mengubah kontrol.
//   jika valid: terapkan ke variabel kontrol lokal; revision++; lalu succeeded.
//   publish command-results lalu state aktual lengkap, termasuk setelah rejection.
// Growth Chamber mengubah setpointTemp/setpointRH/systemRunning; output tetap diterapkan
// oleh control loop asli. succeeded bukan bukti suhu/RH fisik sudah mencapai target.

5. COMMAND-RESULTS — hanya sesudah validasi / penerapan, bukan saat paket diterima
${json({ ...envelope, commandId, status: 'succeeded' })}
// Jika ditolak: status="rejected", tambahkan reason (maksimum 200 karakter).
// Envelope memakai sesi/kredensial lokal; commandId harus sama dengan command.
// timestamp hasil = nowMs(), tidak boleh mendahului timestamp command.
// Tidak ada revision, parameterId atau value di result; feedback aktual ada di state.
// Backend mencocokkan sesi/kredensial dan command pending; hasil lama dapat diabaikan.
// Tidak ada ACK bukan sukses/gagal pasti: backend dapat menandai unknown; jangan
// mengeksekusi ulang otomatis dengan ID baru. Jangan mengiklankan capabilities.
`;
}

export { PLACEHOLDER_SECRET as PLACEHOLDER_SECRET_VALUE };

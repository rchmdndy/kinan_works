#include <FS.h>           // Must be on top
#include <SPI.h>
#include <TFT_eSPI.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>
#include <Fuzzy.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <WiFiManager.h>
#include <WiFiClientSecure.h>
#include <ArduinoMqttClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include <sys/time.h>

#include "secrets.h"   // Copy secrets.example.h -> secrets.h and fill it in
#include "root_ca.h"

// ============================================================
// KONFIGURASI PLATFORM & HARDWARE
// ============================================================
// Parameter IDs from the GrowSense dashboard (Device -> Parameters).
const char* PARAM_TEMP     = "parameter_1";  // telemetry: temperature
const char* PARAM_RH       = "parameter_2";  // telemetry: humidity
const char* PARAM_SET_TEMP = "parameter_3";  // control: temperature setpoint
const char* PARAM_SET_RH   = "parameter_4";  // control: humidity setpoint

// Must match min/max of parameter_3 and parameter_4 in the dashboard.
const float SET_TEMP_MIN = 15.0, SET_TEMP_MAX = 40.0;
const float SET_RH_MIN   = 30.0, SET_RH_MAX   = 100.0;

const unsigned long CYCLE_MS      = 10000;  // sensor read, control and publish cycle
const unsigned long MQTT_RETRY_MS = 10000;  // wait between failed MQTT connects
const uint64_t MIN_VALID_EPOCH_MS = 1700000000000ULL;  // NTP has synced past Nov 2023

#define PIN_RPWM 25
#define PIN_LPWM 26
#define PIN_RELAY 32

// ============================================================
// GLOBAL OBJECTS & STATE
// ============================================================
TFT_eSPI tft = TFT_eSPI();
Adafruit_SHT31 sht31 = Adafruit_SHT31();
Fuzzy *fuzzy = new Fuzzy();
WiFiClientSecure espClient;
MqttClient mqtt(espClient);
WiFiManager wm;

float tempSensor = NAN, rhSensor = NAN;  // NAN = no valid reading
float setpointTemp = 23.0, setpointRH = 60.0;
bool systemRunning = false;
bool isConnectingUI = false; // Flag status connecting

// Protocol Session & Deduplication State
String currentConnectionId = "";
uint32_t stateRevision = 0;
String processedCommandIds[32];
int cmdCacheIndex = 0;
unsigned long lastMqttAttempt = 0;

// Commands are queued by the MQTT callback and handled in loop(), because a
// QoS 1 publish polls the client and must never run inside its own callback.
const int COMMAND_QUEUE_SIZE = 4;
String commandQueue[COMMAND_QUEUE_SIZE];
int commandQueueHead = 0, commandQueueCount = 0;

int keyboardState = 0; // 0: Main, 1: Edit Temp, 2: Edit RH
String inputBuffer = "";

// Prototypes
void drawMainScreen();
void drawKeypadUI(String title);
void updateDynamicValues();
void handleTouch();
void initFuzzy();
void setPeltierPower(int val);
void readSensors();
void initMQTT();
void connectMQTT();
void publishTelemetry();
void publishState();
void publishAvailability(bool online);
void publishCommandResult(const String& cmdId, const char* reason);
void onMqttMessage(int size);
void processCommands();
String generateUUID();
uint64_t getEpochMillis();

// ============================================================
// HELPER FUNCTIONS (UUID & TIMESTAMP)
// ============================================================
String generateUUID() {
  uint8_t b[16];
  esp_fill_random(b, sizeof(b));
  b[6] = (b[6] & 0x0F) | 0x40;  // version 4
  b[8] = (b[8] & 0x3F) | 0x80;  // RFC 4122 variant
  char uuid[37];
  snprintf(uuid, sizeof(uuid),
           "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
           b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
  return String(uuid);
}

uint64_t getEpochMillis() {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return ((uint64_t)tv.tv_sec * 1000ULL) + ((uint64_t)tv.tv_usec / 1000ULL);
}

bool timeSynced() {
  return getEpochMillis() >= MIN_VALID_EPOCH_MS;
}

// ============================================================
// LOGIKA FUZZY MAMDANI
// ============================================================
void initFuzzy() {
  FuzzyInput *errTemp = new FuzzyInput(1);
  FuzzySet *tDingin = new FuzzySet(-10, -10, -1.0, 0);
  FuzzySet *tNormal = new FuzzySet(-0.2, 0, 0, 0.2);
  FuzzySet *tPanas  = new FuzzySet(0.2, 1.5, 10.0, 10.0);
  errTemp->addFuzzySet(tDingin); errTemp->addFuzzySet(tNormal); errTemp->addFuzzySet(tPanas);
  fuzzy->addFuzzyInput(errTemp);

  FuzzyOutput *peltier = new FuzzyOutput(1);
  FuzzySet *pHeat = new FuzzySet(-255, -255, -255, 0);
  FuzzySet *pOff  = new FuzzySet(-1, 0, 0, 1);
  FuzzySet *pCool = new FuzzySet(120, 255, 255, 255);
  peltier->addFuzzySet(pHeat); peltier->addFuzzySet(pOff); peltier->addFuzzySet(pCool);
  fuzzy->addFuzzyOutput(peltier);

  auto addRule = [&](int id, FuzzySet* in, FuzzySet* out) {
    FuzzyRuleAntecedent *ant = new FuzzyRuleAntecedent(); ant->joinSingle(in);
    FuzzyRuleConsequent *con = new FuzzyRuleConsequent(); con->addOutput(out);
    fuzzy->addFuzzyRule(new FuzzyRule(id, ant, con));
  };

  addRule(1, tPanas, pCool);
  addRule(2, tNormal, pOff);
  addRule(3, tDingin, pHeat);
}

void setPeltierPower(int val) {
  val = constrain(val, -255, 255);
  if (val > 0) {
    ledcWrite(PIN_RPWM, val);
    ledcWrite(PIN_LPWM, 0);
  } else if (val < 0) {
    ledcWrite(PIN_RPWM, 0);
    ledcWrite(PIN_LPWM, abs(val));
  } else {
    ledcWrite(PIN_RPWM, 0);
    ledcWrite(PIN_LPWM, 0);
  }
}

// A failed read clears the values: telemetry then reports an error instead of
// repeating the last good reading, and the control loop switches outputs off.
void readSensors() {
  float t = sht31.readTemperature();
  float h = sht31.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println("SHT31 read failed");
    tempSensor = NAN;
    rhSensor = NAN;
  } else {
    tempSensor = t;
    rhSensor = h;
  }
}

// ============================================================
// PROTOKOL MQTT PLATFORM V1
// ============================================================
String topic(const char* suffix) {
  return String("devices/") + DEVICE_ID + "/" + suffix;
}

void addEnvelope(JsonDocument& doc) {
  doc["credentialVersion"] = CREDENTIAL_VERSION;
  doc["timestamp"]         = getEpochMillis();
  doc["connectionId"]      = currentConnectionId;
}

// QoS 1: returns true only after the broker acknowledged the message (PUBACK).
bool mqttPublish(const char* suffix, JsonDocument& doc, bool retained) {
  if (!mqtt.connected()) return false;
  String payload;
  serializeJson(doc, payload);
  if (!mqtt.beginMessage(topic(suffix), payload.length(), retained, 1)) return false;
  mqtt.print(payload);
  if (mqtt.endMessage() == 1) return true;
  Serial.print("Publish not acknowledged: ");
  Serial.println(suffix);
  return false;
}

void initMQTT() {
  espClient.setCACert(ROOT_CA);       // Verify the broker certificate (no setInsecure)
  espClient.setHandshakeTimeout(10);  // seconds
  mqtt.setId(DEVICE_ID);
  mqtt.setUsernamePassword(String(DEVICE_ID) + "-v" + String(CREDENTIAL_VERSION), DEVICE_SECRET);
  mqtt.setConnectionTimeout(5000);    // also the PUBACK wait per QoS 1 publish
  mqtt.onMessage(onMqttMessage);
}

void connectMQTT() {
  if (lastMqttAttempt != 0 && millis() - lastMqttAttempt < MQTT_RETRY_MS) return;
  lastMqttAttempt = millis();

  // The platform drops messages whose timestamps are far off, so wait for NTP.
  if (!timeSynced()) {
    Serial.println("Waiting for NTP time before connecting MQTT...");
    return;
  }

  // Generate ID Sesi Koneksi Baru
  currentConnectionId = generateUUID();
  stateRevision = 0;
  for (int i = 0; i < 32; i++) processedCommandIds[i] = "";
  commandQueueCount = 0;

  // Last Will and Testament (LWT)
  JsonDocument lwtDoc;
  addEnvelope(lwtDoc);
  lwtDoc["online"] = false;
  String lwt;
  serializeJson(lwtDoc, lwt);
  mqtt.beginWill(topic("availability"), lwt.length(), true, 1);
  mqtt.print(lwt);
  mqtt.endWill();

  Serial.print("Connecting to MQTT Platform...");
  if (!mqtt.connect(MQTT_HOST, MQTT_PORT)) {
    Serial.print(" Failed, error=");
    Serial.println(mqtt.connectError());
    return;
  }
  Serial.println(" CONNECTED!");

  if (!mqtt.subscribe(topic("commands"), 1)) {
    Serial.println("Subscribe failed, reconnecting");
    mqtt.stop();
    return;
  }

  publishAvailability(true);
  publishState();
  publishTelemetry();

  isConnectingUI = false;
  if (keyboardState == 0) drawMainScreen();
}

void publishTelemetry() {
  JsonDocument doc;
  doc["timestamp"]         = getEpochMillis();
  doc["writeId"]           = generateUUID();
  doc["credentialVersion"] = CREDENTIAL_VERSION;

  const char* ids[2] = {PARAM_TEMP, PARAM_RH};
  float values[2] = {tempSensor, rhSensor};
  for (int i = 0; i < 2; i++) {
    JsonObject p = doc["values"][ids[i]].to<JsonObject>();
    if (isnan(values[i])) {
      p["status"] = "error"; p["error"] = "Sensor reading unavailable";
    } else {
      p["status"] = "ok"; p["value"] = values[i];
    }
  }
  mqttPublish("telemetry", doc, false);
}

void publishState() {
  JsonDocument doc;
  addEnvelope(doc);
  doc["revision"] = stateRevision;

  JsonArray params = doc["parameters"].to<JsonArray>();
  JsonObject p3 = params.add<JsonObject>();
  p3["id"] = PARAM_SET_TEMP; p3["value"] = setpointTemp;
  JsonObject p4 = params.add<JsonObject>();
  p4["id"] = PARAM_SET_RH; p4["value"] = setpointRH;

  mqttPublish("state", doc, true);
}

void publishAvailability(bool online) {
  JsonDocument doc;
  addEnvelope(doc);
  doc["online"] = online;
  mqttPublish("availability", doc, true);
}

// reason == nullptr means the command was applied.
void publishCommandResult(const String& cmdId, const char* reason) {
  JsonDocument doc;
  addEnvelope(doc);
  doc["commandId"] = cmdId;
  doc["status"]    = reason ? "rejected" : "succeeded";
  if (reason) doc["reason"] = reason;
  mqttPublish("command-results", doc, false);
}

void onMqttMessage(int size) {
  bool accept = size > 0 && size <= 1024 &&
                !mqtt.messageRetain() &&                 // stale replays are never commands
                mqtt.messageTopic() == topic("commands") &&
                commandQueueCount < COMMAND_QUEUE_SIZE;
  String payload;
  while (mqtt.available()) {
    char c = (char)mqtt.read();
    if (accept) payload += c;
  }
  if (!accept) {
    Serial.println("MQTT message ignored");
    return;
  }
  commandQueue[(commandQueueHead + commandQueueCount) % COMMAND_QUEUE_SIZE] = payload;
  commandQueueCount++;
}

void handleCommand(const String& payload) {
  Serial.print("Pesan MQTT Masuk: ");
  Serial.println(payload);

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.print("Gagal parse JSON: ");
    Serial.println(err.c_str());
    return;
  }

  String cmdId = doc["commandId"] | "";
  if (cmdId.length() != 36) return;

  // Cek jika perintah sudah pernah diproses (Deduplikasi, juga untuk QoS 1 redelivery)
  for (int i = 0; i < 32; i++) {
    if (processedCommandIds[i] == cmdId) {
      Serial.println("Perintah abaikan: Command ID sudah pernah diproses.");
      return;
    }
  }
  processedCommandIds[cmdCacheIndex] = cmdId;
  cmdCacheIndex = (cmdCacheIndex + 1) % 32;

  String paramId = doc["parameterId"] | "";
  float val = doc["value"] | NAN;
  const char* reason = nullptr;

  if (doc["credentialVersion"].as<uint32_t>() != CREDENTIAL_VERSION ||
      doc["connectionId"].as<String>() != currentConnectionId) {
    reason = "Command belongs to an older connection";
  } else if (!doc["revision"].is<uint32_t>() || doc["revision"].as<uint32_t>() != stateRevision) {
    reason = "Setpoint changed on the device after the command was sent";
  } else if (!doc["expiresAt"].is<uint64_t>() || doc["expiresAt"].as<uint64_t>() <= getEpochMillis()) {
    reason = "Command expired";
  } else if (!doc["value"].is<float>() || isnan(val)) {
    reason = "Numeric value required";
  } else if (paramId == PARAM_SET_TEMP) {
    if (val < SET_TEMP_MIN || val > SET_TEMP_MAX) reason = "Temperature setpoint out of range";
    else setpointTemp = val;
  } else if (paramId == PARAM_SET_RH) {
    if (val < SET_RH_MIN || val > SET_RH_MAX) reason = "Humidity setpoint out of range";
    else setpointRH = val;
  } else {
    reason = "Unknown parameter";
  }

  if (reason) {
    Serial.print("Perintah ditolak: ");
    Serial.println(reason);
  } else {
    stateRevision++;  // exactly once per applied command; the platform relies on it
    Serial.print("Setpoint diperbarui via Web: ");
    Serial.print(paramId);
    Serial.print(" = ");
    Serial.println(val);
  }

  publishCommandResult(cmdId, reason);
  publishState();
  if (!reason && keyboardState == 0) drawMainScreen();
}

void processCommands() {
  // Pop before handling: publishing may poll and enqueue the next command.
  while (commandQueueCount > 0) {
    String payload = commandQueue[commandQueueHead];
    commandQueue[commandQueueHead] = "";
    commandQueueHead = (commandQueueHead + 1) % COMMAND_QUEUE_SIZE;
    commandQueueCount--;
    handleCommand(payload);
  }
}

// ============================================================
// SETUP & LOOP
// ============================================================
void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);

  configTime(7 * 3600, 0, "pool.ntp.org", "time.nist.gov");

  pinMode(PIN_RELAY, OUTPUT);
  digitalWrite(PIN_RELAY, LOW);

  ledcAttach(PIN_RPWM, 5000, 8);
  ledcAttach(PIN_LPWM, 5000, 8);
  setPeltierPower(0);

  tft.init();
  tft.setRotation(1);
  
  uint16_t calData[5] = { 588, 3188, 465, 3215, 7 };
  tft.setTouch(calData);

  if (!sht31.begin(0x44)) {
    sht31.begin(0x45);
  }
  readSensors();

  drawMainScreen();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  if (wm.getWiFiIsSaved()) WiFi.begin();  // Rejoin the saved network after a reboot or power loss
  wm.setConfigPortalBlocking(false); // Non-blocking agar UI tidak hang
  wm.setConfigPortalTimeout(180);

  initFuzzy();
  initMQTT();
}

unsigned long lastUpdate = 0;
bool lastWiFiConnected = false;
bool lastMqttConnected = false;

void loop() {
  wm.process(); // Melayani background proses AP Portal

  handleTouch();

  // Pantau status WiFi secara dinamis untuk UI
  bool currentWiFiConnected = (WiFi.status() == WL_CONNECTED);
  if (currentWiFiConnected != lastWiFiConnected) {
    lastWiFiConnected = currentWiFiConnected;
    if (currentWiFiConnected) {
      isConnectingUI = false;
    }
    if (keyboardState == 0) drawMainScreen();
  }

  if (currentWiFiConnected) {
    if (mqtt.connected()) {
      mqtt.poll();
      processCommands();
    } else {
      connectMQTT();
    }
  }

  bool currentMqttConnected = mqtt.connected();
  if (currentMqttConnected != lastMqttConnected) {
    lastMqttConnected = currentMqttConnected;
    if (keyboardState == 0) drawMainScreen();
  }

  if (millis() - lastUpdate > CYCLE_MS) { // Cycle 10 Detik
    lastUpdate = millis();

    readSensors();

    if (systemRunning && !isnan(tempSensor)) {
      float errorTemp = tempSensor - setpointTemp;
      fuzzy->setInput(1, errorTemp);
      fuzzy->fuzzify();
      
      int outPeltier = (int)fuzzy->defuzzify(1);
      if (errorTemp > 0.5) outPeltier = 255;

      setPeltierPower(outPeltier);
      digitalWrite(PIN_RELAY, (rhSensor < setpointRH) ? LOW : HIGH);
    } else {
      setPeltierPower(0);
      digitalWrite(PIN_RELAY, HIGH);
    }

    if (currentWiFiConnected && mqtt.connected()) {
      publishAvailability(true);
      publishState();
      publishTelemetry();
    }

    if (keyboardState == 0) {
      updateDynamicValues();
    }
  }
}

// ============================================================
// UI DRAWING & TOUCH HANDLER
// ============================================================
void drawMainScreen() {
  tft.fillScreen(0x0842);

  // Logo Daun
  tft.fillTriangle(20, 32, 36, 17, 34, 39, 0x4700);
  tft.fillTriangle(35, 18, 52, 11, 45, 38, 0x4700);
  tft.drawLine(35, 22, 35, 49, 0x4700);
  tft.drawLine(35, 34, 27, 26, 0x4700);
  tft.drawLine(35, 40, 43, 30, 0x4700);

  tft.setTextColor(0xFFFF, 0x0842); tft.setTextSize(2); tft.drawString("Growth", 65, 20);
  tft.setTextColor(0x4700, 0x0842); tft.drawString("Chamber", 145, 20);
  tft.drawLine(16, 55, 304, 55, 0x2124);

  // Panel Temp
  tft.fillRoundRect(17, 63, 139, 107, 8, 0x2800);
  tft.drawRoundRect(17, 63, 139, 107, 8, 0x8000);
  tft.drawRoundRect(31, 76, 11, 45, 5, 0xFA60);
  tft.fillCircle(36, 119, 9, 0xFA60);
  tft.fillRect(33, 89, 6, 31, 0xFA60);
  tft.fillCircle(36, 119, 5, 0x2800);
  tft.setTextColor(0xFFFF, 0x2800); tft.setTextSize(1); tft.drawString("Temperature", 57, 73);
  tft.fillRoundRect(23, 132, 127, 31, 6, 0x3800);
  tft.setTextColor(0xBDD7, 0x3800); tft.drawString("Set Point", 30, 136);

  // Panel Humidity
  tft.fillRoundRect(164, 63, 139, 107, 8, 0x0108);
  tft.drawRoundRect(164, 63, 139, 107, 8, 0x0277);
  tft.fillTriangle(189, 76, 176, 103, 202, 103, 0x04FF);
  tft.fillCircle(189, 105, 14, 0x04FF);
  tft.setTextColor(0xFFFF, 0x0108); tft.setTextSize(1); tft.drawString("Humidity", 211, 73);
  tft.fillRoundRect(170, 132, 127, 31, 6, 0x01CD);
  tft.setTextColor(0xBDD7, 0x01CD); tft.drawString("Set Point", 177, 136);

  // ---------- Bottom Wi-Fi Button (3 STATUS COLOR LOGIC) ----------
  bool isOnline = (WiFi.status() == WL_CONNECTED && mqtt.connected());
  
  uint16_t wifiBgColor     = 0x0A20; // Default: Biru Gelap
  uint16_t wifiBorderColor = 0x4700;
  uint16_t wifiIconColor   = 0x87F0;
  String wifiText          = "Wi-Fi";

  if (isConnectingUI || wm.getConfigPortalActive()) {
    wifiBgColor     = 0x8300; // Kuning/Oranye saat Connecting & AP Portal Aktif
    wifiBorderColor = 0xFD20;
    wifiIconColor   = 0xFD20;
    wifiText        = "CONNECTING";
  } else if (isOnline) {
    wifiBgColor     = 0x0300; // Hijau Emerald saat ONLINE
    wifiBorderColor = 0x07E0;
    wifiIconColor   = 0x07E0;
    wifiText        = "ONLINE";
  }

  tft.fillRoundRect(17, 180, 139, 47, 8, wifiBgColor);
  tft.drawRoundRect(17, 180, 139, 47, 8, wifiBorderColor);

  // Ikon Sinyal Wi-Fi
  tft.drawCircle(35, 210, 2, wifiIconColor);
  tft.drawCircle(35, 210, 6, wifiIconColor);
  tft.drawCircle(35, 210, 10, wifiIconColor);
  tft.fillRect(18, 211, 35, 12, wifiBgColor);

  tft.setTextColor(0xFFFF, wifiBgColor);
  if (wifiText == "CONNECTING") {
    tft.setTextSize(1);
    tft.drawString(wifiText, 52, 199);
  } else {
    tft.setTextSize(2);
    tft.drawString(wifiText, 55, 195);
  }

  // ---------- Bottom Start/Stop Button ----------
  uint16_t btnBgColor    = systemRunning ? 0x9000 : 0x0400;
  uint16_t btnBorderColor= systemRunning ? 0xF800 : 0x07E0;
  tft.fillRoundRect(164, 180, 139, 47, 8, btnBgColor);
  tft.drawRoundRect(164, 180, 139, 47, 8, btnBorderColor);

  if (systemRunning) {
    tft.drawCircle(194, 203, 12, 0xF800);
    tft.fillRect(189, 198, 10, 10, 0xF800);
    tft.setTextColor(0xFFFF, btnBgColor); tft.setTextSize(2); tft.drawString("STOP", 220, 195);
  } else {
    tft.drawCircle(194, 203, 12, 0x07E0);
    tft.fillTriangle(191, 196, 191, 210, 200, 203, 0x07E0);
    tft.setTextColor(0xFFFF, btnBgColor); tft.setTextSize(2); tft.drawString("START", 216, 195);
  }

  updateDynamicValues();
}

void updateDynamicValues() {
  tft.fillRect(57, 91, 95, 25, 0x2800);
  tft.setTextColor(0xFFFF, 0x2800); tft.setTextSize(3);
  tft.drawString(isnan(tempSensor) ? String("--") : String(tempSensor, 1), 57, 91);
  tft.setTextSize(1); tft.drawString("o", 128, 93); tft.drawString("C", 128, 101);

  tft.fillRect(30, 148, 110, 14, 0x3800);
  tft.setTextColor(0xFFFF, 0x3800); tft.setTextSize(2);
  tft.drawString(String(setpointTemp, 1) + " C", 30, 148);

  tft.fillRect(204, 91, 95, 25, 0x0108);
  tft.setTextColor(0xFFFF, 0x0108); tft.setTextSize(3);
  tft.drawString(isnan(rhSensor) ? String("--") : String(rhSensor, 1), 204, 91);
  tft.setTextSize(2); tft.drawString("%", 275, 98);

  tft.fillRect(177, 148, 110, 14, 0x01CD);
  tft.setTextColor(0xFFFF, 0x01CD); tft.setTextSize(2);
  tft.drawString(String(setpointRH, 1) + " %", 177, 148);
}

void drawKeypadUI(String title) {
  tft.fillScreen(0x10A2);
  tft.setTextColor(0xFFFF, 0x10A2); tft.setTextSize(2); tft.drawString("SET " + title, 20, 15);
  tft.fillRoundRect(20, 40, 280, 40, 5, 0x0000);
  tft.drawRoundRect(20, 40, 280, 40, 5, 0xFFFF);
  tft.setTextColor(0x07E0, 0x0000); tft.setTextSize(3); tft.drawString(inputBuffer, 30, 48);

  const char* keys[12] = {"1","2","3","4","5","6","7","8","9",".","0","CLR"};
  for (int i = 0; i < 12; i++) {
    int col = i % 3; int row = i / 3;
    int x = 20 + col * 68; int y = 90 + row * 34;
    tft.fillRoundRect(x, y, 60, 28, 4, (i == 11) ? 0xF800 : 0x31A6);
    tft.setTextColor(0xFFFF); tft.setTextSize(2); tft.drawString(keys[i], x + 22, y + 6);
  }

  tft.fillRoundRect(224, 90, 76, 62, 5, 0x07E0);
  tft.setTextColor(0x0000, 0x07E0); tft.setTextSize(2); tft.drawString("OK", 248, 112);
  tft.fillRoundRect(224, 160, 76, 62, 5, 0x7BEF);
  tft.setTextColor(0xFFFF, 0x7BEF); tft.setTextSize(1); tft.drawString("CANCEL", 238, 186);
}

void handleTouch() {
  uint16_t x, y;
  if (!tft.getTouch(&x, &y)) return;

  if (keyboardState == 0) {
    if (x >= 17 && x <= 156 && y >= 132 && y <= 170) {
      keyboardState = 1; inputBuffer = ""; drawKeypadUI("SUHU (C)"); delay(200);
    } else if (x >= 164 && x <= 303 && y >= 132 && y <= 170) {
      keyboardState = 2; inputBuffer = ""; drawKeypadUI("HUMIDITY (%)"); delay(200);
    } 
    // SENTUH TOMBOL WI-FI
// 3. Sentuh Tombol Wi-Fi (Kiri Bawah)
    else if (x >= 17 && x <= 156 && y >= 180 && y <= 227) {
      // JIKA SAAT INI SUDAH ONLINE -> LAKUKAN DISCONNECT
      if (WiFi.status() == WL_CONNECTED) {
        Serial.println("Memutus Koneksi Wi-Fi...");
        
        // Kirim status offline ke broker sebelum putus (opsional)
        publishAvailability(false); 
        mqtt.stop();
        
        // Putuskan koneksi Wi-Fi dan matikan radio STA
        WiFi.disconnect(true);
        WiFi.mode(WIFI_OFF);
        
        isConnectingUI = false;
        drawMainScreen(); // Redraw UI kembali ke warna Biru (Wi-Fi)
      } 
      // JIKA SAAT INI OFFLINE -> MEMBUKA PORTAL KONEKSI (CONNECTING)
      else {
        if (!wm.getConfigPortalActive()) {
          WiFi.mode(WIFI_STA);
          isConnectingUI = true;
          drawMainScreen(); // Ubah tombol jadi Kuning "CONNECTING"
          wm.startConfigPortal("GrowthChamber-AP"); // Buka sinyal Wi-Fi di Laptop/HP
        }
      }
      delay(300);
    } else if (x >= 164 && x <= 303 && y >= 180 && y <= 227) {
      systemRunning = !systemRunning;
      drawMainScreen(); delay(300);
    }
  } else {
    const char* keys[12] = {"1","2","3","4","5","6","7","8","9",".","0","CLR"};
    for (int i = 0; i < 12; i++) {
      int col = i % 3; int row = i / 3;
      int bx = 20 + col * 68; int by = 90 + row * 34;

      if (x >= bx && x <= (bx + 60) && y >= by && y <= (by + 28)) {
        if (i == 11) inputBuffer = "";
        else if (inputBuffer.length() < 5) inputBuffer += keys[i];
        
        tft.fillRect(22, 42, 276, 36, 0x0000);
        tft.setTextColor(0x07E0, 0x0000); tft.setTextSize(3);
        tft.drawString(inputBuffer, 30, 48); delay(150); return;
      }
    }

    if (x >= 224 && x <= 300 && y >= 90 && y <= 152) { // OK
      if (inputBuffer.length() > 0) {
        float val = inputBuffer.toFloat();
        if (keyboardState == 1 && val >= SET_TEMP_MIN && val <= SET_TEMP_MAX) {
          setpointTemp = val;
          stateRevision++;
          publishState();
        } else if (keyboardState == 2 && val >= SET_RH_MIN && val <= SET_RH_MAX) {
          setpointRH = val;
          stateRevision++;
          publishState();
        }
      }
      keyboardState = 0; drawMainScreen(); delay(200);
    } else if (x >= 224 && x <= 300 && y >= 160 && y <= 222) { // CANCEL
      keyboardState = 0; drawMainScreen(); delay(200);
    }
  }
}
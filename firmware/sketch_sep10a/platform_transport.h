#pragma once
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoMqttClient.h>
#include <ArduinoJson.h>
#include <esp_system.h>
#include <time.h>
#include <sys/time.h>
#include "platform_config.h"

// Transport only. Original sensor variables, defaults, pins and control loop live in the sketch.
namespace Platform {
WiFiClientSecure socket;
MqttClient mqtt(socket);
const char* keys[] = {"tempSensor", "rhSensor", "setpointTemp", "setpointRH", "systemRunning"};
const char* types[] = {"nilai", "nilai", "control-setpoint", "control-setpoint", "control-state"};
String ids[5], configRevision, connectionId;
float minimum[5], maximum[5];
unsigned credentialVersion = 0;
unsigned long lastAttempt = 0, lastPublish = 0, lastConfig = 0;
uint32_t revision = 0;
bool configured = false;
String seen[32];
unsigned seenIndex = 0;
float previousTemp = 25, previousRH = 65;
bool previousRunning = false;

// Millisecond precision is required: results must not predate API command timestamps.
uint64_t now() { struct timeval tv; gettimeofday(&tv, nullptr); return uint64_t(tv.tv_sec) * 1000 + tv.tv_usec / 1000; }
String pendingCommand;
bool pendingRetained = false;
String uuid() {
  uint8_t b[16]; esp_fill_random(b, sizeof(b));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  char out[37];
  snprintf(out, sizeof(out), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x", b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]);
  return String(out);
}
String topic(const char* suffix) { return String("devices/") + PLATFORM_DEVICE_ID + "/" + suffix; }
void envelope(JsonDocument& doc) {
  doc["credentialVersion"] = credentialVersion;
  doc["timestamp"] = now(); doc["connectionId"] = connectionId;
}
bool publish(const char* suffix, JsonDocument& doc, bool retained) {
  String payload; serializeJson(doc, payload);
  if (!mqtt.beginMessage(topic(suffix).c_str(), (unsigned long)payload.length(), retained, 1)) return false;
  mqtt.print(payload); return mqtt.endMessage() == 1;
}
bool fetchConfig() {
  WiFiClientSecure https; https.setCACert(PLATFORM_ROOT_CA);
  HTTPClient http; http.setTimeout(3000);
  if (!String(PLATFORM_API_ORIGIN).startsWith("https://")) return false;
  if (!http.begin(https, String(PLATFORM_API_ORIGIN) + "/api/firmware/" + PLATFORM_DEVICE_ID + "/config")) return false;
  http.addHeader("Authorization", String("Bearer ") + PLATFORM_DEVICE_SECRET);
  int status = http.GET();
  if (status != 200 || http.getSize() > 8192) { http.end(); return false; }
  String body = http.getString(); http.end();
  if (body.length() > 8192) return false;
  JsonDocument doc;
  if (deserializeJson(doc, body) || doc["schemaVersion"] != 1 || doc["profile"] != "growth-chamber-v1" || doc["deviceId"] != PLATFORM_DEVICE_ID || !doc["credentialVersion"].is<unsigned>() || doc["credentialVersion"].as<unsigned>() == 0 || !doc["revision"].is<const char*>()) return false;
  JsonArray params = doc["parameters"].as<JsonArray>();
  if (params.size() != 5) return false;
  String next[5]; float lo[5] = {}, hi[5] = {};
  for (JsonObject p : params) {
    int slot = -1;
    for (int i=0;i<5;i++) if (p["sourceKey"] == keys[i]) slot=i;
    if (slot < 0 || next[slot].length() || p["type"] != types[slot] || !p["id"].is<const char*>()) return false;
    next[slot] = p["id"].as<String>();
    if (!next[slot].length() || next[slot].length()>64) return false;
    for (unsigned j=0;j<next[slot].length();j++) { char c=next[slot][j]; if (!isalnum(c) && c!='_' && c!='-') return false; }
    if (configured && next[slot] != ids[slot]) return false; // No runtime rekeying.
    if (slot==2 || slot==3) {
      if (!p["min"].is<float>() || !p["max"].is<float>()) return false;
      lo[slot]=p["min"]; hi[slot]=p["max"];
      if (!isfinite(lo[slot]) || !isfinite(hi[slot]) || lo[slot]>=hi[slot]) return false;
    }
  }
  for (int i=0;i<5;i++) for(int j=i+1;j<5;j++) if(next[i]==next[j]) return false;
  // Commit metadata atomically after complete validation. Never overwrite live setpoints or pins.
  for (int i=0;i<5;i++) { ids[i]=next[i]; minimum[i]=lo[i]; maximum[i]=hi[i]; }
  credentialVersion=doc["credentialVersion"]; configRevision=doc["revision"].as<String>();
  configured=true; return true;
}
void state() {
  JsonDocument doc; envelope(doc); doc["revision"]=revision;
  JsonArray params=doc["parameters"].to<JsonArray>();
  JsonObject t=params.add<JsonObject>(); t["id"]=ids[2]; t["value"]=setpointTemp;
  JsonObject h=params.add<JsonObject>(); h["id"]=ids[3]; h["value"]=setpointRH;
  JsonObject s=params.add<JsonObject>(); s["id"]=ids[4]; s["value"]=systemRunning;
  publish("state",doc,true);
}
void receive(int size) {
  if (size<=0 || size>2048 || mqtt.messageTopic()!=topic("commands")) { while(mqtt.available()) mqtt.read(); return; }
  // endMessage(QoS 1) calls poll internally. Never publish from its callback.
  if(pendingCommand.length()) { while(mqtt.available()) mqtt.read(); return; }
  pendingRetained=mqtt.messageRetain();
  while(mqtt.available()) pendingCommand+=(char)mqtt.read();
}
void processCommand() {
  if(!pendingCommand.length()) return;
  String payload=pendingCommand; bool retained=pendingRetained; pendingCommand="";
  JsonDocument cmd; if(deserializeJson(cmd,payload)) return;
  String commandId=cmd["commandId"] | "";
  if(commandId.length()!=36 || retained) return;
  for(const String& old:seen) if(old==commandId) return;
  const char* reason=nullptr;
  if(cmd["credentialVersion"]!=credentialVersion || cmd["connectionId"]!=connectionId || !cmd["revision"].is<unsigned>() || cmd["revision"].as<unsigned>()!=revision) reason="stale command";
  if(!cmd["expiresAt"].is<uint64_t>() || !cmd["timestamp"].is<uint64_t>() || cmd["expiresAt"].as<uint64_t>()<=now() || cmd["timestamp"].as<uint64_t>()>now()+5000) reason="expired or invalid timestamp";
  int slot=-1; for(int i=2;i<5;i++) if(cmd["parameterId"]==ids[i]) slot=i;
  if(slot<0) reason="unknown parameter";
  if(!reason && slot==4 && !cmd["value"].is<bool>()) reason="boolean required";
  if(!reason && slot!=4 && (!cmd["value"].is<float>() || !isfinite(cmd["value"].as<float>()) || cmd["value"].as<float>()<minimum[slot] || cmd["value"].as<float>()>maximum[slot])) reason="setpoint outside configured bounds";
  seen[seenIndex++ % 32]=commandId;
  if(!reason) {
    if(slot==2) setpointTemp=cmd["value"];
    if(slot==3) setpointRH=cmd["value"];
    if(slot==4) systemRunning=cmd["value"];
    revision++; previousTemp=setpointTemp; previousRH=setpointRH; previousRunning=systemRunning;
    // Existing control loop applies outputs; no new actuator operations here.
    if(keyboardState==0) drawMainUI();
  }
  JsonDocument result; envelope(result); result["commandId"]=commandId;
  result["status"]=reason ? "rejected" : "succeeded"; if(reason) result["reason"]=reason;
  publish("command-results",result,false); state();
}
void begin() {
  if(!strlen(PLATFORM_WIFI_SSID) || !strlen(PLATFORM_ROOT_CA) || !strlen(PLATFORM_DEVICE_SECRET)) return;
  socket.setCACert(PLATFORM_ROOT_CA); socket.setTimeout(3000);
  mqtt.setConnectionTimeout(3000); mqtt.onMessage(receive);
  WiFi.begin(PLATFORM_WIFI_SSID,PLATFORM_WIFI_PASSWORD);
  configTime(0,0,"pool.ntp.org","time.nist.gov");
}
void tick() {
  if(WiFi.status()!=WL_CONNECTED || now()<1700000000000ULL) return;
  if(!mqtt.connected()) {
    if(millis()-lastAttempt<10000) return; lastAttempt=millis();
    if(!fetchConfig()) return;
    connectionId=uuid(); revision=0;
    for(String& old:seen) old="";
    mqtt.setId(PLATFORM_DEVICE_ID);
    String user=String(PLATFORM_DEVICE_ID)+"-v"+credentialVersion;
    mqtt.setUsernamePassword(user,PLATFORM_DEVICE_SECRET);
    JsonDocument will; envelope(will); will["online"]=false;
    String payload; serializeJson(will,payload);
    mqtt.beginWill(topic("availability").c_str(), payload.length(), true, 1); mqtt.print(payload); mqtt.endWill();
    if(!mqtt.connect(PLATFORM_MQTT_HOST,PLATFORM_MQTT_PORT)) return;
    if(!mqtt.subscribe(topic("commands").c_str(),1)) { mqtt.stop(); return; }
    lastPublish=0; lastConfig=millis();
  }
  if(previousTemp!=setpointTemp || previousRH!=setpointRH || previousRunning!=systemRunning) {
    revision++; previousTemp=setpointTemp; previousRH=setpointRH; previousRunning=systemRunning;
  }
  mqtt.poll();
  if(millis()-lastConfig>60000) {
    lastConfig=millis(); unsigned oldVersion=credentialVersion;
    if(!fetchConfig() || oldVersion!=credentialVersion) { mqtt.stop(); return; }
  }
  processCommand();
  if(millis()-lastPublish<10000 && lastPublish!=0) return;
  lastPublish=millis();
  JsonDocument availability; envelope(availability); availability["online"]=true; publish("availability",availability,true);
  state();
  JsonDocument telemetry;
  telemetry["timestamp"]=now(); telemetry["writeId"]=uuid(); telemetry["credentialVersion"]=credentialVersion;
  float values[]={tempSensor,rhSensor};
  for(int i=0;i<2;i++) {
    JsonObject value=telemetry["values"][ids[i]].to<JsonObject>();
    if(isfinite(values[i])) { value["status"]="ok"; value["value"]=values[i]; }
    else { value["status"]="error"; value["error"]="SHT31 reading unavailable"; }
  }
  publish("telemetry",telemetry,false);
}
}

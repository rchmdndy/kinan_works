#pragma once
// Copy this file to secrets.h (gitignored) and fill it from the GrowSense
// dashboard: Device -> Credentials. Never commit secrets.h.

#define DEVICE_ID          ""   // e.g. 3f28640c25924a76a8a3e8b437a4b611
#define DEVICE_SECRET      ""   // MQTT password shown once when credentials are issued
#define CREDENTIAL_VERSION 1    // Increase after every credential rotation in the dashboard

#define MQTT_HOST "mqtt.growsense.my.id"
#define MQTT_PORT 8883

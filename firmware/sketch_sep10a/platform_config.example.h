#pragma once
// Copy to platform_config.h (gitignored). Never commit real credentials.
#define PLATFORM_WIFI_SSID ""
#define PLATFORM_WIFI_PASSWORD ""
#define PLATFORM_DEVICE_ID "growth-chamber-firmware-v1"
#define PLATFORM_DEVICE_SECRET ""
#define PLATFORM_API_ORIGIN "https://iot.example.com"
#define PLATFORM_MQTT_HOST "mqtt.example.com"
#define PLATFORM_MQTT_PORT 8883
// PEM root CA(s) validating both HTTPS and MQTT hostnames. No insecure fallback.
#define PLATFORM_ROOT_CA ""

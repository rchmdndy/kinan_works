# Chamber_kirimdata firmware

ESP32 growth chamber firmware for the GrowSense platform. It reads an SHT31 sensor, runs fuzzy Peltier control and a humidity relay, shows a touch UI on a TFT, and talks to `mqtt.growsense.my.id` over MQTT/TLS.

## Setup

1. Copy `secrets.example.h` to `secrets.h` in this folder.
2. Fill in `DEVICE_ID`, `DEVICE_SECRET` and `CREDENTIAL_VERSION` from the dashboard (Device -> Credentials). `secrets.h` is gitignored; never commit it.
3. Check that `PARAM_*` and `SET_*_MIN/MAX` at the top of `Chamber_kirimdata.ino` match the device parameters in the dashboard.
4. Build for board `esp32:esp32:esp32` (ESP32 Arduino core 3.x) and flash.
5. On first boot, tap the Wi-Fi button and connect to the `GrowthChamber-AP` access point to enter the Wi-Fi password. The device rejoins the saved network on later boots.

## Libraries

| Library             | Tested version |
| ------------------- | -------------- |
| ArduinoMqttClient   | 0.1.8          |
| ArduinoJson         | 7.4.3          |
| WiFiManager (tzapu) | 2.0.17         |
| TFT_eSPI            | 2.5.43         |
| Adafruit SHT31      | 2.2.2          |
| eFLL                | 1.5.1          |

TFT_eSPI needs its `User_Setup.h` set for your display, including `TOUCH_CS` for the touch panel.

PubSubClient is no longer used: it cannot publish at QoS 1.

## Platform behaviour

- All messages are published at QoS 1, so the broker acknowledges each one.
- The broker certificate is verified against the Let's Encrypt roots in `root_ca.h`.
- MQTT connects only after NTP time has synced, and retries every 10 s after a failure.
- A command is applied only if it is for the current connection, the current state revision and has not expired. Every command gets a `succeeded` or `rejected` result.
- If the SHT31 read fails, the device reports a sensor error, shows `--`, and switches the Peltier and relay off until the next good reading.
- After a credential rotation in the dashboard, update `DEVICE_SECRET` and increase `CREDENTIAL_VERSION`, then reflash.

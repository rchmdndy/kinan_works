#!/bin/sh
set -eu
mkdir -p /mosquitto/auth /mosquitto/data
: "${MQTT_INGEST_USERNAME:=kinan-api}"
: "${MQTT_INGEST_PASSWORD:?MQTT_INGEST_PASSWORD is required}"
if [ ! -s /mosquitto/auth/passwd ]; then
  umask 077
  mosquitto_passwd -b -c /mosquitto/auth/passwd "$MQTT_INGEST_USERNAME" "$MQTT_INGEST_PASSWORD"
  printf 'user %s\ntopic read devices/+/+/telemetry\n' "$MQTT_INGEST_USERNAME" > /mosquitto/auth/acl
fi
chown -R mosquitto:mosquitto /mosquitto/auth /mosquitto/data
/usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf &
pid=$!
# The broker owns reload privileges; API only atomically replaces mounted auth files.
last=''
while kill -0 "$pid" 2>/dev/null; do
  current=$(cksum /mosquitto/auth/passwd /mosquitto/auth/acl 2>/dev/null | cksum || true)
  if [ -n "$last" ] && [ "$current" != "$last" ]; then
    # Debounce paired password/ACL replacement so the broker never reloads a half-updated policy.
    sleep 1
    current=$(cksum /mosquitto/auth/passwd /mosquitto/auth/acl 2>/dev/null | cksum || true)
    kill -HUP "$pid"
  fi
  last=$current
  sleep 1
done
wait "$pid"

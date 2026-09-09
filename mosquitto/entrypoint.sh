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
# The broker owns reload privileges. The API atomically replaces both policy
# files, then writes this generation marker as its commit record. Watching the
# marker avoids a lost update when both replacements land in one polling window.
last=$(cat /mosquitto/auth/.kinan-auth-generation 2>/dev/null || true)
while kill -0 "$pid" 2>/dev/null; do
  current=$(cat /mosquitto/auth/.kinan-auth-generation 2>/dev/null || true)
  if [ -n "$current" ] && [ "$current" != "$last" ]; then
    kill -HUP "$pid"
    last=$current
  fi
  sleep 1
done
wait "$pid"

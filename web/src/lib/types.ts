export type Parameter = { id: string; label: string; unit: string; points: number };
export type Device = { id: string; ownerUid: string; label: string; active: boolean; credentialVersion: number; createdAt: number; updatedAt: number; parameters: Record<string, Parameter> };
export type SensorValue = { status: 'ok'; value: number } | { status: 'error'; error: string };
export type TelemetryPacket = { timestamp: number; writeId?: string; values: Record<string, SensorValue> };

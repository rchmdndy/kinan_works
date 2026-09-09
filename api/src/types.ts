export type SensorValue =
  | { status: 'ok'; value: number }
  | { status: 'error'; error: string };

export type Parameter = {
  id: string;
  label: string;
  unit: string;
  points: number;
};

export type Device = {
  id: string;
  ownerUid: string;
  label: string;
  active: boolean;
  credentialVersion: number;
  createdAt: number;
  updatedAt: number;
  parameters: Record<string, Parameter>;
};

export type DeviceAccess = {
  ownerUid: string;
  active: boolean;
  credentialVersion: number;
};

export type EncryptedSecret = {
  iv: string;
  ciphertext: string;
};

export type TelemetryPacket = {
  timestamp: number;
  writeId: string;
  credentialVersion: number;
  values: Record<string, SensorValue>;
};

export type LocalUser = {
  id: string;
  username: string;
  displayName: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
};

export type SessionUser = Pick<LocalUser, 'id' | 'username' | 'displayName'>;

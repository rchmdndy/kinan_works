import { z } from 'zod';

import type { Parameter } from './types.js';

export const actuatorSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  value: z.union([z.boolean(), z.number().finite()]),
});
const envelope = {
  credentialVersion: z.number().int().positive(),
  timestamp: z.number().int().positive(),
  connectionId: z.string().uuid(),
};
export const stateSchema = z
  .strictObject({
    ...envelope,
    revision: z.number().int().nonnegative(),
    parameters: z.array(actuatorSchema).max(100),
  })
  .refine(
    (s) => new Set(s.parameters.map((a) => a.id)).size === s.parameters.length,
  );
export const availabilitySchema = z.strictObject({
  ...envelope,
  online: z.boolean(),
});
export const commandInputSchema = z.strictObject({
  commandId: z.string().uuid(),
  parameterId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  value: z.union([z.boolean(), z.number().finite()]),
});
export const commandSchema = commandInputSchema.extend({
  ...envelope,
  expiresAt: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
});
export const resultSchema = z.strictObject({
  ...envelope,
  commandId: z.string().uuid(),
  status: z.enum(['succeeded', 'rejected']),
  reason: z.string().max(200).optional(),
});
export type Actuator = z.infer<typeof actuatorSchema>;
export type DeviceState = z.infer<typeof stateSchema>;
export type Availability = z.infer<typeof availabilitySchema>;
export type Command = z.infer<typeof commandSchema>;
export type CommandInput = z.infer<typeof commandInputSchema>;
export type CommandResult = z.infer<typeof resultSchema>;
export type StoredCommand = Command & {
  deviceId: string;
  status: 'pending' | 'unknown' | 'succeeded' | 'rejected';
  reason?: string;
  result?: CommandResult;
};
export function acceptsValue(
  parameter: Parameter,
  value: CommandInput['value'],
): boolean {
  if (parameter.type === 'control-state') return typeof value === 'boolean';
  return (
    parameter.type === 'control-setpoint' &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    parameter.min !== undefined &&
    parameter.max !== undefined &&
    value >= parameter.min &&
    value <= parameter.max
  );
}
export const CONTROL_FRESH_MS = 45_000;
export const COMMAND_TTL_MS = 10_000;

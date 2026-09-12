import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{2,63}$/);

export const loginSchema = z.strictObject({
  username: usernameSchema,
  password: z.string().min(1).max(1024),
});

const parameterFields = {
  label: z.string().trim().min(1).max(100),
  unit: z.string().trim().max(32),
  points: z.number().int().min(0).max(10).default(0),
  type: z.enum(['nilai', 'control-state', 'control-setpoint']).default('nilai'),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
};
const validParameter = (p: {
  type: string;
  unit: string;
  points: number;
  min?: number;
  max?: number;
}) =>
  p.type === 'control-setpoint'
    ? p.min !== undefined && p.max !== undefined && p.min < p.max
    : p.min === undefined &&
      p.max === undefined &&
      (p.type !== 'control-state' || (p.unit === '' && p.points === 0));
export const parameterFieldsSchema = z
  .strictObject(parameterFields)
  .refine(validParameter, 'Invalid parameter bounds or switch formatting');

export const parameterSchema = z
  .strictObject({
    ...parameterFields,
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .optional(),
  })
  .refine(validParameter, 'Invalid parameter bounds or switch formatting');

export const createDeviceSchema = z.strictObject({
  label: z.string().trim().min(1).max(100),
  parameters: z.array(parameterFieldsSchema).min(1).max(100),
});

export const updateDeviceSchema = z
  .strictObject({
    label: z.string().trim().min(1).max(100).optional(),
    parameters: z.array(parameterSchema).min(1).max(100).optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one field is required',
  )
  .superRefine((value, ctx) => {
    if (!value.parameters) return;
    const ids = value.parameters.flatMap((parameter) =>
      parameter.id ? [parameter.id] : [],
    );
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['parameters'],
        message: 'Parameter IDs must be unique',
      });
  });

const sensorValueSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), value: z.number().finite() }),
  z.strictObject({
    status: z.literal('error'),
    error: z.string().trim().min(1).max(200),
  }),
]);

export const telemetrySchema = z.strictObject({
  credentialVersion: z.number().int().positive(),
  writeId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
  values: z.record(
    z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    sensorValueSchema,
  ),
  timestamp: z.number().int().positive().finite(),
});

export type CreateDevice = z.infer<typeof createDeviceSchema>;
export type UpdateDevice = z.infer<typeof updateDeviceSchema>;
export type TelemetryInput = z.infer<typeof telemetrySchema>;

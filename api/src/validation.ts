import { z } from 'zod';

export const parameterFieldsSchema = z.object({
  label: z.string().trim().min(1).max(100),
  unit: z.string().trim().max(32),
  points: z.number().int().min(0).max(10)
});

export const parameterSchema = parameterFieldsSchema.extend({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
});

export const createDeviceSchema = z.object({
  label: z.string().trim().min(1).max(100),
  parameters: z.array(parameterFieldsSchema).min(1).max(100)
});

export const updateDeviceSchema = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  parameters: z.array(parameterSchema).min(1).max(100).optional(),
  active: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required').superRefine((value, ctx) => {
  if (!value.parameters) return;
  const ids = value.parameters.map((parameter) => parameter.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['parameters'], message: 'Parameter IDs must be unique' });
});

export const telemetrySchema = z.object({
  credentialVersion: z.number().int().positive(),
  values: z.record(z.string(), z.union([
    z.object({ status: z.literal('ok'), value: z.number().finite() }),
    z.object({ status: z.literal('error'), error: z.string().trim().min(1).max(200) })
  ])),
  history: z.boolean().default(false),
  timestamp: z.number().int().positive().optional()
});

export type CreateDevice = z.infer<typeof createDeviceSchema>;
export type UpdateDevice = z.infer<typeof updateDeviceSchema>;
export type TelemetryInput = z.infer<typeof telemetrySchema>;

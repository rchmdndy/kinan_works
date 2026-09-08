export type ParameterDraft = {
  label: string;
  unit: string;
  points: number | null | undefined;
};

export type DeviceDraftErrors = {
  label?: string;
  parameters?: string;
  parameter: Array<{ label?: string; unit?: string; points?: string }>;
};

export function validateDeviceDraft(label: string, parameters: ParameterDraft[]): DeviceDraftErrors {
  const errors: DeviceDraftErrors = { parameter: parameters.map(() => ({})) };
  const cleanLabel = label.trim();
  if (!cleanLabel) errors.label = 'Nama perangkat wajib diisi.';
  else if (cleanLabel.length > 100) errors.label = 'Nama maksimal 100 karakter.';
  if (!parameters.length) errors.parameters = 'Tambahkan minimal satu parameter.';
  else if (parameters.length > 100) errors.parameters = 'Maksimal 100 parameter.';

  parameters.forEach((parameter, index) => {
    const cleanParameterLabel = parameter.label.trim();
    if (!cleanParameterLabel) errors.parameter[index].label = 'Label wajib diisi.';
    else if (cleanParameterLabel.length > 100) errors.parameter[index].label = 'Label maksimal 100 karakter.';
    if (parameter.unit.trim().length > 32) errors.parameter[index].unit = 'Satuan maksimal 32 karakter.';
    if (!Number.isInteger(parameter.points) || Number(parameter.points) < 0 || Number(parameter.points) > 10) {
      errors.parameter[index].points = 'Gunakan bilangan bulat 0–10.';
    }
  });
  return errors;
}

export function hasDeviceDraftErrors(errors: DeviceDraftErrors): boolean {
  return Boolean(errors.label || errors.parameters || errors.parameter.some((parameter) => Object.keys(parameter).length));
}

export function normalizeDeviceDraft(label: string, parameters: ParameterDraft[]) {
  return {
    label: label.trim(),
    parameters: parameters.map((parameter) => ({
      label: parameter.label.trim(),
      unit: parameter.unit.trim(),
      points: Number(parameter.points)
    }))
  };
}

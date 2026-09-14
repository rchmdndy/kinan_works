export type ExportStatus = 'queued' | 'processing' | 'ready' | 'failed';

export type ExportJobRecord = {
  id: string;
  userId: string;
  deviceId: string;
  deviceLabel: string;
  parameterIds: string[];
  start: number;
  end: number;
  status: ExportStatus;
  rowCount: number | null;
  error: string | null;
  filePath: string | null;
  fileBytes: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export type CreateExportJob = {
  userId: string;
  deviceId: string;
  parameterIds: string[];
  start: number;
  end: number;
};

export type ExportSummary = {
  id: string;
  deviceId: string;
  deviceLabel: string;
  parameterIds: string[];
  start: number;
  end: number;
  status: ExportStatus;
  rowCount: number | null;
  error: string | null;
  fileBytes: number | null;
  createdAt: number;
  finishedAt: number | null;
};

export const EXPORT_MAX_PARAMETERS = 100;
export const EXPORT_MAX_TIME_SPAN_MS = 366 * 24 * 60 * 60 * 1000;
export const EXPORT_MAX_ROW_COUNT = 1_000_000;

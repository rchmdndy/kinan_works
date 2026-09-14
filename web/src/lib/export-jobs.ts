export type ExportStatus = 'queued' | 'processing' | 'ready' | 'failed';

export type ExportJob = {
  id: string;
  status: ExportStatus;
  rowCount: number | null;
  error: string | null;
  fileBytes: number | null;
};

export type ExportRecord = {
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

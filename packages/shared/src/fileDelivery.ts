/** Bounded, persisted receipt for one successful send_file delivery. Bytes never cross this DTO. */
export interface FileDeliveryArtifact {
  version: 1;
  deliveryId: string;
  targetKind: 'session' | 'channel';
  targetId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  downloadPath: string;
  downloadNodeId: 'master';
  sourceNodeId: string;
}

export function parseFileDeliveryArtifact(value: unknown): FileDeliveryArtifact | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const text = (key: string, max: number) => typeof v[key] === 'string' && (v[key] as string).length > 0 && (v[key] as string).length <= max && !(v[key] as string).includes('\0');
  if (v.version !== 1 || !text('deliveryId', 128) || !['session', 'channel'].includes(String(v.targetKind)) || !text('targetId', 512)
    || !text('fileName', 512) || /[\\/]/.test(v.fileName as string) || !text('mimeType', 128)
    || !text('downloadPath', 4096) || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(v.downloadPath as string)
    || v.downloadNodeId !== 'master' || !text('sourceNodeId', 128)
    || !Number.isSafeInteger(v.sizeBytes) || (v.sizeBytes as number) < 0) return undefined;
  return {
    version: 1, deliveryId: v.deliveryId as string, targetKind: v.targetKind as FileDeliveryArtifact['targetKind'], targetId: v.targetId as string,
    fileName: v.fileName as string, mimeType: v.mimeType as string, sizeBytes: v.sizeBytes as number,
    downloadPath: v.downloadPath as string, downloadNodeId: 'master', sourceNodeId: v.sourceNodeId as string,
  };
}

export type PackedSnapshot = { format: 2; pool: unknown[]; data: unknown }
export function packSnapshot(data: unknown): PackedSnapshot
export function unpackSnapshot(packed: PackedSnapshot): unknown

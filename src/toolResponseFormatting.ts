import { formatToolResponsePayload } from '../packages/shared/toolResponseFormatting';

export function formatToolResponseForModel(response: unknown): string {
  return formatToolResponsePayload(response);
}
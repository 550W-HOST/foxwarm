/**
 * Lightweight token estimator shared by master and node-side packages.
 *
 * Estimate token count based on codepoint values:
 * - ASCII characters (< 128): 0.33 tokens each
 * - Other characters: 1 token each
 * - Result is rounded up
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;

  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) {
      count += 0.33;
    } else {
      count += 1;
    }
  }

  return Math.ceil(count);
}

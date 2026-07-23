/** Build the current structured screenshot result written to the node wire. */
export function buildBrowserScreenshotResult(base64, metadata) {
  const mimeType = 'image/png';
  return {
    ...metadata,
    output: `[Screenshot of browser tab ${metadata.tabId}]`,
    mimeType,
    inlineData: {
      data: base64,
      mimeType,
    },
  };
}
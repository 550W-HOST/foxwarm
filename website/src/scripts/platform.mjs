// The visitor's operating system as the browser reports it, used only to preselect or emphasize
// the matching install option: 'windows', 'macos', 'linux', 'android', 'ios', or '' when unknown.
// Pass `navigator`; tests pass plain objects with the same fields.
export function detectPlatform({ userAgentData, platform, userAgent, maxTouchPoints } = {}) {
  const hint = String(userAgentData?.platform || platform || '').toLowerCase();
  const agent = String(userAgent || '').toLowerCase();
  // Android reports a Linux platform, so check it first.
  if (hint === 'android' || agent.includes('android')) return 'android';
  if (/^(iphone|ipad|ipod|ios)/.test(hint) || /iphone|ipad|ipod/.test(agent)) return 'ios';
  // iPadOS reports a Mac platform; Macs have no touch screen.
  if (hint.startsWith('mac')) return Number(maxTouchPoints) > 1 ? 'ios' : 'macos';
  if (hint.startsWith('win')) return 'windows';
  if (hint.startsWith('linux') && !agent.includes('cros')) return 'linux';
  return '';
}

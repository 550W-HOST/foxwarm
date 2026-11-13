// Shared browser selection for standalone WebUI fixtures. Match the app E2E
// environment override rather than requiring a platform-specific installation.
export function browserLaunchOptions() {
  if (process.env.FOXWARM_E2E_BROWSER === 'firefox') {
    return { browser: 'firefox', executablePath: process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox-esr', headless: true }
  }
  return {
    executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  }
}

// Top-level Sessions of an Agent are shown under its main Session, which starts collapsed.
// Scenarios that address those rows directly open the host first.
export async function expandSidebarHost(page, hostId = 'main') {
  const selector = `[data-session-id="${hostId}"] button[aria-label="Expand child sessions"]`
  await page.waitForSelector(`[data-session-id="${hostId}"]`, { timeout: 15_000 })
  const toggle = await page.$(selector)
  if (!toggle) return
  await toggle.click()
  await page.waitForSelector(`[data-session-id="${hostId}"] button[aria-label="Collapse child sessions"]`, { timeout: 10_000 })
}

// Reveal up to `minimum` rows of an expanded host through its `Show N more` continuation.
export async function revealSidebarRows(page, minimum) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const count = await page.$$eval('[data-session-id]', rows => rows.length)
    if (count >= minimum) return
    const more = await page.$$('xpath/.//button[starts-with(normalize-space(.), "▼ Show") and contains(., "more")]')
    if (more.length === 0) return
    await more[0].click()
    await page.waitForFunction(previous => document.querySelectorAll('[data-session-id]').length > previous, { timeout: 10_000 }, count).catch(() => {})
  }
}

// An application view can mount before the entry splash releases pointer input.
export async function waitForWebUiReady(page) {
  await page.waitForFunction(() => document.getElementById('root')?.childElementCount > 0)
  await page.waitForSelector('[data-fox-splash]', { hidden: true })
}

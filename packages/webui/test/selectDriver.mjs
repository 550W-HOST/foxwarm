// Drives the shared Select (src/components/Select.tsx) as a desktop user does: press the
// trigger, then click an option in its list. Fixtures run with a fine or absent pointer,
// so the trigger is the combobox button rather than the phone's native select.

const listSelector = listId => `[id=${JSON.stringify(listId)}]`

const expandedList = (page, trigger, timeout) => page.waitForFunction(element => element.getAttribute('aria-expanded') === 'true' && element.getAttribute('aria-controls'), { timeout }, trigger).then(handle => handle.jsonValue())

async function openList(page, selector) {
  const trigger = await page.waitForSelector(selector)
  const wasOpen = await trigger.evaluate(element => element.getAttribute('aria-expanded') === 'true')
  let listId = null
  // The list closes when focus leaves the trigger, so a page that is still moving
  // focus while it loads can close it right away; press again, as a user would.
  for (let attempt = 0; !listId; attempt += 1) {
    if (!wasOpen || attempt > 0) await trigger.click()
    listId = await expandedList(page, trigger, attempt < 4 ? 1500 : 30000).catch(error => { if (attempt >= 4) throw error; return null })
  }
  await page.waitForSelector(listSelector(listId))
  return { trigger, listId, wasOpen }
}

/** Chooses the option with `value`, as `page.select` did for a native select. */
export async function chooseSelectOption(page, selector, value) {
  const { trigger, listId } = await openList(page, selector)
  const option = await page.waitForSelector(`${listSelector(listId)} [role="option"][data-select-option=${JSON.stringify(value)}]`)
  await option.click()
  await page.waitForFunction(element => element.getAttribute('aria-expanded') === 'false', {}, trigger)
}

/** The options of a Select as `{ value, label, disabled }`, leaving it closed. */
export async function readSelectOptions(page, selector) {
  const { trigger, listId, wasOpen } = await openList(page, selector)
  const options = await page.$$eval(`${listSelector(listId)} [role="option"]`, items => items.map(item => ({
    value: item.getAttribute('data-select-option'),
    label: item.textContent,
    disabled: item.getAttribute('aria-disabled') === 'true',
  })))
  if (!wasOpen) {
    await trigger.focus()
    await page.keyboard.press('Escape')
    await page.waitForFunction(element => element.getAttribute('aria-expanded') === 'false', {}, trigger)
  }
  return options
}

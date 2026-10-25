// These fixed functions run in a top-document isolated world through CDP only.
export function readPage(format, snapshotId) {
  const passwords = [...document.querySelectorAll('input[type=password]')]
    .map((el) => el.value)
    .filter(Boolean);
  const clean = (value) =>
    passwords.reduce((text, secret) => text.split(secret).join('[hidden]'), String(value || ''));
  const bound = (value) => ({
    [format]: clean(value).slice(0, 100000),
    truncated: clean(value).length > 100000,
  });
  if (format === 'text') return bound(document.body?.innerText || '');
  if (format === 'html') {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('input[type=password]').forEach((el) => el.removeAttribute('value'));
    return bound(clone.outerHTML);
  }
  globalThis.__foxwarmSnapshot = { id: snapshotId, refs: new Map() };
  const elements = [];
  const nodes = document.querySelectorAll(
    'a,button,input,textarea,select,summary,[role],[contenteditable],h1,h2,h3,main,nav,form',
  );
  for (const el of [...nodes].slice(0, 5000)) {
    if (elements.length >= 400) break;
    const rect = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none')
      continue;
    const ref = `${snapshotId}:${elements.length}`;
    globalThis.__foxwarmSnapshot.refs.set(ref, el);
    const entry = {
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      label: clean(
        el.getAttribute('aria-label') ||
          el.labels?.[0]?.innerText ||
          el.innerText ||
          el.placeholder ||
          el.title ||
          '',
      ).slice(0, 300),
      bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      entry.type = el.type;
      if (el.type !== 'password') entry.value = clean(el.value).slice(0, 2000);
      entry.disabled = el.disabled;
      entry.readOnly = el.readOnly;
    }
    if (el instanceof HTMLSelectElement)
      entry.options = [...el.options].slice(0, 50).map((option) => ({
        value: clean(option.value),
        text: clean(option.text),
        selected: option.selected,
      }));
    if (el instanceof HTMLAnchorElement) entry.href = clean(el.href);
    if (['checkbox', 'radio'].includes(el.type)) entry.checked = el.checked;
    elements.push(entry);
  }
  return {
    title: clean(document.title),
    text: clean(document.body?.innerText).slice(0, 20000),
    elements,
    truncated: nodes.length > elements.length && elements.length >= 400,
  };
}

export function elementAction(args, operation) {
  let el;
  if (args.ref) {
    el = globalThis.__foxwarmSnapshot?.refs.get(args.ref);
    if (!el?.isConnected) throw new Error('Element reference is stale. Read a fresh snapshot.');
  } else if (args.selector) {
    const matches = document.querySelectorAll(args.selector);
    if (matches.length !== 1)
      throw new Error(`Selector must match exactly one element (matched ${matches.length}).`);
    el = matches[0];
  }
  if (operation !== 'scroll' && !el)
    throw new Error('Supply an element reference or a unique CSS selector.');
  if (el?.disabled || (el?.readOnly && operation === 'fill'))
    throw new Error('Element is not editable.');
  if (operation === 'point') {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error('Element is not visible.');
    const x = Math.max(0, rect.x) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.x)) / 2;
    const y = Math.max(0, rect.y) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.y)) / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit !== el && !el.contains(hit)) throw new Error('Element is covered by another element.');
    return { x, y };
  }
  if (operation === 'focus' || operation === 'fill') {
    if (
      operation === 'fill' &&
      !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable)
    )
      throw new Error('Element is not editable.');
    if (
      operation === 'fill' &&
      el instanceof HTMLInputElement &&
      !['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type)
    )
      throw new Error('This input type does not support text replacement.');
    el.focus({ preventScroll: true });
    if (document.activeElement !== el) throw new Error('Element could not be focused.');
    if (operation === 'fill') {
      if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else el.select();
    }
    return { focused: true };
  }
  if (operation === 'select') {
    if (!(el instanceof HTMLSelectElement)) throw new Error('Element is not a native select.');
    if (!el.multiple && args.values.length !== 1)
      throw new Error('Single-select requires one option value.');
    if (
      args.values.some(
        (value) => ![...el.options].some((option) => option.value === value && !option.disabled),
      )
    )
      throw new Error('Option value is unavailable.');
    for (const option of el.options) option.selected = args.values.includes(option.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: true };
  }
  if (operation === 'scroll') {
    (el || window).scrollBy({ left: args.deltaX || 0, top: args.deltaY || 0, behavior: 'instant' });
    return { scrolled: true };
  }
}

export function pageCondition(args) {
  if (args.condition === 'url') return location.href === args.url;
  if (args.condition === 'text') return (document.body?.innerText || '').includes(args.text);
  const el = document.querySelector(args.selector);
  const visible =
    !!el && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  return args.state === 'hidden' ? !visible : args.state === 'attached' ? !!el : visible;
}

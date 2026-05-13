/**
 * Tool implementations for the browser extension node
 */

import { resolvePermission, isTabVisible, requestConfirmation } from './permissions.js';

/**
 * Check permission and optionally request confirmation.
 * Returns true if allowed, throws if denied.
 */
async function checkPermission(toolName, args, tabId) {
  if (tabId == null) return; // Tools without a tab target (e.g. browser_open_tab) skip check

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} not found`);
  }

  const level = await resolvePermission(tabId, tab.url);

  if (level === 'off') {
    throw new Error(`Permission denied: tab ${tabId} is set to "off"`);
  }

  if (level === 'ask') {
    const approved = await requestConfirmation(toolName, args, tabId);
    if (!approved) {
      throw new Error('Tool call rejected by user or timed out waiting for confirmation');
    }
  }
  // 'auto' — proceed
}

/**
 * Inject content script into a tab and execute a function.
 * Returns the result from the injected function.
 */
async function injectAndRun(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  if (!results || results.length === 0) {
    throw new Error('Content script injection returned no results');
  }
  if (results[0].error) {
    throw new Error(results[0].error.message || 'Content script error');
  }
  return results[0].result;
}

// ─── Tool: browser_list_tabs ───

export async function browser_list_tabs() {
  const allTabs = await chrome.tabs.query({});
  const visibleTabs = [];

  for (const tab of allTabs) {
    if (await isTabVisible(tab.id, tab.url)) {
      visibleTabs.push({
        tabId: tab.id,
        title: tab.title || '',
        url: tab.url || '',
        active: tab.active,
        windowId: tab.windowId,
      });
    }
  }

  return { tabs: visibleTabs, count: visibleTabs.length };
}

// ─── Tool: browser_get_tab_content ───

export async function browser_get_tab_content(args) {
  const { tabId, format = 'accessibility' } = args;
  await checkPermission('browser_get_tab_content', args, tabId);

  if (format === 'accessibility') {
    return await injectAndRun(tabId, getAccessibilityTree);
  } else if (format === 'html') {
    return await injectAndRun(tabId, () => {
      return { html: document.documentElement.outerHTML.slice(0, 500000) };
    });
  } else if (format === 'text') {
    return await injectAndRun(tabId, () => {
      return { text: document.body.innerText.slice(0, 200000) };
    });
  } else {
    throw new Error(`Unknown format: ${format}. Use "accessibility", "html", or "text".`);
  }
}

/**
 * Accessibility tree extractor — runs in the content script context.
 * Extracts interactive and landmark elements with their roles, text, and bounding boxes.
 */
function getAccessibilityTree() {
  const INTERACTIVE_ROLES = new Set([
    'link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox',
    'option', 'menuitemcheckbox', 'menuitemradio',
  ]);

  const INTERACTIVE_TAGS = new Set([
    'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY',
  ]);

  const LANDMARK_ROLES = new Set([
    'banner', 'navigation', 'main', 'complementary', 'contentinfo',
    'search', 'form', 'region',
  ]);

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH']);

  const elements = [];
  let nodeIndex = 0;

  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'NAV') return 'navigation';
    if (tag === 'MAIN') return 'main';
    if (tag === 'HEADER') return 'banner';
    if (tag === 'FOOTER') return 'contentinfo';
    if (tag === 'ASIDE') return 'complementary';
    if (tag === 'FORM') return 'form';
    if (tag === 'SUMMARY') return 'button';
    return null;
  }

  function getLabel(el) {
    // aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    // aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map(id => {
        const ref = document.getElementById(id);
        return ref ? ref.textContent.trim() : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    // <label for="...">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }

    // title, alt, placeholder
    if (el.title) return el.title.trim();
    if (el.alt) return el.alt.trim();
    if (el.placeholder) return el.placeholder.trim();

    // innerText (short)
    const text = el.innerText || el.textContent || '';
    const trimmed = text.trim();
    return trimmed.length > 200 ? trimmed.slice(0, 200) + '…' : trimmed;
  }

  function walk(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (SKIP_TAGS.has(node.tagName)) return;

    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return;

    const role = getRole(node);
    const isInteractive = role && (INTERACTIVE_ROLES.has(role) || INTERACTIVE_TAGS.has(node.tagName));
    const isLandmark = role && LANDMARK_ROLES.has(role);

    if (isInteractive || isLandmark) {
      const rect = node.getBoundingClientRect();
      const entry = {
        index: nodeIndex++,
        role,
        tag: node.tagName.toLowerCase(),
        label: getLabel(node),
        bbox: rect.width > 0 && rect.height > 0 ? {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        } : null,
      };

      // Extra attributes for form elements
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
        entry.value = node.value || '';
        entry.type = node.type || 'text';
        if (node.disabled) entry.disabled = true;
        if (node.readOnly) entry.readOnly = true;
      }
      if (node.tagName === 'SELECT') {
        entry.value = node.value || '';
        entry.options = Array.from(node.options).slice(0, 50).map(o => ({
          value: o.value,
          text: o.text,
          selected: o.selected,
        }));
      }
      if (node.tagName === 'A') {
        entry.href = node.href || '';
      }
      if (node.checked !== undefined) {
        entry.checked = node.checked;
      }

      // Generate a unique selector for this element
      if (node.id) {
        entry.selector = `#${CSS.escape(node.id)}`;
      } else {
        // Build a reasonably unique CSS path
        const parts = [];
        let current = node;
        for (let depth = 0; depth < 5 && current && current !== document.body; depth++) {
          let seg = current.tagName.toLowerCase();
          if (current.id) {
            seg = `#${CSS.escape(current.id)}`;
            parts.unshift(seg);
            break;
          }
          if (current.className && typeof current.className === 'string') {
            const cls = current.className.trim().split(/\s+/).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
            seg += cls;
          }
          parts.unshift(seg);
          current = current.parentElement;
        }
        entry.selector = parts.join(' > ');
      }

      elements.push(entry);
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(document.body);

  return {
    title: document.title,
    url: location.href,
    elementCount: elements.length,
    elements,
  };
}

// ─── Tool: browser_screenshot ───

export async function browser_screenshot(args) {
  const { tabId } = args;
  await checkPermission('browser_screenshot', args, tabId);

  // We need to make the tab active to capture it
  const tab = await chrome.tabs.get(tabId);
  const wasActive = tab.active;

  if (!wasActive) {
    await chrome.tabs.update(tabId, { active: true });
    // Small delay to let the tab render
    await new Promise(r => setTimeout(r, 300));
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: 'png',
  });

  // Restore previous active tab if we switched
  if (!wasActive) {
    // Find the previously active tab in the same window
    const windowTabs = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    // The tab we activated is now active, try to restore
    // Actually, we can't easily restore — just leave it. The agent activated it.
  }

  // Return as base64 (strip data:image/png;base64, prefix)
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return {
    image: base64,
    format: 'png',
    encoding: 'base64',
    tabId,
    url: tab.url,
    title: tab.title,
  };
}

// ─── Tool: browser_click ───

export async function browser_click(args) {
  const { tabId, selector, x, y } = args;
  await checkPermission('browser_click', args, tabId);

  if (selector) {
    return await injectAndRun(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.click();
      const rect = el.getBoundingClientRect();
      return {
        clicked: true,
        selector: sel,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || '').slice(0, 100),
        position: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
      };
    }, [selector]);
  } else if (x != null && y != null) {
    return await injectAndRun(tabId, (cx, cy) => {
      const el = document.elementFromPoint(cx, cy);
      if (!el) throw new Error(`No element at coordinates (${cx}, ${cy})`);
      el.click();
      return {
        clicked: true,
        coordinates: { x: cx, y: cy },
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || '').slice(0, 100),
      };
    }, [x, y]);
  } else {
    throw new Error('Either "selector" or "x"+"y" coordinates are required');
  }
}

// ─── Tool: browser_execute_js ───

export async function browser_execute_js(args) {
  const { tabId, code } = args;
  await checkPermission('browser_execute_js', args, tabId);

  // Execute in the MAIN world so the code has access to the page's JS context
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (jsCode) => {
      try {
        const result = (0, eval)(jsCode);
        if (result === undefined) return { result: 'undefined' };
        if (result === null) return { result: null };
        if (typeof result === 'function') return { result: '[Function]' };
        try {
          return { result: JSON.parse(JSON.stringify(result)) };
        } catch {
          return { result: String(result) };
        }
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },
    args: [code],
  });

  if (!results || results.length === 0) {
    throw new Error('Script execution returned no results');
  }

  const result = results[0].result;
  if (result && result.error) {
    throw new Error(`JS execution error: ${result.error}`);
  }
  return result;
}

// ─── Tool: browser_open_tab ───

export async function browser_open_tab(args) {
  const { url, active = true } = args;

  // No tab-level permission check needed for opening a new tab,
  // but we could check domain permission for the target URL
  const tab = await chrome.tabs.create({ url, active });

  return {
    tabId: tab.id,
    url: tab.url || url,
    title: tab.title || '',
    windowId: tab.windowId,
  };
}

// ─── Tool: browser_close_tab ───

export async function browser_close_tab(args) {
  const { tabId } = args;
  await checkPermission('browser_close_tab', args, tabId);

  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.remove(tabId);

  return {
    closed: true,
    tabId,
    url: tab.url,
    title: tab.title,
  };
}

// ─── Tool registry ───

export const TOOL_HANDLERS = {
  browser_list_tabs,
  browser_get_tab_content,
  browser_screenshot,
  browser_click,
  browser_execute_js,
  browser_open_tab,
  browser_close_tab,
};

export const TOOL_DEFINITIONS = [
  {
    name: 'browser_list_tabs',
    description: 'List all visible browser tabs (title, URL, tab ID). Only tabs the user has granted permission for are shown.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_get_tab_content',
    description: 'Get page content from a browser tab. Returns an accessibility tree of interactive elements by default, or raw HTML/text.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID from browser_list_tabs' },
        format: {
          type: 'string',
          enum: ['accessibility', 'html', 'text'],
          description: 'Output format. "accessibility" (default) returns interactive elements with roles/labels/selectors. "html" returns raw HTML. "text" returns visible text.',
        },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of a browser tab. Returns base64-encoded PNG. The tab will be activated if not already visible.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element on a page. Use a CSS selector (from browser_get_tab_content) or x/y coordinates (from browser_screenshot).',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of the element to click' },
        x: { type: 'number', description: 'X coordinate to click (alternative to selector)' },
        y: { type: 'number', description: 'Y coordinate to click (alternative to selector)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_execute_js',
    description: 'Execute JavaScript code in a browser tab and return the result.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        code: { type: 'string', description: 'JavaScript code to execute' },
      },
      required: ['tabId', 'code'],
    },
  },
  {
    name: 'browser_open_tab',
    description: 'Open a new browser tab with the given URL. Returns the new tab ID.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
        active: { type: 'boolean', description: 'Whether to make the tab active (default: true)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_close_tab',
    description: 'Close a browser tab by its tab ID.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to close' },
      },
      required: ['tabId'],
    },
  },
];

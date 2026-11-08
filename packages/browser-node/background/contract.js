// The browser_* tool contract shared by the Browser Node extension and the managed headless
// browser host. Pure data and validation: no DOM, extension or Node.js APIs, so the extension
// loads it directly and the host bundles it. Implementations differ only through a profile.
//
// profile.variant   'chrome' | 'firefox' | 'headless'
// profile.windowed  browser_open needs a shared window ID (extension)
// profile.keys      trusted key input exists (browser_type, browser_press)
// profile.fullPage  browser_screenshot can capture the whole page
export const MAX_TEXT = 100000;
export const MAX_WAIT_MS = 60000;
export const PRESS_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'Home',
  'End',
];
export const CONDITIONS = ['element', 'text', 'url'];
export const ELEMENT_STATES = ['visible', 'hidden', 'attached'];
export const READ_FORMATS = ['snapshot', 'text', 'html'];
export const HISTORY_MOVES = ['back', 'forward', 'reload'];

// Draft model-facing copy lives here only. `variants` replace the default for one profile.
const COPY = {
  browser_tabs: {
    text: 'List browser tabs with their IDs, titles and URLs.',
    variants: {
      chrome:
        'List shared browser tabs with their IDs, titles, URLs, window IDs, and effective sharing modes.',
      firefox:
        'List shared browser tabs with their IDs, titles, URLs, window IDs, and effective sharing modes.',
    },
  },
  browser_open: {
    text: 'Open an HTTP or HTTPS URL in a new browser tab and return the tab with its page state.',
    variants: {
      chrome:
        'Open an HTTP or HTTPS URL in a shared browser window without activating the new tab. The new tab follows the window and site sharing rules.',
      firefox:
        'Open an HTTP or HTTPS URL in a shared browser window without activating the new tab. The new tab follows the window and site sharing rules.',
    },
  },
  browser_close: {
    text: 'Close a browser tab.',
    variants: {
      chrome: 'Close a shared browser tab. Closing the last tab also closes its window.',
      firefox: 'Close a shared browser tab. Closing the last tab also closes its window.',
    },
  },
  browser_navigate: {
    text: 'Navigate a tab to an HTTP or HTTPS URL, or move it back, forward or reload it. Returns the resulting page state.',
    variants: {
      chrome:
        'Navigate a shared browser tab to an HTTP or HTTPS URL, or move it back, forward or reload it, and report its sharing status. Page identity and URL are returned while the destination remains shared.',
      firefox:
        'Navigate a shared browser tab to an HTTP or HTTPS URL, or move it back, forward or reload it, and report its sharing status. Page identity and URL are returned while the destination remains shared.',
    },
  },
  browser_read: {
    text: 'Read a tab as a DOM snapshot, visible text, or HTML. Snapshots include element references for subsequent actions; password values are omitted.',
  },
  browser_screenshot: {
    text: 'Capture a tab as an image. Returns the image with its page and viewport information.',
    variants: {
      chrome:
        'Capture the visible page viewport of a shared browser tab without activating it. Returns an image and its page and viewport information.',
      firefox:
        'Capture the visible page viewport of a shared browser tab without activating it. Returns an image and its page and viewport information.',
    },
  },
  browser_click: {
    text: 'Click an element using a snapshot reference, a unique CSS selector, or viewport coordinates from a screenshot. Returns the resulting page state.',
    variants: {
      firefox:
        'Activate an element in a shared Firefox tab using a snapshot reference, a unique CSS selector, or viewport coordinates from a screenshot. Uses DOM activation and synthetic events, not trusted native mouse input.',
    },
  },
  browser_fill: {
    text: "Replace the text of a text, search, email, URL, telephone, password, or number input, textarea, or contenteditable element, updating the page's own state. Use a snapshot reference or a unique CSS selector.",
    variants: {
      firefox:
        "Replace text in a shared Firefox tab's text, search, email, URL, telephone, password, or number input, textarea, or contenteditable element. Use a snapshot reference or a unique CSS selector. Updates the DOM and dispatches synthetic input events.",
    },
  },
  browser_type: {
    text: 'Type text with real key input into the focused element or a specified element. Use browser_fill to replace a whole value.',
  },
  browser_press: {
    text: 'Press a supported key on the page or a specified element. Returns the resulting page state.',
  },
  browser_select: {
    text: 'Select options in a native HTML select element by value. Use a snapshot reference or a unique CSS selector.',
  },
  browser_scroll: {
    text: 'Scroll the page or a specified scrollable element by a distance in CSS pixels.',
  },
  browser_wait: {
    text: 'Wait for a page condition within a bounded timeout. Returns when the condition is met or reports why waiting ended.',
  },
  browser_evaluate: {
    text: 'Evaluate JavaScript in the page context and return a bounded result. Promises are awaited.',
    variants: {
      chrome:
        "Evaluate JavaScript in a shared browser tab's page context and return a bounded result. Promises are awaited, and the tab's Ask or Auto sharing mode applies.",
      firefox:
        "Evaluate JavaScript in a shared Firefox tab's page context and return a bounded result. Promises are awaited, and the tab's Ask or Auto sharing mode applies. Requires the extension's optional user-script permission.",
    },
  },
};

const field = (type, description, rest = {}) => ({ type, description, ...rest });
const tabId = field('integer', 'Tab ID returned by browser_tabs or browser_open.');
const target = {
  ref: field('string', 'Element reference from the latest snapshot of this page.'),
  selector: field('string', 'CSS selector that must match exactly one element in the current page.'),
};

function properties(name, profile) {
  switch (name) {
    case 'browser_tabs':
      return {};
    case 'browser_open':
      return {
        ...(profile.windowed
          ? { windowId: field('integer', 'Shared browser window ID returned by browser_tabs.') }
          : {}),
        url: field('string', 'HTTP or HTTPS URL to open.'),
      };
    case 'browser_close':
      return { tabId };
    case 'browser_navigate':
      return {
        tabId,
        url: field('string', 'HTTP or HTTPS URL to load.'),
        history: field('string', 'Move through the tab history, or reload the current page.', {
          enum: HISTORY_MOVES,
        }),
      };
    case 'browser_read':
      return {
        tabId,
        format: field(
          'string',
          'Content format: snapshot returns DOM elements and action references, text returns visible text, and html returns bounded HTML. Defaults to snapshot.',
          { enum: READ_FORMATS },
        ),
      };
    case 'browser_screenshot':
      return {
        tabId,
        ...(profile.fullPage
          ? {
              fullPage: field(
                'boolean',
                'Capture the whole scrollable page instead of the viewport. Defaults to false.',
              ),
            }
          : {}),
      };
    case 'browser_click':
      return {
        tabId,
        ...target,
        x: field(
          'number',
          "Horizontal position in viewport CSS pixels from the screenshot's viewport information.",
        ),
        y: field(
          'number',
          "Vertical position in viewport CSS pixels from the screenshot's viewport information.",
        ),
        pageId: field(
          'string',
          'Page identity returned by browser_screenshot. Required when clicking by coordinates.',
        ),
      };
    case 'browser_fill':
      return {
        tabId,
        ...target,
        text: field('string', "Text that replaces the element's current contents."),
      };
    case 'browser_type':
      return {
        tabId,
        ...target,
        text: field('string', 'Text to type, one key at a time.'),
      };
    case 'browser_press':
      return {
        tabId,
        ...target,
        key: field('string', 'Key to press, selected from the supported values.', {
          enum: PRESS_KEYS,
        }),
      };
    case 'browser_select':
      return {
        tabId,
        ...target,
        values: field(
          'array',
          'Option values to select. Supply one value for a single-select element.',
          { items: { type: 'string' } },
        ),
      };
    case 'browser_scroll':
      return {
        tabId,
        ...target,
        deltaX: field(
          'number',
          'Horizontal scroll distance in CSS pixels; positive values scroll right. Defaults to 0.',
        ),
        deltaY: field(
          'number',
          'Vertical scroll distance in CSS pixels; positive values scroll down. Defaults to 0.',
        ),
      };
    case 'browser_wait':
      return {
        tabId,
        condition: field('string', 'Page condition to wait for.', { enum: CONDITIONS }),
        state: field('string', 'Required element state. Defaults to visible.', {
          enum: ELEMENT_STATES,
        }),
        selector: field('string', 'CSS selector identifying the element to observe.'),
        text: field('string', 'Visible text that must appear on the page.'),
        url: field('string', 'Expected page URL.'),
        timeoutMs: field(
          'number',
          'Maximum time to wait in milliseconds, bounded by the remaining tool-call time. Defaults to 10000.',
          { minimum: 1, maximum: MAX_WAIT_MS },
        ),
      };
    case 'browser_evaluate':
      return {
        tabId,
        code: field('string', 'JavaScript expression or code to evaluate in the page context.'),
      };
    default:
      throw new Error('Unknown browser tool: ' + name);
  }
}

const REQUIRED = {
  browser_tabs: [],
  browser_open: ['url'],
  browser_close: ['tabId'],
  browser_navigate: ['tabId'],
  browser_read: ['tabId'],
  browser_screenshot: ['tabId'],
  browser_click: ['tabId'],
  browser_fill: ['tabId', 'text'],
  browser_type: ['tabId', 'text'],
  browser_press: ['tabId', 'key'],
  browser_select: ['tabId', 'values'],
  browser_scroll: ['tabId'],
  browser_wait: ['tabId', 'condition'],
  browser_evaluate: ['tabId', 'code'],
};

export const TOOL_NAMES = Object.keys(REQUIRED);
const KEY_TOOLS = new Set(['browser_type', 'browser_press']);

export function toolDefinitions(profile) {
  return TOOL_NAMES.filter((name) => profile.keys || !KEY_TOOLS.has(name)).map((name) => ({
    name,
    description: COPY[name].variants?.[profile.variant] ?? COPY[name].text,
    parameters: {
      type: 'object',
      properties: properties(name, profile),
      required: [...REQUIRED[name], ...(name === 'browser_open' && profile.windowed ? ['windowId'] : [])],
      additionalProperties: false,
    },
  }));
}

export function httpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Supply an absolute HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error('Only HTTP and HTTPS pages are supported.');
  return parsed.href;
}

function checkType(key, spec, value) {
  const bad = (what) => new Error(`${key} must be ${what}.`);
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') throw bad('a string');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw bad('a boolean');
      break;
    case 'integer':
      if (!Number.isInteger(value)) throw bad('an integer');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw bad('a finite number');
      break;
    case 'array':
      if (!Array.isArray(value) || !value.every((item) => typeof item === spec.items?.type))
        throw bad('an array of ' + spec.items?.type + ' values');
      break;
  }
  if (spec.enum && !spec.enum.includes(value)) throw new Error(`${key} must be one of: ${spec.enum.join(', ')}.`);
  if (typeof value === 'number') {
    if (spec.minimum !== undefined && value < spec.minimum) throw new Error(`${key} is below ${spec.minimum}.`);
    if (spec.maximum !== undefined && value > spec.maximum) throw new Error(`${key} is above ${spec.maximum}.`);
  }
  if (typeof value === 'string' && value.length > MAX_TEXT)
    throw new Error(`${key} is longer than ${MAX_TEXT} characters.`);
}

// Validates arguments against the strict per-tool schema, then the cross-field rules. Returns
// normalized arguments (URLs canonicalized); never mutates the input.
export function validateArgs(name, input, profile) {
  const definition = toolDefinitions(profile).find((tool) => tool.name === name);
  if (!definition) throw new Error('Unknown or unsupported browser tool: ' + name);
  const args = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : null;
  if (!args) throw new Error('Tool arguments must be an object.');
  const { properties: specs, required } = definition.parameters;
  for (const key of Object.keys(args)) {
    if (args[key] === null || args[key] === undefined) delete args[key];
    else if (!specs[key]) throw new Error(`Unknown argument: ${key}.`);
  }
  for (const key of required) if (args[key] === undefined) throw new Error(`${key} is required.`);
  for (const [key, value] of Object.entries(args)) checkType(key, specs[key], value);
  const hasElement = args.ref !== undefined || args.selector !== undefined;
  if (args.ref !== undefined && args.selector !== undefined)
    throw new Error('Choose ref or selector, not both.');
  if (['browser_fill', 'browser_select'].includes(name) && !hasElement)
    throw new Error('Supply ref or selector.');
  if (name === 'browser_click') {
    const point = args.x !== undefined || args.y !== undefined;
    if (hasElement === point) throw new Error('Choose an element or screenshot coordinates.');
    if (point && (args.x === undefined || args.y === undefined || args.pageId === undefined))
      throw new Error('Coordinates need x, y and the pageId from the screenshot.');
  }
  if (name === 'browser_navigate') {
    if ((args.url === undefined) === (args.history === undefined))
      throw new Error('Supply either url or history.');
  }
  if (name === 'browser_wait') {
    const state = args.state ?? 'visible';
    if (args.condition === 'element' && typeof args.selector !== 'string')
      throw new Error('Supply a selector and supported element state.');
    if (args.condition === 'text' && typeof args.text !== 'string')
      throw new Error('Supply the expected condition value.');
    if (args.condition === 'url' && typeof args.url !== 'string')
      throw new Error('Supply the expected condition value.');
    if (!ELEMENT_STATES.includes(state)) throw new Error('Unsupported element state.');
  }
  if (typeof args.url === 'string' && (name === 'browser_open' || name === 'browser_navigate'))
    args.url = httpUrl(args.url);
  return args;
}

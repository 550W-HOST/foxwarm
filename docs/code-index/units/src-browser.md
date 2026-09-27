# Unit: src-browser

Files: src/browser.ts

## Purpose

Provides a browser automation utility built on Puppeteer that manages a headless Chromium instance with multi-tab support, anti-detection measures, and page interaction capabilities.

## Key Exports

- `browserManager` — singleton instance of `BrowserManager` for controlling browser tabs and interactions

## Function Index

| Function | Lines (approx) | Description (one phrase) |
|----------|------|-------------|
| `ensureBrowser()` | ~21–47 | Lazily launches headless Chromium with anti-detection flags |
| `openTab(url)` | ~49–75 | Opens a new tab, navigates to URL, returns tab id and title |
| `listTabs()` | ~77–83 | Returns metadata for all open tabs |
| `getTabContent(id)` | ~85–95 | Extracts text content from a tab's page body |
| `getTabScreenshot(id)` | ~97–105 | Captures a base64-encoded screenshot of the visible area |
| `closeTab(id)` | ~107–114 | Closes a specific tab and removes it from tracking |
| `closeAll()` | ~116–128 | Closes all tabs and shuts down the browser instance |
| `interact(id, action, params)` | ~130–178 | Dispatches page interactions (click, type, scroll, navigate, etc.) |

## Dependencies

- `./common` — `logger` for structured logging

## Behavior

- Lazily initializes a single Chromium browser instance on first use
- Applies anti-bot-detection measures: overrides `navigator.webdriver`, sets a standard Chrome user-agent, and uses stealth launch flags
- Maintains a `Map<string, Tab>` to track open pages with sequential IDs (`tab1`, `tab2`, …)
- `interact` supports actions: click, type, fill, press, scroll, wait, evaluate, goto, back, forward, reload
- After click actions, waits briefly for navigation (non-blocking catch on timeout)
- `closeAll` tears down all pages and the browser process, resetting internal state

## Integration

- Exported as a singleton, intended to be consumed by higher-level tool handlers or an agent orchestration layer that exposes browser actions (open, read, interact, close) as callable tools
- Relies on `logger` from the shared `common` module for observability
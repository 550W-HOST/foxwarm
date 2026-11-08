// Runtime packaging replaces this entry for Firefox.
export * from './cdp.js';
export const profile = { variant: 'chrome', windowed: true, keys: true, fullPage: false };

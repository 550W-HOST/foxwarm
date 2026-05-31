import fs from 'fs-extra';
import { ToolArgs } from './helpers';
import { browserManager } from '../browser';

export async function tool_browse_open(args: ToolArgs) {
    const { url } = args;
    const result = await browserManager.openTab(url);
    return `Tab opened: ${result.id}\nTitle: ${result.title}\nURL: ${url}`;
}

export async function tool_browse_list(args: ToolArgs) {
    const tabs = browserManager.listTabs();
    if (tabs.length === 0) {
        return 'No tabs open';
    }
    return tabs.map(t => `${t.id}: ${t.title}\n  URL: ${t.url}`).join('\n\n');
}

export async function tool_browse_get(args: ToolArgs) {
    const { tabId, screenshot } = args;
    
    if (screenshot) {
        const base64 = await browserManager.getTabScreenshot(tabId);
        
        // Check if screenshot is a file path (string starting with /)
        if (typeof screenshot === 'string' && screenshot.startsWith('/')) {
            // Save to file
            const buffer = Buffer.from(base64, 'base64');
            await fs.writeFile(screenshot, buffer);
            return `Screenshot saved to: ${screenshot}`;
        } else {
            return {
                output: `[Screenshot of ${tabId}]`,
                mimeType: 'image/png',
                sizeBytes: Buffer.byteLength(base64, 'base64'),
                inlineData: { data: base64, mimeType: 'image/png' }
            };
        }
    } else {
        const { text } = await browserManager.getTabContent(tabId);
        return text;
    }
}

export async function tool_browse_close(args: ToolArgs) {
    const { tabId } = args;
    await browserManager.closeTab(tabId);
    return `Tab ${tabId} closed`;
}

export async function tool_browse_interact(args: ToolArgs) {
    const { tabId, action, params } = args;
    const result = await browserManager.interact(tabId, action, params || {});
    return result;
}

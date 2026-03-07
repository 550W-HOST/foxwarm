/**
 * Browser management with tab support
 */
import puppeteer, { Browser, Page } from 'puppeteer-core';
import { logger } from './common';

interface Tab {
  id: string;
  url: string;
  title: string;
  page: Page;
}

class BrowserManager {
  private browser: Browser | null = null;
  private tabs: Map<string, Tab> = new Map();
  private nextTabId = 1;

  async ensureBrowser() {
    if (!this.browser) {
      logger.info('Launching browser...');
      this.browser = await puppeteer.launch({
        executablePath: '/usr/bin/chromium',
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled', // Hide automation
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });
      
      // Override navigator.webdriver
      const pages = await this.browser.pages();
      for (const page of pages) {
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, 'webdriver', {
            get: () => false,
          });
        });
      }
    }
    return this.browser;
  }

  async openTab(url: string): Promise<{ id: string; title: string }> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    
    // Anti-detection: override navigator.webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });
    
    // Set User-Agent to normal Chrome
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    
    // Set viewport
    await page.setViewport({ width: 1280, height: 720 });
    
    // Navigate
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    const title = await page.title();
    const id = `tab${this.nextTabId++}`;
    
    this.tabs.set(id, { id, url, title, page });
    
    logger.info({ id, url, title }, 'Tab opened');
    return { id, title };
  }

  listTabs(): Array<{ id: string; url: string; title: string }> {
    return Array.from(this.tabs.values()).map(tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title
    }));
  }

  async getTabContent(id: string): Promise<{ text: string; html?: string }> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`Tab ${id} not found`);

    // Get text content
    // @ts-ignore
    const text = await tab.page.evaluate(() => document.body.innerText);
    
    // Optionally get HTML (commented out to save tokens)
    // const html = await tab.page.content();
    
    return { text };
  }

  async getTabScreenshot(id: string): Promise<string> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`Tab ${id} not found`);

    const screenshot = await tab.page.screenshot({ 
      encoding: 'base64',
      fullPage: false // Only visible area
    });
    
    return screenshot as string;
  }

  async closeTab(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`Tab ${id} not found`);

    await tab.page.close();
    this.tabs.delete(id);
    
    logger.info({ id }, 'Tab closed');
  }

  async closeAll(): Promise<void> {
    for (const tab of this.tabs.values()) {
      await tab.page.close();
    }
    this.tabs.clear();
    
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    
    logger.info('All tabs closed, browser shut down');
  }

  async interact(id: string, action: string, params: any): Promise<string> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`Tab ${id} not found`);

    switch (action) {
      case 'click':
        await tab.page.click(params.selector);
        await tab.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => {});
        return `Clicked: ${params.selector}`;

      case 'type':
        await tab.page.type(params.selector, params.text);
        return `Typed "${params.text}" into ${params.selector}`;

      case 'fill':
        // @ts-ignore
        await tab.page.fill(params.selector, params.text);
        return `Filled ${params.selector} with "${params.text}"`;

      case 'press':
        await tab.page.keyboard.press(params.key);
        return `Pressed key: ${params.key}`;

      case 'scroll':
        // @ts-ignore
        await tab.page.evaluate((y) => window.scrollBy(0, y), params.y || 0);
        return `Scrolled by ${params.y || 0}px`;

      case 'wait':
        await tab.page.waitForSelector(params.selector, { timeout: params.timeout || 5000 });
        return `Waited for: ${params.selector}`;

      case 'evaluate':
        const result = await tab.page.evaluate(params.code);
        return `Evaluated: ${JSON.stringify(result)}`;

      case 'goto':
        await tab.page.goto(params.url, { waitUntil: 'networkidle2', timeout: 30000 });
        const title = await tab.page.title();
        // Update tab info
        tab.url = params.url;
        tab.title = title;
        return `Navigated to: ${params.url}\nTitle: ${title}`;

      case 'back':
        await tab.page.goBack({ waitUntil: 'networkidle2' });
        return 'Navigated back';

      case 'forward':
        await tab.page.goForward({ waitUntil: 'networkidle2' });
        return 'Navigated forward';

      case 'reload':
        await tab.page.reload({ waitUntil: 'networkidle2' });
        return 'Page reloaded';

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
}

export const browserManager = new BrowserManager();

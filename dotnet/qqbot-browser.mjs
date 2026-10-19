// Original production frontend against an owned Main/QQ/provider fixture (launched by QQBotHostTests).
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const [base, token, session] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium',
  headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('#token');
  await page.type('#token', token); await page.click('button[type="submit"]');
  await page.waitForSelector('button[aria-label="New session"]');
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), session);
  await page.waitForFunction(() => document.body.innerText.includes('QQ final answer'));
  const body = await page.evaluate(() => document.body.innerText);
  assert(body.includes('QQ original first input'));
  assert(body.includes('QQ busy followup 用户'));
  assert(!body.includes('<foxwarm-metadata'));
  assert(!body.includes('[SYSTEM:'));
  const history = await page.evaluate(async id => (await (await fetch(`api/sessions/${encodeURIComponent(id)}/history`)).json()).messages, session);
  assert.equal(history.filter(row => row.role === 'user').length, 2);
  assert.equal(history.filter(row => row.role === 'model').length, 2);
  assert(history.filter(row => row.role === 'user').every(row => row.parts.some(part => part.system?.includes('kind="group-message"'))));
  console.log('QQBOT_BROWSER: original frontend, canonical User metadata/history, Unicode followup, intermediate/final and generated image passed');
} finally { await browser.close(); }

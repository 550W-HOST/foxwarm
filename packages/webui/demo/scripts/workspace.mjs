// Creates the small fictional Tidepool checkout that gallery Sessions work in.
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'

export const gitIdentity = {
  GIT_AUTHOR_NAME: 'Dana Reyes', GIT_AUTHOR_EMAIL: 'dana@tidepool.dev',
  GIT_COMMITTER_NAME: 'Dana Reyes', GIT_COMMITTER_EMAIL: 'dana@tidepool.dev',
  GIT_CONFIG_NOSYSTEM: '1',
}

const files = {
  'package.json': JSON.stringify({ name: 'tidepool', version: '0.5.0', type: 'module', scripts: { test: 'node --test --test-reporter=spec', 'test:integration': 'sleep 3600' } }, null, 2) + '\n',
  'README.md': '# Tidepool\n\nSmall billing helpers for subscription plans: invoice totals and plan-change proration.\n',
  'src/invoice.js': `// Invoice totals for subscription plans.
const toCents = (amount) => Math.round((amount + Number.EPSILON) * 100) / 100;

export function lineTotal(item) {
  const gross = item.unitPrice * item.quantity;
  const discount = gross * (item.discountPercent ?? 0) / 100;
  return toCents(gross - discount);
}

export function invoiceTotal(items, taxRate) {
  const subtotal = toCents(items.reduce((sum, item) => sum + lineTotal(item), 0));
  const tax = toCents(subtotal * taxRate);
  return { subtotal, tax, total: toCents(subtotal + tax) };
}

export function formatMoney(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}
`,
  'src/proration.js': `const DAY = 24 * 60 * 60 * 1000;

// Credit for the unused part of a billing period when a plan changes.
export function prorate(price, periodStart, periodEnd, changedAt) {
  const total = (periodEnd - periodStart) / DAY;
  const unused = (periodEnd - changedAt) / DAY;
  return price * unused / total;
}
`,
  'test/invoice.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceTotal, formatMoney } from '../src/invoice.js';

test('applies line discounts before tax', () => {
  const items = [
    { unitPrice: 19.99, quantity: 3, discountPercent: 15 },
    { unitPrice: 5.74, quantity: 5 },
  ];
  assert.deepEqual(invoiceTotal(items, 0.0825), { subtotal: 79.67, tax: 6.57, total: 86.24 });
});

test('formats currency', () => {
  assert.equal(formatMoney(1234.5), '$1,234.50');
});
`,
  'test/proration.test.js': `import test from 'node:test';
import assert from 'node:assert/strict';
import { prorate } from '../src/proration.js';

test('credits the unused half of a 30-day period', () => {
  const start = Date.UTC(2026, 10, 1);
  const end = Date.UTC(2026, 11, 1);
  assert.equal(prorate(30, start, end, Date.UTC(2026, 10, 16)), 15);
});
`,
  'CHANGELOG.md': '# Changelog\n\n## 0.5.0\n\n- Round invoice line totals, tax and total to cents.\n- Credit mid-day plan changes by the fraction of the day left.\n',
}

// A small PNG bar chart drawn without image dependencies.
export function chartPng() {
  const width = 240, height = 140
  const bars = [[30, 52], [70, 88], [110, 64], [150, 110], [190, 96]]
  const rows = []
  for (let y = 0; y < height; y++) {
    const row = [0]
    for (let x = 0; x < width; x++) {
      let color = [250, 247, 242]
      if (y === height - 20 && x > 14 && x < width - 14) color = [120, 113, 108]
      for (const [left, value] of bars) {
        if (x >= left && x < left + 26 && y < height - 20 && y >= height - 20 - value) color = [234, 88, 12]
      }
      row.push(...color)
    }
    rows.push(Buffer.from(row))
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = bytes => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4)
  header[8] = 8; header[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ])
}

export async function createWorkspace(root) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), content)
  }
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs/revenue-by-plan.png'), chartPng())
  await writeFile(join(root, 'docs/plans.csv'), 'plan,monthly,annual\nstarter,9,90\nteam,29,290\nbusiness,79,790\n')
  const git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, ...gitIdentity }, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'Initial billing helpers', '--date', '2026-10-30T09:00:00Z')
}

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import cases from './cron-forward-corpus.mjs';

const root = process.env.FOXWARM_TS_ROOT;
if (!root) throw new Error('FOXWARM_TS_ROOT is required.');
const require = createRequire(path.join(root, 'package.json'));
if (require('cron-parser/package.json').version !== '4.9.0' || require('luxon/package.json').version !== '3.7.2')
  throw new Error('The forward oracle requires cron-parser 4.9.0 and Luxon 3.7.2.');

if (process.argv[2] === '--date-zone') {
  const CronDate = require(path.join(root, 'node_modules/cron-parser/lib/date.js'));
  const rows = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(rows.map(row => {
    const date = new CronDate(new Date(row.cursor));
    const states = [];
    for (const operation of row.operations) {
      date[operation]();
      states.push({ time: date.getTime(), local: [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()], lastDay: date.isLastDayOfMonth(), lastWeekday: date.isLastWeekdayOfMonth() });
    }
    return { ...row, states };
  })));
} else if (process.argv[2] === '--dates') {
  const rows = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); const output = [];
  for (const zone of new Set(rows.map(row => row.zone))) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--date-zone'], { env: { ...process.env, TZ: zone }, input: JSON.stringify(rows.filter(row => row.zone === zone)), encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(child.stderr || 'Source date operations failed.');
    output.push(...JSON.parse(child.stdout));
  }
  fs.writeFileSync(process.argv[4], JSON.stringify(output));
} else if (process.argv[2] === '--zone') {
  const parser = require('cron-parser');
  const rows = JSON.parse(fs.readFileSync(0, 'utf8'));
  const output = rows.map(row => {
    const result = { ...row };
    try {
      const interval = parser.parseExpression(row.expression, { currentDate: new Date(row.cursor), ...(row.end ? { endDate: new Date(row.end) } : {}) });
      result.fields = interval.fields;
      result.times = [];
      for (let index = 0; index < row.count; index++) result.times.push(interval.next().getTime());
      let cursor = new Date(row.cursor);
      result.freshTimes = [];
      for (let index = 0; index < row.count; index++) {
        cursor = parser.parseExpression(row.expression, { currentDate: cursor, ...(row.end ? { endDate: new Date(row.end) } : {}) }).next().toDate();
        result.freshTimes.push(cursor.getTime());
      }
    } catch (error) { result.error = error.message; }
    return result;
  });
  process.stdout.write(JSON.stringify(output));
} else {
  const rows = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : cases;
  const output = [];
  for (const zone of new Set(rows.map(row => row.zone))) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--zone'], {
      env: { ...process.env, TZ: zone }, input: JSON.stringify(rows.filter(row => row.zone === zone)),
      encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    });
    if (child.status !== 0) throw new Error(child.stderr || 'Source oracle failed.');
    output.push(...JSON.parse(child.stdout));
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(output));
  console.log(`Forward Source cases=${output.length}, zones=${new Set(rows.map(row => row.zone)).size}`);
}

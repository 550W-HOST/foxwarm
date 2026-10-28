'use strict';
require('./test/test-process-env.cjs').initializeTestEnvironment();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const repository = path.resolve(__dirname, '..');
const output = path.join(repository, 'runtime/current');

for (const scenario of ['retained-mailbox', 'active-worker', 'global-catalog']) {
  test(`source promotion inspects candidate readers before selection: ${scenario}`, t => {
    assert(fs.existsSync(path.join(output, 'Foxwarm.dll')), 'Build managed source output first.');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-upgrade-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const app = path.join(root, 'app with spaces');
    const data = path.join(root, 'owned data');
    const staging = path.join(app, 'build/core');
    const old = path.join(app, 'runtime/previous');
    fs.mkdirSync(staging, { recursive: true });
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(path.join(app, 'scripts'));
    fs.copyFileSync(path.join(repository, 'scripts/build-source.js'), path.join(app, 'scripts/build-source.js'));
    for (const entry of fs.readdirSync(output, { withFileTypes: true })) {
      const source = path.join(output, entry.name);
      const target = path.join(staging, entry.name);
      if (entry.isDirectory()) fs.symlinkSync(fs.realpathSync(source), target, process.platform === 'win32' ? 'junction' : 'dir');
      else fs.copyFileSync(source, target);
    }
    fs.symlinkSync(old, path.join(app, 'runtime/current'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(app, 'data_dir'), '../owned data\n');
    const env = { ...process.env, FOXWARM_DATA_DIR: '', FOXWARM_TS_ROOT: repository };
    const seeded = spawnSync(process.execPath, [path.join(repository, 'dotnet/Foxwarm.Tests/Fixtures/session-upgrade-fixture-ts.mjs'), data,
      scenario === 'active-worker' ? 'candidate' : 'inactive'], { env, encoding: 'utf8' });
    assert.equal(seeded.status, 0, seeded.stdout + seeded.stderr);
    const authority = path.join(data, 'state/sessions/retained.json');
    const before = fs.readFileSync(authority, 'utf8');
    const worker = new DatabaseSync(path.join(data, 'state/session-runtime.sqlite'));
    t.after(() => worker.close());
    // Keep an uncheckpointed change visible to the ordinary read-only inspector.
    worker.exec('UPDATE session_worker_mailbox SET created_at=42 WHERE applied_at IS NULL');
    const mailbox = worker.prepare('SELECT * FROM session_worker_mailbox ORDER BY id').all();
    if (scenario === 'global-catalog') {
      const catalog = new DatabaseSync(path.join(data, 'state/catalog.sqlite'));
      catalog.exec('PRAGMA user_version=99');
      catalog.close();
    }
    const result = spawnSync(process.execPath, [path.join(app, 'scripts/build-source.js'), '--promote'],
      { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    const text = result.stdout + result.stderr;
    assert.match(text, /Upgrade inspection:/);
    assert.match(text, /createdAt=42/);
    assert(!text.includes('Main started'));
    assert.equal(fs.readFileSync(authority, 'utf8'), before);
    assert.deepEqual(worker.prepare('SELECT * FROM session_worker_mailbox ORDER BY id').all(), mailbox);
    assert(!fs.existsSync(path.join(data, 'state/archive-store.sqlite')));
    assert(!fs.existsSync(path.join(data, 'state/migrationVersion.json')));
    assert(!fs.existsSync(path.join(data, 'agents')));
    if (scenario === 'retained-mailbox') {
      assert.equal(result.status, 0, text);
      assert.match(text, /Record retained; this runtime does not replay/);
      assert.notEqual(fs.realpathSync(path.join(app, 'runtime/current')), old);
      assert(!fs.existsSync(staging));
    } else {
      assert.notEqual(result.status, 0, text);
      assert.match(text, /Upgrade blocked/);
      assert.equal(fs.realpathSync(path.join(app, 'runtime/current')), old);
      assert(fs.existsSync(path.join(staging, 'Foxwarm.dll')));
    }
  });
}

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { decide } = require('../lib/supervised');

describe('a plugin homeCore started goes when homeCore does', () => {
  test('watches only when core is the parent', () => {
    expect(decide('4242', 4242)).toBe(4242);
    // Started through a launcher that stayed: its parent isn't core.
    expect(decide('4242', 5000)).toBeNull();
    // Not started by core at all.
    expect(decide(undefined, 4242)).toBeNull();
    expect(decide('', 4242)).toBeNull();
    expect(decide('core', 4242)).toBeNull();
  });

  const posix = process.platform === 'win32' ? test.skip : test;
  posix(
    'a plugin stops when the core that started it is killed',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-sup-'));
      const pidFile = path.join(dir, 'plugin.pid');
      const lib = path.join(__dirname, '..', 'lib', 'supervised.js');
      // The plugin: watches, writes its pid, then waits as a plugin would.
      const plugin = `
        require(${JSON.stringify(lib)}).watch('plugin.test', {});
        require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setTimeout(() => {}, 60000);
      `;
      // Core: starts the plugin with its own id set, then waits to be killed.
      const core = `
        const { spawn } = require('child_process');
        spawn(process.execPath, ['-e', ${JSON.stringify(plugin)}], {
          env: { ...process.env, HOMECORE_SUPERVISED: String(process.pid) },
          stdio: 'ignore',
        });
        setTimeout(() => {}, 60000);
      `;
      const proc = spawn(process.execPath, ['-e', core], { stdio: 'ignore' });
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await sleep(50);
        const child = Number(fs.readFileSync(pidFile, 'utf8'));
        proc.kill('SIGKILL');
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && alive(child)) await sleep(100);
        const left = alive(child);
        if (left) process.kill(child, 'SIGKILL');
        expect(left).toBe(false);
      } finally {
        if (proc.exitCode === null) proc.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    15000,
  );
});

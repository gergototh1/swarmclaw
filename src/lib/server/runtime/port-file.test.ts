import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// The module resolves RUN_DIR from data-dir at import time, and data-dir
// probes the real ~/.swarmclaw when no home is configured. Point it at a
// throwaway home before the first import so this test touches nothing real.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-port-file-home-'))
process.env.SWARMCLAW_HOME = testHome
process.on('exit', () => {
  fs.rmSync(testHome, { recursive: true, force: true })
})

async function loadPortFile() {
  return import('./port-file')
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-port-file-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('PORT_FILE lives under <SWARMCLAW_HOME>/run', async () => {
  const { PORT_FILE } = await loadPortFile()
  assert.equal(PORT_FILE, path.join(testHome, 'run', 'port.json'))
})

test('writePortFile round-trips through readPortFile and leaves no temp file', async () => {
  const { readPortFile, writePortFile } = await loadPortFile()
  withTempDir((dir) => {
    const file = path.join(dir, 'run', 'port.json')
    const info = { port: 3499, wsPort: 3500, pid: process.pid, startedAt: 1, instanceId: 'abc123' }
    writePortFile(info, file)
    assert.deepEqual(readPortFile(file), info)
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['port.json'])
    assert.equal(fs.readFileSync(file, 'utf8').endsWith('\n'), true)
  })
})

test('writePortFile replaces an existing file in place', async () => {
  const { readPortFile, writePortFile } = await loadPortFile()
  withTempDir((dir) => {
    const file = path.join(dir, 'port.json')
    writePortFile({ port: 1000, wsPort: 1001, pid: 1, startedAt: 1, instanceId: 'first' }, file)
    writePortFile({ port: 2000, wsPort: 2001, pid: 2, startedAt: 2, instanceId: 'second' }, file)
    assert.deepEqual(readPortFile(file), { port: 2000, wsPort: 2001, pid: 2, startedAt: 2, instanceId: 'second' })
  })
})

test('writePortFile creates the run directory 0700 and the file 0600', { skip: process.platform === 'win32' }, async () => {
  const { writePortFile } = await loadPortFile()
  withTempDir((dir) => {
    const file = path.join(dir, 'run', 'port.json')
    writePortFile({ port: 1, wsPort: 2, pid: 3, startedAt: 4, instanceId: 'x' }, file)
    // umask can only clear bits, so assert on the group/other bits being clear
    // rather than on the exact mode.
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0)
    assert.equal(fs.statSync(file).mode & 0o077, 0)
  })
})

test('readPortFile returns null for a missing, malformed, or out-of-range file', async () => {
  const { readPortFile } = await loadPortFile()
  withTempDir((dir) => {
    const file = path.join(dir, 'port.json')
    assert.equal(readPortFile(file), null)
    const rejected = [
      'not json',
      '',
      'null',
      '[]',
      '{"port":"x","wsPort":2,"pid":3,"startedAt":4}',
      '{"port":0,"wsPort":2,"pid":3,"startedAt":4}',
      '{"port":65536,"wsPort":2,"pid":3,"startedAt":4}',
      '{"port":1,"wsPort":2,"pid":0,"startedAt":4}',
      '{"port":1,"wsPort":2,"pid":-5,"startedAt":4}',
      '{"port":1,"wsPort":2,"pid":3.5,"startedAt":4}',
      '{"port":1,"wsPort":2,"pid":3}',
      // No instance token: a reader that took this would have nothing to
      // check the server on the port against, which is the whole of check 4.
      '{"port":1,"wsPort":2,"pid":3,"startedAt":4}',
      '{"port":1,"wsPort":2,"pid":3,"startedAt":4,"instanceId":""}',
      '{"port":1,"wsPort":2,"pid":3,"startedAt":4,"instanceId":7}',
    ]
    for (const text of rejected) {
      fs.writeFileSync(file, text)
      assert.equal(readPortFile(file), null, `should reject ${JSON.stringify(text)}`)
    }
  })
})

test('readPortFile drops unknown keys instead of rejecting the file', async () => {
  const { readPortFile } = await loadPortFile()
  withTempDir((dir) => {
    const file = path.join(dir, 'port.json')
    fs.writeFileSync(file, '{"port":1,"wsPort":2,"pid":3,"startedAt":4,"instanceId":"tok","later":true}')
    assert.deepEqual(readPortFile(file), { port: 1, wsPort: 2, pid: 3, startedAt: 4, instanceId: 'tok' })
  })
})

test('isPortFileLive is true for this process started in this boot', async () => {
  const { isPortFileLive } = await loadPortFile()
  assert.equal(isPortFileLive({ port: 1, wsPort: 2, pid: process.pid, startedAt: Date.now(), instanceId: 'tok' }), true)
})

test('isPortFileLive is false for a pid whose process has exited', async () => {
  const { isPortFileLive } = await loadPortFile()
  const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  assert.equal(typeof gone.pid, 'number')
  assert.equal(isPortFileLive({ port: 1, wsPort: 2, pid: gone.pid, startedAt: Date.now(), instanceId: 'tok' }), false)
})

test('isPortFileLive is false when startedAt predates this boot, whatever the pid says', async () => {
  const { isPortFileLive } = await loadPortFile()
  assert.equal(isPortFileLive({ port: 1, wsPort: 2, pid: process.pid, startedAt: 0, instanceId: 'tok' }), false)
})

test('isPortFileLive is false for pid 0 rather than probing the process group', async () => {
  const { isPortFileLive } = await loadPortFile()
  assert.equal(isPortFileLive({ port: 1, wsPort: 2, pid: 0, startedAt: Date.now(), instanceId: 'tok' }), false)
})

test('removePortFile removes only a file written by this pid', async () => {
  const { removePortFile, writePortFile } = await loadPortFile()
  withTempDir((dir) => {
    const file = path.join(dir, 'port.json')
    writePortFile({ port: 1, wsPort: 2, pid: process.pid + 100000, startedAt: 0, instanceId: 'tok' }, file)
    removePortFile(file)
    assert.equal(fs.existsSync(file), true)
    writePortFile({ port: 1, wsPort: 2, pid: process.pid, startedAt: 0, instanceId: 'tok' }, file)
    removePortFile(file)
    assert.equal(fs.existsSync(file), false)
  })
})

test('removePortFile does not throw for a missing or malformed file', async () => {
  const { removePortFile } = await loadPortFile()
  withTempDir((dir) => {
    const file = path.join(dir, 'port.json')
    removePortFile(file)
    fs.writeFileSync(file, 'garbage')
    removePortFile(file)
    assert.equal(fs.readFileSync(file, 'utf8'), 'garbage')
  })
})

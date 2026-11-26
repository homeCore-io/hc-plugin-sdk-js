'use strict';

jest.mock('mqtt');

const fs = require('fs');
const mqtt = require('mqtt');
const { PluginBase, Capabilities, Action } = require('../index');
const upload = require('../lib/upload');

const b64 = (s) => Buffer.from(s).toString('base64');

describe('upload pieces', () => {
  test('make the file an action is handed, and nothing else', () => {
    const id = `t${process.pid}a`;
    expect(upload.chunk({ upload_id: id, offset: 0, data: b64('hello ') })).toBeNull();
    expect(upload.chunk({ upload_id: id, offset: 6, data: b64('world') })).toBeNull();
    const file = upload.pathFor({ upload: { id, size: 11 } });
    expect(fs.readFileSync(file, 'utf8')).toBe('hello world');
    // A size that doesn't match is not a file to act on.
    expect(upload.pathFor({ upload: { id, size: 12 } })).toBeNull();
    fs.rmSync(file);
    expect(upload.chunk({ upload_id: '../x', offset: 0, data: '' })).toBe('bad upload id');
    expect(upload.chunk({ upload_id: id, offset: upload.MAX, data: b64('x') })).toBe('the file is too large');
    expect(upload.chunk({ upload_id: id, offset: 0, data: 'not base64!' })).toBe('bad piece');
  });
});

class FilePlugin extends PluginBase {
  constructor() {
    super({ pluginId: 'plugin.test' });
    this.seen = null;
  }
  onCommand() {}
  onAction(action, params) {
    if (action !== 'restore') return null;
    this.seen = { params, text: fs.readFileSync(params.file_path, 'utf8') };
    return { ok: true };
  }
}

describe('an action sent a file', () => {
  let mockClient;
  beforeEach(() => {
    mockClient = { on: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn(), publish: jest.fn() };
    mqtt.connect.mockReturnValue(mockClient);
  });
  afterEach(() => jest.clearAllMocks());

  const responses = () => mockClient.publish.mock.calls
    .filter(([t]) => t.endsWith('/manage/response'))
    .map(([, p]) => JSON.parse(p));
  const send = (body) => {
    const handler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    handler('homecore/plugins/plugin.test/manage/cmd', Buffer.from(JSON.stringify(body)));
  };

  test('reads it from file_path, and the file is gone once it has replied', async () => {
    const plugin = new FilePlugin();
    plugin.run();
    plugin.enableManagement({ intervalSecs: 3600, capabilities: new Capabilities([new Action({ id: 'restore', label: 'Restore' })]) });
    const id = `t${process.pid}b`;
    send({ request_id: 'c1', action: 'upload_chunk', upload_id: id, offset: 0, data: b64('backup') });
    send({ request_id: 'r1', action: 'restore', upload: { id, size: 6, name: 'x.json' }, keep: '1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(plugin.seen.text).toBe('backup');
    expect(plugin.seen.params.upload).toBeUndefined();
    expect(plugin.seen.params.keep).toBe('1');
    expect(responses().map((r) => [r.request_id, r.status])).toEqual([['c1', 'ok'], ['r1', 'ok']]);
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(plugin.seen.params.file_path)).toBe(false);
  });

  test('is refused when the file did not arrive whole', async () => {
    const plugin = new FilePlugin();
    plugin.run();
    plugin.enableManagement({ intervalSecs: 3600, capabilities: new Capabilities([new Action({ id: 'restore', label: 'Restore' })]) });
    send({ request_id: 'r2', action: 'restore', upload: { id: `t${process.pid}c`, size: 6 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(plugin.seen).toBeNull();
    expect(responses().find((r) => r.request_id === 'r2')).toMatchObject({ status: 'error', error: 'the file did not arrive whole' });
  });
});

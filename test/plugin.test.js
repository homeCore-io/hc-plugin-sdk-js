'use strict';

jest.mock('mqtt');

const mqtt = require('mqtt');
const { PluginBase } = require('../index');

// Concrete plugin for testing
class TestPlugin extends PluginBase {
  constructor(options) {
    super({ pluginId: 'plugin.test', ...options });
    this.commands = [];
    this.connectCalled = false;
  }

  onConnect() {
    this.connectCalled = true;
  }

  onCommand(deviceId, payload) {
    this.commands.push({ deviceId, payload });
  }
}

describe('PluginBase', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      on:          jest.fn(),
      subscribe:   jest.fn(),
      unsubscribe: jest.fn(),
      publish:     jest.fn(),
    };
    mqtt.connect.mockReturnValue(mockClient);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  test('run() connects to the broker with correct URL and clientId', () => {
    const plugin = new TestPlugin();
    plugin.run();
    expect(mqtt.connect).toHaveBeenCalledWith(
      'mqtt://127.0.0.1:1883',
      expect.objectContaining({ clientId: 'plugin.test', clean: true }),
    );
  });

  test('run() sets credentials when password provided', () => {
    const plugin = new TestPlugin({ password: 'secret' });
    plugin.run();
    expect(mqtt.connect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ username: 'plugin.test', password: 'secret' }),
    );
  });

  test('run() omits credentials when no password', () => {
    const plugin = new TestPlugin();
    plugin.run();
    const opts = mqtt.connect.mock.calls[0][1];
    expect(opts).not.toHaveProperty('username');
    expect(opts).not.toHaveProperty('password');
  });

  test('registering a device subscribes to that device only', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.registerDeviceTyped('light.01', 'One', 'light');
    expect(mockClient.subscribe).toHaveBeenCalledWith(
      'homecore/devices/light.01/cmd',
      { qos: 1 },
    );
    expect(mockClient.subscribe).not.toHaveBeenCalledWith(
      'homecore/devices/+/cmd',
      expect.anything(),
    );
  });

  test('reconnect re-subscribes to the devices already known', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.registerDeviceTyped('light.01', 'One', 'light');
    mockClient.subscribe.mockClear();
    const connectHandler = mockClient.on.mock.calls.find(([e]) => e === 'connect')[1];
    connectHandler();
    expect(mockClient.subscribe).toHaveBeenCalledWith(
      'homecore/devices/light.01/cmd',
      { qos: 1 },
    );
  });

  test('run() calls onConnect() after broker connection', () => {
    const plugin = new TestPlugin();
    plugin.run();
    expect(plugin.connectCalled).toBe(false);
    const connectHandler = mockClient.on.mock.calls.find(([e]) => e === 'connect')[1];
    connectHandler();
    expect(plugin.connectCalled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Publish methods
  // ---------------------------------------------------------------------------

  test('publishState sends retained QoS 1 message', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.publishState('light.01', { on: true, brightness: 200 });
    expect(mockClient.publish).toHaveBeenCalledWith(
      'homecore/devices/light.01/state',
      JSON.stringify({ on: true, brightness: 200 }),
      { retain: true, qos: 1 },
      expect.any(Function),
    );
  });

  test('publishState attaches _hc.change metadata when provided', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.publishState('light.01', { on: true }, {
      change: { kind: 'external', source: 'wall_switch' },
    });
    expect(mockClient.publish).toHaveBeenCalledWith(
      'homecore/devices/light.01/state',
      JSON.stringify({
        on: true,
        _hc: { change: { kind: 'external', source: 'wall_switch' } },
      }),
      { retain: true, qos: 1 },
      expect.any(Function),
    );
  });

  test('publishStatePartial sends non-retained QoS 1 message', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.publishStatePartial('light.01', { brightness: 100 });
    expect(mockClient.publish).toHaveBeenCalledWith(
      'homecore/devices/light.01/state/partial',
      JSON.stringify({ brightness: 100 }),
      { retain: false, qos: 1 },
      expect.any(Function),
    );
  });

  test('publishStateForCommand preserves HomeCore command metadata', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.publishStateForCommand(
      'light.01',
      { on: true },
      {
        on: true,
        _hc: {
          command: {
            changed_at: '2026-04-01T12:00:00Z',
            kind: 'homecore',
            source: 'api',
            correlation_id: 'corr-1',
          },
        },
      },
    );
    expect(mockClient.publish).toHaveBeenCalledWith(
      'homecore/devices/light.01/state',
      JSON.stringify({
        on: true,
        _hc: {
          change: {
            changed_at: '2026-04-01T12:00:00Z',
            kind: 'homecore',
            source: 'api',
            correlation_id: 'corr-1',
          },
        },
      }),
      { retain: true, qos: 1 },
      expect.any(Function),
    );
  });

  test('registerDevice publishes to plugin register topic', () => {
    const plugin = new TestPlugin();
    plugin.run();
    const caps = { on: { type: 'boolean' } };
    plugin.registerDevice('light.01', 'Test Light', caps, 'living_room');

    expect(mockClient.publish).toHaveBeenCalledTimes(1);
    const [topic, payloadStr, opts] = mockClient.publish.mock.calls[0];
    const payload = JSON.parse(payloadStr);

    expect(topic).toBe('homecore/plugins/plugin.test/register');
    expect(opts).toEqual({ qos: 1 });
    expect(payload.device_id).toBe('light.01');
    expect(payload.plugin_id).toBe('plugin.test');
    expect(payload.name).toBe('Test Light');
    expect(payload.area).toBe('living_room');
    expect(payload.capabilities).toEqual(caps);
  });

  test('registerDevice uses null area when omitted', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.registerDevice('light.01', 'Test Light', {});
    const payload = JSON.parse(mockClient.publish.mock.calls[0][1]);
    expect(payload.area).toBeNull();
  });

  test('registerDeviceTyped publishes device_type instead of capabilities', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.registerDeviceTyped('light.01', 'Test Light', 'light', 'living_room');

    expect(mockClient.publish).toHaveBeenCalledTimes(1);
    const [topic, payloadStr, opts] = mockClient.publish.mock.calls[0];
    const payload = JSON.parse(payloadStr);

    expect(topic).toBe('homecore/plugins/plugin.test/register');
    expect(opts).toEqual({ qos: 1 });
    expect(payload.device_id).toBe('light.01');
    expect(payload.plugin_id).toBe('plugin.test');
    expect(payload.name).toBe('Test Light');
    expect(payload.device_type).toBe('light');
    expect(payload.area).toBe('living_room');
    expect(payload.capabilities).toBeUndefined();
  });

  test('registerDeviceTyped uses null area when omitted', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.registerDeviceTyped('sensor.01', 'Temp Sensor', 'temperature_sensor');
    const payload = JSON.parse(mockClient.publish.mock.calls[0][1]);
    expect(payload.area).toBeNull();
    expect(payload.device_type).toBe('temperature_sensor');
  });

  test('unregisterDevice clears retained topics and publishes unregister command', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.unregisterDevice('sensor.01');

    expect(mockClient.publish).toHaveBeenNthCalledWith(
      1,
      'homecore/devices/sensor.01/state',
      '',
      { retain: true, qos: 1 },
      expect.any(Function),
    );
    expect(mockClient.publish).toHaveBeenNthCalledWith(
      2,
      'homecore/devices/sensor.01/availability',
      '',
      { retain: true, qos: 1 },
      expect.any(Function),
    );
    expect(mockClient.publish).toHaveBeenNthCalledWith(
      3,
      'homecore/devices/sensor.01/schema',
      '',
      { retain: true, qos: 1 },
      expect.any(Function),
    );
    expect(mockClient.publish).toHaveBeenNthCalledWith(
      4,
      'homecore/plugins/plugin.test/unregister',
      JSON.stringify({ device_id: 'sensor.01' }),
      { qos: 1 },
      expect.any(Function),
    );
  });

  test('publishAvailability sends "online" when available=true', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.publishAvailability('light.01', true);
    expect(mockClient.publish).toHaveBeenCalledWith(
      'homecore/devices/light.01/availability',
      'online',
      { retain: true, qos: 1 },
      expect.any(Function),
    );
  });

  test('publishAvailability sends "offline" when available=false', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.publishAvailability('light.01', false);
    expect(mockClient.publish).toHaveBeenCalledWith(
      'homecore/devices/light.01/availability',
      'offline',
      { retain: true, qos: 1 },
      expect.any(Function),
    );
  });

  test('publishPluginStatus publishes to plugin status topic', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.publishPluginStatus('active');
    expect(mockClient.publish).toHaveBeenCalledWith(
      'homecore/plugins/plugin.test/status',
      'active',
      { retain: true, qos: 1 },
      expect.any(Function),
    );
  });

  // ---------------------------------------------------------------------------
  // Command routing
  // ---------------------------------------------------------------------------

  test('onCommand is called when a cmd message arrives', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.subscribeCommands('light.01');
    const messageHandler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    messageHandler(
      'homecore/devices/light.01/cmd',
      Buffer.from(JSON.stringify({ on: true })),
    );
    expect(plugin.commands).toHaveLength(1);
    expect(plugin.commands[0]).toEqual({ deviceId: 'light.01', payload: { on: true } });
  });

  test('invalid JSON in cmd payload is handled gracefully', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.subscribeCommands('light.01');
    const messageHandler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    messageHandler('homecore/devices/light.01/cmd', Buffer.from('not-json'));
    expect(plugin.commands).toHaveLength(1);
    expect(plugin.commands[0].payload).toHaveProperty('raw');
  });

  test('non-cmd topics are silently ignored', () => {
    const plugin = new TestPlugin();
    plugin.run();
    const messageHandler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    messageHandler('homecore/devices/light.01/state', Buffer.from('{}'));
    expect(plugin.commands).toHaveLength(0);
  });

  test('messages with wrong prefix are ignored', () => {
    const plugin = new TestPlugin();
    plugin.run();
    const messageHandler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    messageHandler('other/devices/light.01/cmd', Buffer.from('{}'));
    expect(plugin.commands).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Safety checks
  // ---------------------------------------------------------------------------

  test('publish before run() logs a warning without throwing', () => {
    const plugin = new TestPlugin();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    plugin.publishState('light.01', { on: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('onCommand throws if not overridden', () => {
    class BrokenPlugin extends PluginBase {}
    const p = new BrokenPlugin({ pluginId: 'plugin.broken' });
    expect(() => p.onCommand('d', {})).toThrow('must implement onCommand');
  });

  test('missing pluginId throws in constructor', () => {
    expect(() => new TestPlugin({ pluginId: undefined })).toThrow('pluginId is required');
  });

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  test('uses environment variables for broker config', () => {
    process.env.HC_BROKER_HOST = '10.0.0.1';
    process.env.HC_BROKER_PORT = '1884';
    try {
      const plugin = new TestPlugin({ pluginId: 'plugin.test' });
      expect(plugin.brokerHost).toBe('10.0.0.1');
      expect(plugin.brokerPort).toBe(1884);
    } finally {
      delete process.env.HC_BROKER_HOST;
      delete process.env.HC_BROKER_PORT;
    }
  });

  test('explicit params override env vars', () => {
    process.env.HC_BROKER_HOST = '10.0.0.1';
    try {
      const plugin = new TestPlugin({ brokerHost: '192.168.0.1' });
      expect(plugin.brokerHost).toBe('192.168.0.1');
    } finally {
      delete process.env.HC_BROKER_HOST;
    }
  });

  test('run() returns the mqtt client', () => {
    const plugin = new TestPlugin();
    const result = plugin.run();
    expect(result).toBe(mockClient);
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('device isolation', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      on: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn(), publish: jest.fn(),
    };
    mqtt.connect.mockReturnValue(mockClient);
  });
  afterEach(() => jest.clearAllMocks());

  const handlerFor = () => mockClient.on.mock.calls.find(([e]) => e === 'message')[1];

  // The SDK used to subscribe to `homecore/devices/+/cmd`, so every plugin saw
  // every other plugin's commands and could act on them.
  test('a command for another plugin device is ignored', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.registerDeviceTyped('light.mine', 'Mine', 'light');
    handlerFor()('homecore/devices/light.theirs/cmd', Buffer.from('{"on":true}'));
    expect(plugin.commands).toHaveLength(0);
  });

  test('unregistering stops delivery', () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.registerDeviceTyped('light.01', 'One', 'light');
    plugin.unregisterDevice('light.01');
    handlerFor()('homecore/devices/light.01/cmd', Buffer.from('{"on":true}'));
    expect(plugin.commands).toHaveLength(0);
    expect(mockClient.unsubscribe).toHaveBeenCalledWith('homecore/devices/light.01/cmd');
  });
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

const { PluginNotice, NoticeLevel, Capabilities, Action, StreamContext, StreamTerminated } = require('../index');

describe('notices', () => {
  let mockClient;
  const beats = () => mockClient.publish.mock.calls
    .filter(([t]) => t.endsWith('/heartbeat'))
    .map(([, p]) => JSON.parse(p));

  beforeEach(() => {
    mockClient = {
      on: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn(), publish: jest.fn(),
    };
    mqtt.connect.mockReturnValue(mockClient);
  });
  afterEach(() => jest.clearAllMocks());

  const managed = () => {
    const plugin = new TestPlugin();
    plugin.run();
    plugin.enableManagement({ intervalSecs: 3600 });
    return plugin;
  };

  test('raise and clear', () => {
    const plugin = managed();
    plugin.notices.raise(PluginNotice.error('bridge_unreachable', 'gone'));
    expect(plugin.notices.has('bridge_unreachable')).toBe(true);
    plugin.notices.clear('bridge_unreachable');
    expect(plugin.notices.has('bridge_unreachable')).toBe(false);
  });

  test('clearing something not raised is a no-op and does not republish', () => {
    const plugin = managed();
    const before = mockClient.publish.mock.calls.length;
    plugin.notices.clear('never_raised');
    expect(mockClient.publish.mock.calls.length).toBe(before);
  });

  test('re-raising a code replaces it', () => {
    const plugin = managed();
    plugin.notices.raise(PluginNotice.warning('c', 'first'));
    plugin.notices.raise(PluginNotice.error('c', 'second'));
    expect(plugin.notices.size).toBe(1);
    expect(plugin.notices.snapshot()[0].message).toBe('second');
    expect(plugin.notices.snapshot()[0].level).toBe(NoticeLevel.ERROR);
  });

  test('wire form omits remedy when absent', () => {
    const plugin = managed();
    plugin.notices.set([
      PluginNotice.info('a', 'no remedy'),
      PluginNotice.info('b', 'has one', { remedy: 'do this' }),
    ]);
    const wire = Object.fromEntries(plugin.notices.toWire().map((n) => [n.code, n]));
    expect(wire.a.remedy).toBeUndefined();
    expect(wire.b.remedy).toBe('do this');
    expect(wire.a.level).toBe('info');
  });

  test('a change publishes a heartbeat immediately', () => {
    const plugin = managed();
    const before = beats().length;
    plugin.notices.raise(PluginNotice.warning('c', 'm'));
    const after = beats();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1].notices[0].code).toBe('c');
  });

  test('re-deriving the same set does not republish', () => {
    const plugin = managed();
    plugin.notices.set([PluginNotice.warning('c', 'm')]);
    const before = mockClient.publish.mock.calls.length;
    plugin.notices.set([PluginNotice.warning('c', 'm')]);
    expect(mockClient.publish.mock.calls.length).toBe(before);
  });

  test('a cleared notice leaves the next heartbeat', () => {
    const plugin = managed();
    plugin.notices.raise(PluginNotice.error('gone', 'transient'));
    plugin.notices.clear('gone');
    const last = beats().pop();
    expect(last.notices).toEqual([]);
  });

  test('heartbeat carries device_count and versions', () => {
    const plugin = managed();
    plugin.registerDeviceTyped('light.01', 'One', 'light');
    plugin._publishHeartbeat();
    const hb = beats().pop();
    expect(hb.device_count).toBe(1);
    expect(hb.protocol_version).toBeDefined();
    expect(hb.sdk_version).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Capability actions
// ---------------------------------------------------------------------------

class ActionPlugin extends TestPlugin {
  constructor(options) {
    super(options);
    this.seen = [];
  }

  onAction(action, params, ctx) {
    this.seen.push([action, params]);
    if (action === 'immediate') return { echo: params };
    if (action === 'boom') throw new Error('handler exploded');
    if (action === 'slow') return Promise.resolve({ ok: true });
    if (action === 'sweep') {
      ctx.progress({ percent: 50, message: 'halfway' });
      ctx.itemAdd({ serial: 'abc' });
      ctx.complete({ found: 1 });
      return null;
    }
    if (action === 'silent') return null;  // streaming handler that never terminates
    return null;
  }
}

describe('capability actions', () => {
  let mockClient;

  const responses = () => mockClient.publish.mock.calls
    .filter(([t]) => t.endsWith('/manage/response'))
    .map(([, p]) => JSON.parse(p));
  const streamEvents = () => mockClient.publish.mock.calls
    .filter(([t]) => t.includes('/commands/') && arguments)
    .filter(([, p]) => p !== '')
    .map(([, p]) => JSON.parse(p));

  beforeEach(() => {
    mockClient = {
      on: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn(), publish: jest.fn(),
    };
    mqtt.connect.mockReturnValue(mockClient);
  });
  afterEach(() => jest.clearAllMocks());

  const setup = (actions) => {
    const plugin = new ActionPlugin();
    plugin.run();
    plugin.enableManagement({
      intervalSecs: 3600,
      capabilities: new Capabilities(actions),
    });
    return plugin;
  };

  const send = (plugin, body) => {
    const handler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    handler(
      'homecore/plugins/plugin.test/manage/cmd',
      Buffer.from(JSON.stringify({ request_id: 'r1', ...body })),
    );
  };

  test('the manifest is published retained', () => {
    setup([new Action({ id: 'immediate', label: 'Do it', description: 'desc' })]);
    const call = mockClient.publish.mock.calls.find(([t]) => t.endsWith('/capabilities'));
    expect(call).toBeDefined();
    expect(call[2]).toEqual({ qos: 1, retain: true });
    const manifest = JSON.parse(call[1]);
    expect(manifest.spec).toBe('1');
    expect(manifest.plugin_id).toBe('plugin.test');
    expect(manifest.actions[0].id).toBe('immediate');
    expect(manifest.actions[0].requires_role).toBe('user');
    // Absent optionals are omitted, not null — matching Rust.
    expect(manifest.actions[0].params).toBeUndefined();
  });

  test('an immediate action returns its result', async () => {
    const plugin = setup([new Action({ id: 'immediate', label: 'Do it' })]);
    send(plugin, { action: 'immediate', value: 7 });
    await Promise.resolve();
    const resp = responses().pop();
    expect(resp.status).toBe('ok');
    expect(resp.echo).toEqual({ value: 7 });
    expect(resp.echo.action).toBeUndefined();
  });

  test('an async handler is awaited', async () => {
    const plugin = setup([new Action({ id: 'slow', label: 'Slow' })]);
    send(plugin, { action: 'slow' });
    await new Promise((r) => setImmediate(r));
    expect(responses().pop()).toMatchObject({ status: 'ok', ok: true });
  });

  test('an unknown action is an error', async () => {
    const plugin = setup([new Action({ id: 'immediate', label: 'Do it' })]);
    send(plugin, { action: 'nope' });
    await new Promise((r) => setImmediate(r));
    const resp = responses().pop();
    expect(resp.status).toBe('error');
    expect(resp.error).toMatch(/unknown action/);
  });

  test('a throwing handler becomes an error response, not a crash', async () => {
    const plugin = setup([new Action({ id: 'boom', label: 'Boom' })]);
    send(plugin, { action: 'boom' });
    await new Promise((r) => setImmediate(r));
    const resp = responses().pop();
    expect(resp.status).toBe('error');
    expect(resp.error).toMatch(/handler exploded/);
  });

  test('get_config answers with the `data` key core reads', () => {
    const plugin = setup([]);
    const fsMod = require('fs');
    jest.spyOn(fsMod, 'readFileSync').mockReturnValue('a = 1\n');
    plugin._configPath = '/tmp/whatever.toml';
    send(plugin, { action: 'get_config' });
    expect(responses().pop()).toMatchObject({ status: 'ok', data: 'a = 1\n' });
    fsMod.readFileSync.mockRestore();
  });
});

describe('streaming actions', () => {
  let mockClient;

  const responses = () => mockClient.publish.mock.calls
    .filter(([t]) => t.endsWith('/manage/response'))
    .map(([, p]) => JSON.parse(p));
  const streamCalls = () => mockClient.publish.mock.calls
    .filter(([t]) => t.includes('/commands/'));

  beforeEach(() => {
    mockClient = {
      on: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn(), publish: jest.fn(),
    };
    mqtt.connect.mockReturnValue(mockClient);
  });
  afterEach(() => jest.clearAllMocks());

  const setup = () => {
    const plugin = new ActionPlugin();
    plugin.run();
    plugin.enableManagement({
      intervalSecs: 3600,
      capabilities: new Capabilities([
        new Action({ id: 'sweep', label: 'Sweep', stream: true, itemKey: 'serial' }),
        new Action({ id: 'silent', label: 'Silent', stream: true }),
      ]),
    });
    return plugin;
  };

  const run = async (plugin, action) => {
    const handler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    handler(
      'homecore/plugins/plugin.test/manage/cmd',
      Buffer.from(JSON.stringify({ action, request_id: 'r1' })),
    );
    // Let the promise chain in _startStream settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  test('answers accepted with the stream topic', async () => {
    const plugin = setup();
    await run(plugin, 'sweep');
    const resp = responses()[0];
    expect(resp.status).toBe('accepted');
    expect(resp.stream_topic).toBe('homecore/plugins/plugin.test/commands/r1/events');
  });

  test('stages are emitted in order, each with request_id and ts', async () => {
    const plugin = setup();
    await run(plugin, 'sweep');
    const events = streamCalls().filter(([, p]) => p !== '').map(([, p]) => JSON.parse(p));
    expect(events.map((e) => e.stage)).toEqual(['progress', 'item', 'complete']);
    for (const e of events) {
      expect(e.request_id).toBe('r1');
      expect(e.ts).toBeDefined();
    }
  });

  test('the stream topic is retained-cleared at the end', async () => {
    const plugin = setup();
    await run(plugin, 'sweep');
    const last = streamCalls().pop();
    expect(last[1]).toBe('');
    expect(last[2]).toEqual({ qos: 1, retain: true });
  });

  test('a handler that never terminates gets a synthetic error', async () => {
    const plugin = setup();
    await run(plugin, 'silent');
    const events = streamCalls().filter(([, p]) => p !== '').map(([, p]) => JSON.parse(p));
    const last = events.pop();
    expect(last.stage).toBe('error');
    expect(last.data.reason).toBe('plugin_dropped_stream');
  });

  test('emitting after a terminal stage throws', () => {
    const plugin = setup();
    const ctx = new StreamContext(plugin, 'r9', 'sweep');
    ctx.complete({});
    expect(() => ctx.progress({ message: 'too late' })).toThrow(StreamTerminated);
  });

  test('cancel routes to the live stream', () => {
    const plugin = setup();
    const ctx = new StreamContext(plugin, 'r5', 'sweep');
    plugin._activeStreams.set('r5', ctx);
    const handler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    handler('homecore/plugins/plugin.test/manage/cmd', Buffer.from(JSON.stringify({
      action: 'cancel', request_id: 'r6', target_request_id: 'r5',
    })));
    expect(ctx.isCanceled()).toBe(true);
    expect(responses().pop().status).toBe('ok');
  });

  test('cancel for an unknown stream is an error', () => {
    const plugin = setup();
    const handler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    handler('homecore/plugins/plugin.test/manage/cmd', Buffer.from(JSON.stringify({
      action: 'cancel', request_id: 'r6', target_request_id: 'nope',
    })));
    expect(responses().pop().status).toBe('error');
  });

  test('respond resolves awaitRespond', async () => {
    const plugin = setup();
    const ctx = new StreamContext(plugin, 'r7', 'pair');
    plugin._activeStreams.set('r7', ctx);
    const pending = ctx.awaitRespond(2000);
    const handler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    handler('homecore/plugins/plugin.test/manage/cmd', Buffer.from(JSON.stringify({
      action: 'respond', request_id: 'r8', target_request_id: 'r7', response: { pin: '1234' },
    })));
    await expect(pending).resolves.toEqual({ pin: '1234' });
  });
});

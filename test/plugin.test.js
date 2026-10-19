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

// ---------------------------------------------------------------------------
// Device persistence
// ---------------------------------------------------------------------------

const fsMod = require('fs');
const osMod = require('os');
const pathMod = require('path');
const { scopedSnapshotPath } = require('../index');

describe('device persistence', () => {
  let mockClient;
  let dir;
  let snapPath;

  beforeEach(() => {
    mockClient = {
      on: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn(), publish: jest.fn(),
    };
    mqtt.connect.mockReturnValue(mockClient);
    dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'hcsdk-'));
    snapPath = pathMod.join(dir, '.published-device-ids.json');
  });

  afterEach(() => {
    jest.clearAllMocks();
    fsMod.rmSync(dir, { recursive: true, force: true });
  });

  const plugin = () => { const p = new TestPlugin(); p.run(); return p; };
  const scoped = () => snapPath.replace('.json', '.plugin.test.json');

  // Real deployments keep every plugin's config in one directory, and every
  // plugin derives this path the same way — unscoped they share one file and
  // retire each other's devices.
  test('the snapshot path is scoped to the plugin', () => {
    const hue = scopedSnapshotPath('/cfg/.published-device-ids.json', 'plugin.hue');
    const sonos = scopedSnapshotPath('/cfg/.published-device-ids.json', 'plugin.sonos');
    expect(hue).not.toBe(sonos);
    expect(hue.endsWith('.published-device-ids.plugin.hue.json')).toBe(true);
  });

  test('scoping is idempotent', () => {
    const once = scopedSnapshotPath('/cfg/.published-device-ids.json', 'plugin.hue');
    expect(scopedSnapshotPath(once, 'plugin.hue')).toBe(once);
  });

  test('registered devices are written to disk', () => {
    const p = plugin();
    p.enableDevicePersistence(snapPath);
    p.registerDeviceTyped('light.01', 'One', 'light');
    p.registerDeviceTyped('light.02', 'Two', 'light');
    expect(JSON.parse(fsMod.readFileSync(scoped(), 'utf8'))).toEqual(['light.01', 'light.02']);
  });

  test('a new process remembers the previous run', () => {
    const first = plugin();
    first.enableDevicePersistence(snapPath);
    first.registerDeviceTyped('light.01', 'One', 'light');

    const second = plugin();
    second.enableDevicePersistence(snapPath);
    expect(second._devices.has('light.01')).toBe(true);
  });

  test('reconcile unregisters what vanished', () => {
    const p = plugin();
    p.enableDevicePersistence(snapPath);
    p.registerDeviceTyped('light.01', 'One', 'light');
    p.registerDeviceTyped('light.02', 'Two', 'light');

    const report = p.reconcileDevices(['light.01']);
    expect(report.staleUnregistered).toEqual(['light.02']);
    expect(report.unknownInLive).toEqual([]);
    expect(p._devices.has('light.02')).toBe(false);
    expect(p._devices.has('light.01')).toBe(true);
  });

  // The whole point of persisting: a device dropped while the plugin was down
  // is invisible to a fresh process without the snapshot.
  test('reconcile retires a device from an earlier run', () => {
    const first = plugin();
    first.enableDevicePersistence(snapPath);
    first.registerDeviceTyped('light.gone', 'Gone', 'light');

    const second = plugin();
    second.enableDevicePersistence(snapPath);
    expect(second.reconcileDevices([]).staleUnregistered).toEqual(['light.gone']);
  });

  test('reconcile reports ids it never registered', () => {
    const p = plugin();
    p.enableDevicePersistence(snapPath);
    const report = p.reconcileDevices(['light.surprise']);
    expect(report.unknownInLive).toEqual(['light.surprise']);
    expect(report.staleUnregistered).toEqual([]);
  });

  test('a corrupt snapshot is survivable', () => {
    // Losing the snapshot costs reconcile, not the plugin.
    fsMod.writeFileSync(scoped(), '{not json');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const p = plugin();
    p.enableDevicePersistence(snapPath);
    expect(warn).toHaveBeenCalled();
    p.registerDeviceTyped('light.01', 'One', 'light');
    expect(p._devices.has('light.01')).toBe(true);
    warn.mockRestore();
  });

  test('persistence is optional', () => {
    const p = plugin();
    p.registerDeviceTyped('light.01', 'One', 'light');
    expect(p._devices.has('light.01')).toBe(true);
    expect(fsMod.existsSync(scoped())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alerts — what a plugin says needs attention about its devices. The wire
// shape is core's hc_types::alert::{PluginAlert, PluginAlertKind}; these pin it.
// ---------------------------------------------------------------------------

describe('alerts', () => {
  const {
    AlertAction, AlertActionTarget, AlertSeverity, PluginAlert, PluginAlertKind,
    Capabilities: Caps,
  } = require('../index');

  let mockClient;

  beforeEach(() => {
    mockClient = {
      on: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn(), publish: jest.fn(),
    };
    mqtt.connect.mockReturnValue(mockClient);
  });
  afterEach(() => jest.clearAllMocks());

  const started = () => {
    const plugin = new TestPlugin();
    plugin.run();
    return plugin;
  };
  const alertPublishes = () => mockClient.publish.mock.calls
    .filter(([t]) => t.endsWith('/alerts'))
    .map(([t, p, o]) => [t, p, o]);

  test('a bare alert carries only topic and reason', () => {
    expect(JSON.parse(JSON.stringify(
      new PluginAlert('firmware_update', 'Firmware 17.0.0 is out'),
    ))).toEqual({ topic: 'firmware_update', reason: 'Firmware 17.0.0 is out' });
  });

  test('a full alert matches the Rust wire form', () => {
    const alert = new PluginAlert('firmware_update', 'Firmware 17.0.0 is out', {
      key: '17.0.0',
      message: 'Kitchen strip: firmware 17.0.0 is out',
      severity: AlertSeverity.INFO,
      action: new AlertAction('Update…', 'install_firmware', {
        params: { version: '17.0.0' }, confirm: true,
      }),
      since: new Date(Date.UTC(2026, 9, 19, 12, 0, 0)),
    });
    expect(alert.toJSON()).toEqual({
      topic: 'firmware_update',
      key: '17.0.0',
      reason: 'Firmware 17.0.0 is out',
      message: 'Kitchen strip: firmware 17.0.0 is out',
      severity: 'info',
      // target is omitted when it is the default, `device`.
      action: {
        label: 'Update…',
        id: 'install_firmware',
        params: { version: '17.0.0' },
        confirm: true,
      },
      since: '2026-10-19T12:00:00.000Z',
    });
  });

  test('an action omits target, params and confirm by default', () => {
    expect(new AlertAction('Re-pair', 'pair').toJSON()).toEqual({ label: 'Re-pair', id: 'pair' });
  });

  test('a plugin target is spelled out', () => {
    expect(new AlertAction('Sign in', 'login', { target: AlertActionTarget.PLUGIN }).toJSON())
      .toEqual({ label: 'Sign in', id: 'login', target: 'plugin' });
  });

  test('an alert kind always carries severity and default_on', () => {
    expect(new PluginAlertKind('bridge_button', 'Bridge needs its button pressed').toJSON())
      .toEqual({
        topic: 'bridge_button',
        label: 'Bridge needs its button pressed',
        severity: 'warning',
        default_on: true,
      });
    expect(new PluginAlertKind('firmware_update', 'Firmware update available', {
      description: 'A newer firmware is published.',
      severity: AlertSeverity.INFO,
      defaultOn: false,
    }).toJSON()).toEqual({
      topic: 'firmware_update',
      label: 'Firmware update available',
      description: 'A newer firmware is published.',
      severity: 'info',
      default_on: false,
    });
  });

  test('alert kinds ride on the manifest', () => {
    const plugin = started();
    plugin.enableManagement({
      intervalSecs: 3600,
      capabilities: new Caps([], {
        alertKinds: [new PluginAlertKind('firmware_update', 'Firmware update available')],
      }),
    });
    const call = mockClient.publish.mock.calls.find(([t]) => t.endsWith('/capabilities'));
    expect(call[2]).toEqual({ qos: 1, retain: true });
    const manifest = JSON.parse(call[1]);
    expect(manifest.actions).toEqual([]);
    expect(manifest.alert_kinds).toEqual([{
      topic: 'firmware_update',
      label: 'Firmware update available',
      severity: 'warning',
      default_on: true,
    }]);
  });

  test('a manifest without alert kinds does not mention them', () => {
    expect(new Caps().toJSON()).not.toHaveProperty('alert_kinds');
  });

  test('setAlerts publishes the whole list retained', () => {
    const plugin = started();
    plugin.setAlerts('wled_1', [new PluginAlert('firmware_update', 'out', { key: '17.0.0' })]);
    expect(alertPublishes()).toEqual([[
      'homecore/devices/wled_1/alerts',
      JSON.stringify([{ topic: 'firmware_update', key: '17.0.0', reason: 'out' }]),
      { retain: true, qos: 1 },
    ]]);
  });

  test('setPluginAlerts publishes to the plugin topic', () => {
    const plugin = started();
    plugin.setPluginAlerts([new PluginAlert('login_expired', 'The login expired')]);
    const [[topic, payload, opts]] = alertPublishes();
    expect(topic).toBe('homecore/plugins/plugin.test/alerts');
    expect(JSON.parse(payload)).toEqual([{ topic: 'login_expired', reason: 'The login expired' }]);
    expect(opts).toEqual({ retain: true, qos: 1 });
  });

  test('an empty list clears: it is published, and forgotten', () => {
    const plugin = started();
    plugin.setAlerts('wled_1', [new PluginAlert('firmware_update', 'out')]);
    plugin.setAlerts('wled_1', []);
    // The empty list goes out — it is what clears the retained message.
    expect(alertPublishes().at(-1)).toEqual([
      'homecore/devices/wled_1/alerts', '[]', { retain: true, qos: 1 },
    ]);
    expect(plugin._alerts.size).toBe(0);
  });

  test('the last list per topic is held', () => {
    const plugin = started();
    plugin.setAlerts('a', [new PluginAlert('k', 'first')]);
    plugin.setAlerts('a', [new PluginAlert('k', 'second')]);
    plugin.setAlerts('b', [new PluginAlert('k', 'other')]);
    plugin.setPluginAlerts([new PluginAlert('p', 'mine')]);
    const held = Object.fromEntries(
      [...plugin._alerts].map(([t, p]) => [t, JSON.parse(p)[0].reason]),
    );
    expect(held).toEqual({
      'homecore/devices/a/alerts': 'second',
      'homecore/devices/b/alerts': 'other',
      'homecore/plugins/plugin.test/alerts': 'mine',
    });
  });

  test('held alerts are said again on every reconnect', () => {
    // A restarted core's broker has forgotten its retained messages; an alert
    // set an hour ago must not vanish because core did.
    const plugin = started();
    plugin.setAlerts('wled_1', [new PluginAlert('firmware_update', 'out')]);
    plugin.setAlerts('gone', [new PluginAlert('x', 'y')]);
    plugin.setAlerts('gone', []);
    mockClient.publish.mockClear();

    const connectHandler = mockClient.on.mock.calls.find(([e]) => e === 'connect')[1];
    connectHandler(); // first connect
    connectHandler(); // a reconnect
    const once = [
      'homecore/devices/wled_1/alerts',
      JSON.stringify([{ topic: 'firmware_update', reason: 'out' }]),
      { retain: true, qos: 1 },
    ];
    expect(alertPublishes()).toEqual([once, once]);
  });
});

describe("the plugin's own screens", () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { ui } = require('../index');

  // The build of the shared fixture below. Every homeCore SDK pins this same
  // value — it is what plugin_sdk_rs::ui::load gives for these two files — so
  // one UI folder has one address whichever SDK serves it.
  const FIXTURE_BUILD = '6695a38681c3d6e7';
  const FIXTURE_MANIFEST = '{"host_api":1,"slots":[{"slot":"plugin.page","element":"hc-x-page"}]}';

  let mockClient;
  let tmp;
  const savedEnv = process.env.HC_PLUGIN_UI_DIR;
  const savedArgv = process.argv;

  beforeEach(() => {
    mockClient = {
      on: jest.fn(), subscribe: jest.fn(), unsubscribe: jest.fn(), publish: jest.fn(),
    };
    mqtt.connect.mockReturnValue(mockClient);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-ui-test-'));
    delete process.env.HC_PLUGIN_UI_DIR;
  });
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.HC_PLUGIN_UI_DIR;
    else process.env.HC_PLUGIN_UI_DIR = savedEnv;
    process.argv = savedArgv;
  });

  const folder = () => {
    fs.writeFileSync(path.join(tmp, 'manifest.json'), FIXTURE_MANIFEST);
    fs.writeFileSync(path.join(tmp, 'index.js'), 'export {}');
    return tmp;
  };
  const started = () => {
    const plugin = new TestPlugin();
    plugin.run();
    return plugin;
  };
  const send = (body) => {
    const handler = mockClient.on.mock.calls.find(([e]) => e === 'message')[1];
    handler(
      'homecore/plugins/plugin.test/manage/cmd',
      Buffer.from(JSON.stringify({ request_id: 'r1', ...body })),
    );
  };
  const responses = () => mockClient.publish.mock.calls
    .filter(([t]) => t.endsWith('/manage/response'))
    .map(([, p]) => JSON.parse(p));
  const manifests = () => mockClient.publish.mock.calls
    .filter(([t]) => t.endsWith('/capabilities'));

  test('the build is the one every SDK computes', () => {
    expect(ui.load(folder(), '1.2.3').build).toBe(FIXTURE_BUILD);
  });

  test('a UI folder is declared with a build that changes with its files', () => {
    const d = folder();
    const a = ui.load(d, '1.2.3');
    expect([a.version, a.entry, a.hostApi]).toEqual(['1.2.3', 'index.js', 1]);
    expect(a.build).toHaveLength(16);
    fs.writeFileSync(path.join(d, 'index.js'), 'export const x = 1');
    expect(ui.load(d, '1.2.3').build).not.toBe(a.build);
  });

  test('a folder without its entry or a manifest offers nothing', () => {
    expect(() => ui.load(tmp, '1')).toThrow(ui.UiError);
    fs.writeFileSync(path.join(tmp, 'manifest.json'), '{"host_api":1,"slots":[]}');
    expect(() => ui.load(tmp, '1')).toThrow(/isn't there/);
    fs.writeFileSync(path.join(tmp, 'index.js'), 'export {}');
    expect(() => ui.load(tmp, '1')).toThrow(/nowhere/);
  });

  // Which slots exist is homeCore's to say: an SDK that dropped the ones it
  // doesn't know would keep a plugin from ever offering a newer one.
  test('every slot is passed on as declared, unknown ones and fields included', () => {
    const later = { slot: 'future.slot', element: 'hc-x-later' };
    const card = {
      slot: 'dashboard.card',
      element: 'hc-x-card',
      label: 'Quick presets',
      description: 'One tap to a preset',
      forms: ['compact', 'large'],
      settings: 'hc-x-card-settings',
      someday: { nested: true },
    };
    const panel = { slot: 'device.panel', element: 'hc-x-panel', device_types: ['light'] };
    const odd = { slot: 'plugin.page', element: 'NoHyphen' };
    fs.writeFileSync(path.join(tmp, 'manifest.json'),
      JSON.stringify({ host_api: 1, slots: [later, card, panel, odd] }));
    fs.writeFileSync(path.join(tmp, 'index.js'), 'export {}');
    const got = JSON.parse(JSON.stringify(ui.load(tmp, '1.0.0'))).slots;
    expect(got).toEqual([later, card, panel, odd]);
  });

  test('an unusable version or entry offers nothing', () => {
    const d = folder();
    expect(() => ui.load(d, ' ')).toThrow(/version or entry/);
    fs.writeFileSync(path.join(d, 'manifest.json'),
      '{"host_api":1,"entry":"./index.js","slots":[{"slot":"plugin.page","element":"hc-x-page"}]}');
    expect(ui.load(d, '1').entry).toBe('./index.js');
    fs.mkdirSync(path.join(d, 'sub'));
    fs.writeFileSync(path.join(d, 'sub', 'manifest.json'),
      '{"host_api":1,"entry":"../index.js","slots":[{"slot":"plugin.page","element":"hc-x-page"}]}');
    expect(() => ui.load(path.join(d, 'sub'), '1')).toThrow(/version or entry/);
  });

  test('the manifest ui is the Rust wire form', () => {
    const v = new ui.PluginUi({
      hostApi: 1,
      version: '1.0.0',
      build: 'abc',
      slots: [new ui.UiSlot('plugin.page', 'hc-x-page'), new ui.UiSlot('device.panel', 'hc-x-p', ['light'])],
    });
    expect(JSON.parse(JSON.stringify(v))).toEqual({
      host_api: 1,
      version: '1.0.0',
      build: 'abc',
      entry: 'index.js',
      slots: [
        { slot: 'plugin.page', element: 'hc-x-page' },
        { slot: 'device.panel', element: 'hc-x-p', device_types: ['light'] },
      ],
    });
  });

  test('relative paths stay inside the folder', () => {
    for (const ok of ['index.js', 'a/b.js', './x.js']) expect(ui.relativePath(ok)).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a\\b', 'a/']) {
      expect(ui.relativePath(bad)).toBe(false);
    }
  });

  test('files go in pieces and never from outside the folder', () => {
    fs.writeFileSync(path.join(tmp, 'index.js'), 'abcdefghij');
    const p = (f, o, m) => {
      const r = ui.piece(tmp, f, o, m);
      return [r.data.toString(), r.done];
    };
    expect(p('index.js', 0, 4)).toEqual(['abcd', false]);
    expect(p('index.js', 8, 4)).toEqual(['ij', true]);
    expect(p('index.js', 6, 4)).toEqual(['ghij', true]);
    expect(p('index.js', 50, 4)).toEqual(['', true]);
    for (const bad of ['../etc/passwd', 'missing.js', '/etc/passwd']) {
      expect(() => ui.piece(tmp, bad, 0, 4)).toThrow(/^no such file$/);
    }
  });

  test('findDir prefers the env, then the package, then the source tree', () => {
    process.argv = [savedArgv[0], path.join(tmp, 'elsewhere', 'run.js')];
    const project = path.join(tmp, 'proj');
    const pkg = path.join(project, 'lib');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{}');
    expect(ui.findDir(pkg)).toBeNull();
    // A folder without a manifest doesn't count.
    fs.mkdirSync(path.join(project, 'ui', 'dist'), { recursive: true });
    expect(ui.findDir(pkg)).toBeNull();
    fs.writeFileSync(path.join(project, 'ui', 'dist', 'manifest.json'), '{}');
    expect(ui.findDir(pkg)).toBe(path.join(project, 'ui', 'dist'));
    fs.mkdirSync(path.join(pkg, 'ui'));
    fs.writeFileSync(path.join(pkg, 'ui', 'manifest.json'), '{}');
    expect(ui.findDir(pkg)).toBe(path.join(pkg, 'ui'));
    expect(ui.findDir(path.join(pkg, 'main.js'))).toBe(path.join(pkg, 'ui'));
    process.env.HC_PLUGIN_UI_DIR = '/somewhere';
    expect(ui.findDir(pkg)).toBe('/somewhere');
  });

  test('withUiDir puts ui on the manifest even with no actions', () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const plugin = started();
    expect(plugin.withUiDir(folder(), '2.0.0')).toBe(plugin);
    plugin.enableManagement({ intervalSecs: 3600 });
    const calls = manifests();
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toEqual({ qos: 1, retain: true });
    const m = JSON.parse(calls[0][1]);
    expect(m.plugin_id).toBe('plugin.test');
    expect(m.actions).toEqual([]);
    expect(m.ui).toEqual({
      host_api: 1,
      version: '2.0.0',
      build: FIXTURE_BUILD,
      entry: 'index.js',
      slots: [{ slot: 'plugin.page', element: 'hc-x-page' }],
    });
  });

  test('withUiDir on a missing folder warns and offers no UI', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = started();
    plugin.withUiDir(path.join(tmp, 'nope'), '1.0.0');
    expect(warn.mock.calls[0][0]).toMatch(/No plugin UI offered/);
    plugin.enableManagement({ intervalSecs: 3600 });
    expect(manifests()).toHaveLength(0);
    send({ action: 'ui_file', file: 'index.js' });
    expect(responses()).toEqual([
      { request_id: 'r1', status: 'error', error: 'no such file: this plugin serves no UI' },
    ]);
  });

  test('ui_file serves pieces in base64', () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    const plugin = started();
    const d = folder();
    const big = Buffer.alloc(256 * 1024);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 256;
    fs.writeFileSync(path.join(d, 'big.js'), big);
    plugin.withUiDir(d, '1.0.0');
    plugin.enableManagement({ intervalSecs: 3600 });

    send({ request_id: 'a', action: 'ui_file', file: 'index.js' });
    send({ request_id: 'b', action: 'ui_file', file: 'index.js', offset: 8, max: 1 });
    send({ request_id: 'c', action: 'ui_file', file: 'big.js' });
    send({ request_id: 'd', action: 'ui_file', file: 'big.js', max: 1e9 });
    send({ request_id: 'e', action: 'ui_file', file: 'big.js', max: 0 });
    send({ request_id: 'f', action: 'ui_file', file: '../manifest.json' });
    send({ request_id: 'g', action: 'ui_file', file: 'nope.js' });
    const r = Object.fromEntries(responses().map((x) => [x.request_id, x]));
    const bytes = (x) => Buffer.from(x.data, 'base64');

    expect(r.a).toEqual({
      request_id: 'a', status: 'ok', data: Buffer.from('export {}').toString('base64'), done: true,
    });
    expect(bytes(r.b).toString()).toBe('}');
    expect(r.b.done).toBe(true);
    // max defaults to 128 KiB, and is clamped to [1, 160 KiB].
    expect(bytes(r.c)).toHaveLength(131072);
    expect(r.c.done).toBe(false);
    expect(bytes(r.d)).toHaveLength(163840);
    expect(r.d.done).toBe(false);
    expect(bytes(r.e)).toHaveLength(1);
    expect(r.f).toEqual({ request_id: 'f', status: 'error', error: 'no such file' });
    expect(r.g).toEqual({ request_id: 'g', status: 'error', error: 'no such file' });
  });
});

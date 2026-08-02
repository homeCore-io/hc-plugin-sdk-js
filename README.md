# hc-plugin-sdk-js

[![CI](https://github.com/homeCore-io/hc-plugin-sdk-js/actions/workflows/ci.yml/badge.svg)](https://github.com/homeCore-io/hc-plugin-sdk-js/actions/workflows/ci.yml)

Write a [homeCore](https://github.com/homeCore-io/homeCore) plugin in Node.js.

Extend `PluginBase`, say what your devices are, handle commands. The SDK covers
the MQTT connection, registration, the management protocol, notices, and
capability actions.

```bash
npm install github:homeCore-io/hc-plugin-sdk-js#v0.2.0
```

Requires Node.js 18+.

Not on npm yet — install from the tag, which pins you to a known release the
same way the Rust SDK's git dependency does.

## Your first plugin

```javascript
const { PluginBase } = require('homecore-plugin-sdk');

class MyLight extends PluginBase {
  constructor() {
    super({ pluginId: 'plugin.mylight' });
  }

  onConnect() {
    // Register here, not in the constructor — this runs again after a reconnect.
    this.registerDeviceFull('light.01', 'Desk Lamp', { deviceType: 'light' });
    this.publishAvailability('light.01', true);
    this.publishState('light.01', { on: false, brightness: 0 });
  }

  onCommand(deviceId, payload) {
    // Do whatever the real device needs, then publish what actually happened —
    // homeCore never writes device state itself.
    const state = { on: !!payload.on };
    this.publishStateForCommand(deviceId, state, payload, 'mylight');
  }
}

new MyLight().run();
```

`run()` returns the mqtt.js client and keeps running. Point it at a broker with
constructor options, or the `HC_BROKER_HOST` / `HC_BROKER_PORT` /
`HC_PLUGIN_PASSWORD` environment variables.

## How a plugin fits into homeCore

Everything travels over MQTT. Your plugin owns its devices' state; homeCore owns
the rules and the UI.

```
your device  ←→  your plugin  ──state──▶  homeCore  ──▶  rules, UI, history
                              ◀──cmd────
```

Three consequences worth internalising:

1. **Publish what happened, not what was asked.** A command is a request. If the
   bulb refuses, publish the state it is actually in. That is why the UI can
   show a light as off after a failed command instead of lying.
2. **Register in `onConnect`.** It fires on every connect, so a reconnect
   re-registers and re-subscribes.
3. **You only see your own devices.** Registering a device subscribes to that
   device's command topic and nothing else.

## Installing it into homeCore

homeCore owns your plugin's config at `config/plugins/<plugin_id>.toml` and
passes the path as `process.argv[2]`:

```javascript
const configPath = process.argv[2] || 'config/config.toml';
```

Declare the plugin in homeCore's `homecore.toml` so it gets supervised:

```toml
[[plugins]]
id      = "plugin.mylight"
binary  = "/usr/bin/node"
config  = "config/plugins/plugin.mylight.toml"
enabled = true
```

## Management: heartbeat, config, actions

Call `enableManagement()` from `onConnect` and homeCore can supervise the plugin
— heartbeat it, restart it, read and write its config, change its log level.
Without it the plugin runs but shows as offline.

```javascript
onConnect() {
  this.enableManagement({
    intervalSecs: 60,          // core marks a plugin offline after 90s
    version: '1.2.0',
    configPath: process.argv[2],
  });
}
```

## Notices — telling the operator what is wrong

A status of *active* answers "is the process alive". It cannot say "alive, but
unable to do its job", and that is the state operators actually get stuck in.

A notice puts your diagnosis on the plugin's card in the UI:

```javascript
const { PluginNotice } = require('homecore-plugin-sdk');

if (!this.bridgeReachable()) {
  this.notices.raise(PluginNotice.error(
    'bridge_unreachable',
    'The bridge stopped answering, so no device state is updating.',
    { remedy: 'Check that the bridge is powered on and on this network.' },
  ));
} else {
  this.notices.clear('bridge_unreachable');
}
```

**A notice is state, not a log line.** The full set rides on every heartbeat and
homeCore replaces what it held, so a cleared notice disappears on its own —
nothing to acknowledge, nothing to expire.

The trap is raising once at startup and never looking again. A plugin that
reports `no_devices_configured` at boot is still showing it after the operator
has added devices. Re-derive conditions where you already loop: after a poll,
after a reconnect, after a config change. `notices.set([...])` replaces the whole
set at once, which is the safest shape when a sync cycle recomputes everything.

Levels are `PluginNotice.info`, `.warning`, and `.error`.

## Capability actions — buttons in the UI

Declare an action and it appears as a button on your plugin's page, and becomes
callable from hc-mcp. Neither needs code written for your plugin specifically.

```javascript
const { Action, Capabilities } = require('homecore-plugin-sdk');

onConnect() {
  this.enableManagement({
    configPath: process.argv[2],
    capabilities: new Capabilities([
      new Action({
        id: 'rescan',
        label: 'Rescan devices',
        description: 'Ask the bridge for its current device list.',
      }),
    ]),
  });
}

async onAction(action, params, ctx) {
  if (action === 'rescan') {
    const found = await this.rescan();
    return { found: found.length };   // an object is the result
  }
  return null;                        // null means "not mine"
}
```

Handlers may be async — the SDK awaits them.

### Actions that take a while

Set `stream: true` and your handler receives a `StreamContext` to report through
as it works. That is what drives a live progress bar and a list of devices
appearing one at a time, instead of a spinner that says nothing.

```javascript
new Action({
  id: 'discover', label: 'Discover devices', stream: true,
  cancelable: true, itemKey: 'serial', timeoutMs: 30000,
});
```

```javascript
async onAction(action, params, ctx) {
  if (action !== 'discover') return null;
  const hosts = this.candidates();
  for (const [i, host] of hosts.entries()) {
    if (ctx.isCanceled()) {        // cooperative — nothing interrupts you
      ctx.canceled();
      return;
    }
    ctx.progress({ percent: Math.floor((100 * i) / hosts.length), message: `Probing ${host}` });
    const dev = await probe(host);
    if (dev) ctx.itemAdd({ serial: dev.serial, name: dev.name });
  }
  ctx.complete({ found: hosts.length });
}
```

| Stage | Meaning |
|---|---|
| `ctx.progress({...})` | percent / label / message, as often as useful |
| `ctx.itemAdd/itemUpdate/itemRemove(data)` | one thing found or changed — include the `itemKey` field so the UI updates a row rather than appending |
| `ctx.warning(msg)` | recoverable; **the stream continues** |
| `ctx.awaitingUser(prompt)` | ask for something, then `await ctx.awaitRespond()` |
| `ctx.complete(data)` | terminal, success |
| `ctx.error(msg)` | terminal, failure |
| `ctx.canceled()` | terminal, after you notice `isCanceled()` |

Terminal stages are latched — the first wins. If your handler returns or rejects
without emitting one, the SDK sends an `error`, so the UI is never left waiting
on a stream that quietly stopped.

### Asking the operator something

```javascript
ctx.awaitingUser('Press the pairing button on the device now.');
const answer = await ctx.awaitRespond(60000);
```

## Cross-device plugins

To read devices you do **not** own — a thermostat consuming sensors from other
plugins — subscribe explicitly and handle `onState`:

```javascript
onConnect() {
  this.subscribeState('sensor.hallway_temp');
}

onState(deviceId, state) {
  this.recompute(deviceId, state);
}
```

This needs a broader broker ACL than a normal plugin:
`allow_sub = ["homecore/devices/+/state"]`.

## Remote config

With `configPath` set, homeCore can read and write your config file. The raw
TOML editor sends text, which the SDK writes verbatim.

If you declare a `configSchema`, the UI renders a form and sends a structured
object instead. The SDK will not guess at TOML serialisation, so override
`onSetConfig` to take it:

```javascript
onSetConfig(config) {
  fs.writeFileSync(this._configPath, toToml(config));
  return true;      // false → the SDK answers with an error
}
```

## API reference

### Devices

| Method | Purpose |
|---|---|
| `registerDeviceFull(id, name, { deviceType, area, capabilities })` | Register. Everything optional but id and name |
| `registerDeviceTyped(id, name, deviceType, area)` | Register against a built-in type |
| `registerDevice(id, name, capabilities, area)` | Register with an explicit JSON Schema |
| `registerDeviceSchema(id, schema)` | Publish a schema separately |
| `unregisterDevice(id)` | Retire it and clear its retained topics |
| `publishAvailability(id, bool)` | online / offline |

Registering also subscribes to that device's commands. In the Rust SDK those are
two separate calls and forgetting the second is the classic first-plugin bug;
here it is one.

### State

| Method | Purpose |
|---|---|
| `publishState(id, state)` | Full state, retained |
| `publishStatePartial(id, patch)` | Merge-patch — only the keys given |
| `publishStateForCommand(id, state, cmd, fallbackSource)` | Full state, with provenance from the command |
| `publishStatePartialForCommand(...)` | The partial equivalent |

Use the `ForCommand` forms when responding to a command: they carry who caused
the change, so the UI and the audit log can say so.

### Plugin

| Method | Purpose |
|---|---|
| `enableManagement({ intervalSecs, version, configPath, capabilities })` | Heartbeat, remote management, action manifest |
| `enableLogForwarding(minLevel)` | Send your logs to homeCore's live log stream |
| `logInfo/logWarn/logError/logDebug(msg, fields)` | Forward one line |
| `publishPluginStatus(status)` | active / degraded / offline |
| `publishEvent(type, payload)` | A structured event on the bus |
| `notices` | `.raise()`, `.clear()`, `.set()`, `.snapshot()` |
| `enableDevicePersistence(path)` | Remember registered devices across restarts |
| `reconcileDevices(live)` | Unregister everything not in the live set |

### Hooks to override

| Hook | When |
|---|---|
| `onConnect()` | Connected. Register devices, enable management |
| `onCommand(deviceId, payload)` | A command for one of your devices |
| `onAction(action, params, ctx)` | A capability action; `ctx` only when streaming |
| `onState(deviceId, state)` | A device you subscribed to changed |
| `onSetConfig(config)` | A structured config write |

## Secrets in logs

`enableLogForwarding()` publishes to a topic anything can subscribe to. Do not
interpolate credentials into log messages — the text is forwarded verbatim.

## Device persistence

When a device disappears from your upstream — a bulb deleted from the bridge, a
Z-Wave node excluded, an entry removed from config — its homeCore record has to
go too. Otherwise it lingers forever, still shown in the UI and still accepting
commands nothing will execute.

Knowing what disappeared means knowing what existed *before*, and a plugin that
has just restarted knows nothing. So the SDK can mirror every
register/unregister to a small JSON file:

```javascript
onConnect() {
  // Once, before registering anything.
  this.enableDevicePersistence(path.join(configDir, '.published-device-ids.json'));
}
```

Then, after a sync where you know the full live set:

```javascript
const report = this.reconcileDevices(bridge.devices().map((d) => d.id));
// report.staleUnregistered — gone upstream, now gone from homeCore
// report.unknownInLive     — ids you passed but never registered
```

Devices registered in *earlier runs* are retired too, which is the point: a
fresh process that has registered nothing can still clean up what the previous
one left behind.

The plugin id is inserted into the filename
(`.published-device-ids.plugin.hue.json`), because real deployments keep every
plugin's config in one directory and every plugin derives this path the same
way — unscoped, they would share one file and retire each other's devices.

**Only reconcile after a sync you trust.** On a partial fetch this unregisters
live devices behind a temporarily unreachable upstream — which looks exactly
like the bug it exists to prevent, except the devices were fine. Track an
"everything succeeded" flag across your per-source loop and pass the live set
only when it holds.

Plugins whose upstream reports irregularly — battery sensors that go quiet for
hours — should enable persistence but skip auto-reconcile. An operator can clear
zombies with `DELETE /api/v1/plugins/{id}/devices`.

## Parity with the Rust SDK

Everything the Rust SDK does is here: registration, state, availability, the
management protocol, log forwarding, notices, capability actions including
streaming, and cross-device state subscription.

Everything the Rust SDK does is here. There is no gap left.

## Development

```bash
npm ci
npm test
```

`examples/virtual_light.js` is a complete plugin. `examples/discovery_plugin.js`
demonstrates notices and both kinds of capability action.

## License

Dual-licensed under **MIT** or **Apache-2.0**, at your option.

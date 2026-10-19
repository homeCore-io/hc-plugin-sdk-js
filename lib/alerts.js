'use strict';

/**
 * Alerts — what a plugin says needs attention about its devices.
 *
 * Notices are about the plugin; **alerts** are about its devices, and live in
 * the house's alert list (homeCore 0.1.85). A plugin declares the kinds it can
 * raise ({@link PluginAlertKind}) on its capability manifest, and publishes,
 * per device, the ones that are true now ({@link PluginAlert}). homeCore
 * decides whether each is shown and where it is sent.
 *
 * Alerts are **current state, not events**: publish the whole list for a
 * device each time, and homeCore replaces what it held — an alert you stop
 * sending has cleared, and an empty list clears them all.
 *
 * The wire form is core's `hc_types::alert::{PluginAlertKind, PluginAlert}`:
 * unset optionals are omitted, not sent as null.
 */

/** How serious an alert is. */
const AlertSeverity = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  /**
   * On the wire, but homeCore's own (smoke, water): a plugin asking for it
   * gets `error`.
   */
  CRITICAL: 'critical',
});

/** Where an {@link AlertAction} runs. */
const AlertActionTarget = Object.freeze({
  /** On the alert's device, as one of its device actions. The default. */
  DEVICE: 'device',
  /** As one of the plugin's own manifest actions. */
  PLUGIN: 'plugin',
});

/**
 * The button on a plugin's alert: one of the device's own actions, or one of
 * the plugin's, run with these params when someone (or an automation) presses
 * it.
 */
class AlertAction {
  /**
   * @param {string} label - What the button says: "Update…".
   * @param {string} id    - The action to run: a device action id
   *   (`install_firmware`) when the alert is about a device, else one of the
   *   plugin's manifest actions.
   * @param {object} [opts]
   * @param {string} [opts.target='device'] - {@link AlertActionTarget}:
   *   `device` runs it on the alert's device; `plugin` as a plugin action.
   * @param {*}       [opts.params]        - Passed to the action.
   * @param {boolean} [opts.confirm=false] - Ask before running it: it
   *   interrupts something.
   */
  constructor(label, id, {
    target = AlertActionTarget.DEVICE, params = null, confirm = false,
  } = {}) {
    if (!label) throw new Error('AlertAction requires a label');
    if (!id) throw new Error('AlertAction requires an id');
    Object.assign(this, { label, id, target, params, confirm });
  }

  /**
   * The wire form. `target` is omitted when it is `device`, `params` when
   * unset and `confirm` when false — matching Rust's `skip_serializing_if`.
   */
  toJSON() {
    const out = { label: this.label, id: this.id };
    if (this.target != null && this.target !== AlertActionTarget.DEVICE) {
      out.target = this.target;
    }
    if (this.params != null) out.params = this.params;
    if (this.confirm) out.confirm = true;
    return out;
  }
}

/**
 * A kind of alert a plugin can raise, declared on its capability manifest —
 * which is how the settings screen can list it, and let someone turn it on or
 * off, before it has ever happened.
 */
class PluginAlertKind {
  /**
   * @param {string} topic - `snake_case`, stable: what {@link PluginAlert}'s
   *   `topic` names.
   * @param {string} label - For a person: "Firmware update available".
   * @param {object} [opts]
   * @param {string} [opts.description]
   * @param {string} [opts.severity='warning'] - {@link AlertSeverity}. Never
   *   `critical`: a plugin asking for it gets `error`.
   * @param {boolean} [opts.defaultOn=true] - Shown unless someone turns it off
   *   (true), or only once someone turns it on (false) — right for news that
   *   isn't a problem.
   */
  constructor(topic, label, {
    description = null, severity = AlertSeverity.WARNING, defaultOn = true,
  } = {}) {
    if (!topic) throw new Error('PluginAlertKind requires a topic');
    if (!label) throw new Error(`PluginAlertKind ${topic} requires a label`);
    Object.assign(this, { topic, label, description, severity, defaultOn });
  }

  toJSON() {
    const out = { topic: this.topic, label: this.label };
    if (this.description != null) out.description = this.description;
    out.severity = this.severity;
    out.default_on = this.defaultOn;
    return out;
  }
}

/** One alert a plugin says is true now, for one device (or for itself). */
class PluginAlert {
  /**
   * @param {string} topic  - One of the plugin's declared kinds.
   * @param {string} reason - Without the device's name, for its card:
   *   "Firmware 17.0.0 is out".
   * @param {object} [opts]
   * @param {string} [opts.key] - What this one is about within its kind
   *   (`17.0.0`); a different key is a different alert, so "skip this one"
   *   skips this version, not the kind.
   * @param {string} [opts.message] - With the device's name, when the plugin
   *   wants other words than "{name}: {reason}".
   * @param {string} [opts.severity] - Overrides the kind's declared severity
   *   for this one; capped at `error`.
   * @param {AlertAction} [opts.action] - The button on it.
   * @param {Date|string} [opts.since] - When the condition began, if the
   *   plugin knows; else homeCore uses when it first heard of it.
   */
  constructor(topic, reason, {
    key = null, message = null, severity = null, action = null, since = null,
  } = {}) {
    if (!topic) throw new Error('PluginAlert requires a topic');
    if (reason == null) throw new Error(`PluginAlert ${topic} requires a reason`);
    Object.assign(this, { topic, key, reason, message, severity, action, since });
  }

  /** The wire form. Unset optionals are omitted, not sent as null. */
  toJSON() {
    const out = { topic: this.topic };
    if (this.key != null) out.key = this.key;
    out.reason = this.reason;
    if (this.message != null) out.message = this.message;
    if (this.severity != null) out.severity = this.severity;
    if (this.action != null) {
      out.action = typeof this.action.toJSON === 'function'
        ? this.action.toJSON()
        : this.action;
    }
    if (this.since != null) {
      out.since = this.since instanceof Date
        ? this.since.toISOString()
        : String(this.since);
    }
    return out;
  }
}

module.exports = {
  AlertSeverity, AlertActionTarget, AlertAction, PluginAlertKind, PluginAlert,
};

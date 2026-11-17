'use strict';

/**
 * REST access homeCore grants a plugin.
 *
 * A plugin that declares `apiScopes` in its manifest is minted its own API key
 * on every start, sent with the `api_access` management action. Nothing to
 * paste and nothing stored in the config file.
 */

const util = require('util');

/**
 * Where homeCore's REST API is, the key to use, and what the key may do.
 *
 * The key is minted fresh on every plugin start and kept only in memory. It is
 * a non-enumerable property, and `toJSON` and `util.inspect` leave it out, so
 * logging the object or stringifying it cannot leak the key.
 */
class ApiAccess {
  /**
   * @param {object} opts
   * @param {string} opts.url - homeCore's REST base this plugin can reach,
   *   e.g. `http://127.0.0.1:8080/api/v1`.
   * @param {string} opts.key - Bearer key (`hc_sk_...`).
   * @param {string[]} [opts.scopes] - Scopes the key carries. Can be fewer
   *   than the manifest asked for.
   */
  constructor({ url, key, scopes = [] }) {
    this.url = url;
    Object.defineProperty(this, 'key', { value: key, enumerable: false });
    this.scopes = scopes;
    Object.freeze(this);
  }

  toJSON() {
    return { url: this.url, scopes: this.scopes };
  }

  [util.inspect.custom]() {
    return `ApiAccess { url: ${util.inspect(this.url)}, scopes: ${util.inspect(this.scopes)} }`;
  }
}

module.exports = { ApiAccess };

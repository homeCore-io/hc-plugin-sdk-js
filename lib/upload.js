'use strict';
/**
 * Files sent to a plugin's actions.
 *
 * `POST /plugins/{id}/upload/{action}` sends the file in pieces
 * (`upload_chunk`), then runs the action with `upload: {id, size, name}`.
 * The SDK keeps the pieces in a temporary file and hands the action a
 * `file_path` param in place of them, and removes the file once the action
 * has replied (a streaming action: once its stream has ended).
 *
 * The Node.js twin of the Rust SDK's `upload.rs`, and must agree with it.
 *
 * @module homecore-plugin-sdk/lib/upload
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/** The most one upload may hold. */
const MAX = 64 * 1024 * 1024;

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[A-Za-z0-9-]+$/.test(id);
}

function fileFor(id) {
  return path.join(os.tmpdir(), `hc-upload-${id}`);
}

/**
 * Write one piece where it goes.
 * @returns {string|null} why it was refused, or null when it was kept
 */
function chunk(cmd) {
  const id = cmd.upload_id;
  if (!validId(id)) return 'bad upload id';
  const offset = Number.isInteger(cmd.offset) && cmd.offset >= 0 ? cmd.offset : 0;
  if (typeof cmd.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(cmd.data)) return 'bad piece';
  const data = Buffer.from(cmd.data, 'base64');
  if (offset + data.length > MAX) return 'the file is too large';
  const file = fileFor(id);
  try {
    const fd = fs.openSync(file, offset === 0 ? 'w' : 'r+', 0o600);
    try {
      fs.writeSync(fd, data, 0, data.length, offset);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return `keeping the piece: ${err.message}`;
  }
  return null;
}

/** The file an action was sent, when it was sent one and it is all there. */
function pathFor(cmd) {
  const up = cmd && cmd.upload;
  if (!up || !validId(up.id)) return null;
  const file = fileFor(up.id);
  try {
    return fs.statSync(file).size === up.size ? file : null;
  } catch {
    return null;
  }
}

function remove(file) {
  if (file) fs.rm(file, { force: true }, () => {});
}

module.exports = { chunk, pathFor, remove, MAX };

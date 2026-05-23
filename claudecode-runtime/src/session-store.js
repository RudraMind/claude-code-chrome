/**
 * Write-on-every-output persistence with atomic writes (Fix #3).
 * Single JSON file. Survives panel reload.
 * NOTE: Does NOT survive full OS reboot with running session.
 *       Session restores workspace, not live PTY.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_DIR     = path.join(os.homedir(), '.claudecode-runtime');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const MAX_OUTPUT   = 500;

class SessionStore {
  constructor({ log }) {
    this.log = log;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
    this._data = this._load();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    } catch (_) {
      return { workspace: null, sessionId: null, output: [] };
    }
  }

  // ── Atomic write: write tmp then rename (Fix #3) ──
  _save() {
    try {
      const tmp = SESSION_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._data), 'utf8');
      fs.renameSync(tmp, SESSION_FILE);
    } catch (err) {
      this.log(`SessionStore write error: ${err.message}`);
    }
  }

  saveWorkspace({ path: dir, detected }) {
    this._data.workspace = { path: dir, detected, lastOpened: new Date().toISOString() };
    this._save();
  }

  getLastWorkspace() {
    return this._data.workspace || null;
  }

  appendOutput(sessionId, data) {
    if (this._data.sessionId !== sessionId) {
      this._data.sessionId = sessionId;
      this._data.output = [];
    }
    this._data.output.push(data);
    if (this._data.output.length > MAX_OUTPUT) {
      this._data.output = this._data.output.slice(-MAX_OUTPUT);
    }
    this._save();
  }
}

module.exports = SessionStore;

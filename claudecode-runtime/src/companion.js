/**
 * Message Router — the brain.
 * All state lives here. Extension owns nothing.
 */

const fs            = require('fs');
const path          = require('path');
const ClaudeBridge  = require('./claude-bridge');
const SessionStore  = require('./session-store');
const FolderPicker  = require('./folder-picker');
const ClaudeDetector = require('./claude-detector');

class Companion {
  constructor({ log }) {
    this.log      = log;
    this.sendFn   = null;
    this.sessions = new Map();
    this.store    = new SessionStore({ log });
    this.picker   = new FolderPicker({ log });
    this.detector = new ClaudeDetector({ log });
  }

  setSend(fn) { this.sendFn = fn; }
  send(msg) { if (this.sendFn) this.sendFn(msg); }

  handle(msg) {
    try {
      this._route(msg);
    } catch (err) {
      this.log(`Handler error [${msg.type}]: ${err.stack}`);
      this.send({ type: 'error', message: err.message });
    }
  }

  _route(msg) {
    switch (msg.type) {

      // ── Lifecycle ──

      case 'ping': {
        const claudePath = this.detector.getPath();
        this.send({
          type: 'pong',
          claudeInstalled: !!claudePath,
          claudeVersion: claudePath ? this.detector.getVersion() : null
        });
        break;
      }

      case 'keepalive':
        this.send({ type: 'keepalive_ack', ts: Date.now() });
        break;

      case 'panel_ready': {
        const { sessionId } = msg;
        if (!sessionId) break;
        const bridge = this.sessions.get(sessionId);
        if (bridge) bridge.flushBuffer();
        break;
      }

      // ── Folder Picker ──

      case 'pick_folder': {
        this.picker.pick().then(result => {
          if (!result) {
            this.send({ type: 'folder_pick_cancelled' });
            return;
          }
          const detected = this.picker.detect(result);
          this.store.saveWorkspace({ path: result, detected });
          this.send({
            type: 'folder_picked',
            path: result,
            name: path.basename(result),
            detected
          });
        }).catch(err => {
          this.log(`Folder picker error: ${err.message}`);
          this.send({ type: 'folder_pick_error', message: err.message });
        });
        break;
      }

      case 'get_recent_workspaces': {
        const last = this.store.getLastWorkspace();
        this.send({ type: 'recent_workspaces', list: last ? [last] : [] });
        break;
      }

      // ── Session Management ──

      case 'start_session': {
        const { sessionId, workingDir } = msg;

        // ── Validate inputs (Fix #1 + #9) ──
        if (!sessionId || typeof sessionId !== 'string') {
          this.send({ type: 'error', message: 'Invalid sessionId' });
          return;
        }
        if (!workingDir || typeof workingDir !== 'string') {
          this.send({ type: 'error', message: 'Invalid workingDir' });
          return;
        }
        try {
          const stat = fs.statSync(workingDir);
          if (!stat.isDirectory()) {
            this.send({ type: 'error', message: 'workingDir is not a directory' });
            return;
          }
        } catch (err) {
          this.send({ type: 'error', message: `workingDir not found: ${workingDir}` });
          return;
        }

        // Already running? Reattach.
        if (this.sessions.has(sessionId)) {
          this.log(`Session ${sessionId} already active — reattaching`);
          this.send({ type: 'session_started', sessionId });
          return;
        }

        const claudePath = this.detector.getPath();
        if (!claudePath) {
          this.send({ type: 'claude_missing' });
          return;
        }

        const bridge = new ClaudeBridge({
          sessionId,
          workingDir,
          claudePath,
          log: this.log,
          onOutput: (data) => {
            // ── Byte-safe chunking (Fix #6) ──
            // 100KB raw limit — worst-case JSON encoding (backslash/null flood)
            // multiplies by ~6x, keeping final message under 1MB NMH limit.
            const buf = Buffer.from(data, 'utf8');
            const MAX_CHUNK = 100 * 1024; // 100KB
            if (buf.length > MAX_CHUNK) {
              for (let i = 0; i < buf.length; i += MAX_CHUNK) {
                const chunk = buf.slice(i, Math.min(i + MAX_CHUNK, buf.length));
                this.send({ type: 'output', sessionId, data: chunk.toString('utf8') });
              }
            } else {
              this.send({ type: 'output', sessionId, data });
            }
            this.store.appendOutput(sessionId, data);
          },
          onExit: (exitCode, signal) => {
            this.sessions.delete(sessionId);
            this.send({
              type: 'session_ended',
              sessionId,
              exitCode,
              reason: exitCode === 0 ? 'normal' : 'crash'
            });
          }
        });

        this.sessions.set(sessionId, bridge);
        bridge.start();
        this.send({ type: 'session_started', sessionId });
        break;
      }

      case 'input': {
        // ── Validate input (Fix #9) ──
        if (!msg.sessionId || typeof msg.data !== 'string') break;
        const bridge = this.sessions.get(msg.sessionId);
        if (bridge) bridge.write(msg.data);
        break;
      }

      case 'resize': {
        // ── Validate resize values (Fix #9) ──
        const { sessionId, cols, rows } = msg;
        if (!sessionId) break;
        if (typeof cols !== 'number' || typeof rows !== 'number') break;
        if (cols < 1 || cols > 500 || rows < 1 || rows > 200) break;
        const b = this.sessions.get(sessionId);
        if (b) b.resize(cols, rows);
        break;
      }

      case 'stop_session': {
        const bridge = this.sessions.get(msg.sessionId);
        if (bridge) {
          bridge.kill();
          this.sessions.delete(msg.sessionId);
        }
        break;
      }

      case 'restart_session': {
        const bridge = this.sessions.get(msg.sessionId);
        const workingDir = bridge ? bridge.workingDir : this.store.getLastWorkspace()?.path;
        if (bridge) {
          bridge.kill();
          this.sessions.delete(msg.sessionId);
        }
        if (workingDir) {
          setTimeout(() => {
            // Use handle() not _route() — wraps in try/catch so errors send
            // back an error message rather than becoming uncaughtException.
            this.handle({ type: 'start_session', sessionId: msg.sessionId, workingDir });
          }, 500);
        }
        break;
      }

      default:
        this.log(`Unknown message: ${msg.type}`);
    }
  }

  shutdown() {
    for (const [id, bridge] of this.sessions) {
      this.log(`Shutting down session ${id}`);
      bridge.kill();
    }
    this.sessions.clear();
  }
}

module.exports = Companion;

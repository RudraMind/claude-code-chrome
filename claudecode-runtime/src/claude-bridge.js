/**
 * Spawns Claude Code CLI in a PTY. One instance per session.
 * Uses @homebridge/node-pty-prebuilt-multiarch (no node-gyp).
 * Falls back to node-pty if prebuilt unavailable.
 */

const os = require('os');

let pty;
try {
  pty = require('@homebridge/node-pty-prebuilt-multiarch');
} catch (_) {
  try {
    pty = require('node-pty');
  } catch (e) {
    throw new Error(
      'PTY module not found. Run: npm install @homebridge/node-pty-prebuilt-multiarch\n' +
      'Or: npm install node-pty (requires VS Build Tools on Windows)'
    );
  }
}

class ClaudeBridge {
  constructor({ sessionId, workingDir, claudePath, log, onOutput, onExit }) {
    this.sessionId  = sessionId;
    this.workingDir = workingDir;
    this.claudePath = claudePath;
    this.log        = log;
    this.onOutput   = onOutput;
    this.onExit     = onExit;
    this.process    = null;
    this.buffer     = [];
    this.panelReady = false;
    this.killed     = false;
  }

  start() {
    this.log(`[${this.sessionId}] Spawning: ${this.claudePath} in ${this.workingDir}`);

    // On Windows, node-pty cannot directly spawn .cmd wrappers or shebang scripts.
    // Route through cmd.exe to let the shell resolve the correct launcher.
    let spawnFile = this.claudePath;
    let spawnArgs = [];
    if (os.platform() === 'win32') {
      spawnFile = 'cmd.exe';
      spawnArgs = ['/c', this.claudePath];
    }

    this.process = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: this.workingDir,
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    this.log(`[${this.sessionId}] PID: ${this.process.pid}`);

    this.process.onData((data) => {
      if (this.panelReady) {
        this.onOutput(data);
      } else {
        this.buffer.push(data);
      }
    });

    this.process.onExit(({ exitCode, signal }) => {
      // Ignore exit from intentional kill — prevents race where new session
      // gets deleted by the old bridge's onExit firing asynchronously.
      if (this.killed) return;
      this.log(`[${this.sessionId}] Exited: code=${exitCode} signal=${signal}`);
      this.onExit(exitCode, signal);
    });
  }

  flushBuffer() {
    this.panelReady = true;
    if (this.buffer.length > 0) {
      this.log(`[${this.sessionId}] Flushing ${this.buffer.length} buffered chunks`);
      const combined = this.buffer.join('');
      this.buffer = [];
      this.onOutput(combined);
    }
  }

  write(data) {
    if (this.process) this.process.write(data);
  }

  resize(cols, rows) {
    if (this.process && cols > 0 && rows > 0) {
      try { this.process.resize(cols, rows); } catch (_) {}
    }
  }

  kill() {
    if (!this.process) return;
    this.killed = true;
    const pid = this.process.pid;
    this.log(`[${this.sessionId}] Killing PID ${pid}`);

    try { this.process.kill(); } catch (_) {}

    // Windows process tree kill — taskkill /T terminates entire process tree.
    // execFileSync with array args — no shell, no injection risk.
    if (os.platform() === 'win32' && pid) {
      try {
        require('child_process').execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'pipe',
          timeout: 5000
        });
      } catch (_) {
        // Process already dead — fine
      }
    }

    this.process = null;
  }
}

module.exports = ClaudeBridge;

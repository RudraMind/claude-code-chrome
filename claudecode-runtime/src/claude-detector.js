/**
 * Find Claude Code CLI on user's machine.
 * Checks PATH first, then common install locations.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const os   = require('os');

const CANDIDATES = {
  win32: [
    'claude',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
  ],
  darwin: [
    'claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ],
  linux: [
    'claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]
};

class ClaudeDetector {
  constructor({ log }) {
    this.log = log;
    this._path = null;
    this._version = null;
    this._detect();
  }

  _detect() {
    const candidates = CANDIDATES[os.platform()] || CANDIDATES.linux;

    for (const candidate of candidates) {
      try {
        const version = execFileSync(candidate, ['--version'], {
          timeout: 5000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();

        this._path = candidate;
        this._version = version;
        this.log(`Claude found: ${candidate} (${version})`);
        return;
      } catch (_) {}
    }

    this.log('Claude Code CLI not found');
  }

  getPath()    { return this._path; }
  getVersion() { return this._version; }
}

module.exports = ClaudeDetector;

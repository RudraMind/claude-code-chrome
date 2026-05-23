# Build Spec: Chrome Extension with Native Messaging + PTY Terminal

**Purpose:** Canonical spec for building any Chrome extension that runs a CLI tool in a PTY terminal inside Chrome via Native Messaging Host. Derived from building Claude Code Workspace MVP v1.

This spec is structured so an agent can follow it top-to-bottom and produce a working build with zero runtime debugging.

---

## Architecture

```
Chrome Extension (MV3)
  ├── service-worker.js       — NMH bridge, panel routing, keepalive
  ├── manifest.json           — permissions, NMH host name, side panel path
  └── side-panel/
        ├── panel.html        — 5-6 UI states (setup, missing, no-project, ready, terminal, crashed)
        ├── panel.js          — state machine, xterm.js, message handler
        └── panel.css         — VS Code dark theme

Native Messaging Host (Node.js)
  ├── bin/host.js             — NMH entry point, stdin/stdout framing
  ├── bin/host.bat            — Windows launcher (Chrome requires .bat on Windows)
  ├── src/companion.js        — message router, all state lives here
  ├── src/claude-bridge.js    — PTY spawner (node-pty), one per session
  ├── src/folder-picker.js    — OS-native folder dialog
  ├── src/claude-detector.js  — find CLI in PATH + known locations
  ├── src/session-store.js    — atomic JSON persistence
  └── scripts/setup.js        — writes NMH manifest + Windows registry entry
```

---

## Pre-Build Checklist (Run Before Writing Any Code)

These are the decisions that cause runtime failures if wrong. Decide upfront.

### NMH Protocol
- [ ] Messages: 4-byte little-endian length prefix + UTF-8 JSON (Chrome's native messaging spec)
- [ ] 1MB hard limit per message — chunk PTY output at **100KB raw** (worst-case JSON encoding is 6×)
- [ ] stdout is the NMH pipe — **never `console.log`** in host.js; use file-based logging
- [ ] Chrome launches host fresh per connection; host dies when Chrome disconnects stdin

### Windows PTY
- [ ] Use `@homebridge/node-pty-prebuilt-multiarch` (no `node-gyp`, prebuilt binaries)
- [ ] Run `npm install --ignore-scripts` then `cd node_modules/@homebridge/node-pty-prebuilt-multiarch && npm run install` — `--ignore-scripts` skips binary download; must run separately
- [ ] On Windows, `pty.spawn('claude')` fails — `.cmd` wrappers need `cmd.exe`: `pty.spawn('cmd.exe', ['/c', claudePath])`
- [ ] Windows host launcher must be a `.bat` file — Chrome NMH on Windows requires a batch file entry point, not a `.js` file directly

### Security (Claude Code Hooks)
- [ ] All `child_process` calls: use `execFileSync(cmd, [arg1, arg2])` array form — **never shell strings**
- [ ] Never use `innerHTML =` — use `element.replaceChildren()` or `textContent`
- [ ] No CDN script tags in HTML (MV3 CSP blocks remote scripts) — bundle xterm.js locally

### Manifest (MV3 Gotchas)
- [ ] Required permissions: `nativeMessaging`, `sidePanel`, `storage`, `tabs`
- [ ] `"tabs"` is easy to forget — needed for `chrome.tabs.create()` (full-tab open button)
- [ ] `"side_panel": { "default_path": "side-panel/panel.html" }`
- [ ] Icons: must be valid PNG files, not empty — use Python or a real image tool

### Service Worker Routing (Critical)
- [ ] **Never broadcast all messages to all panels** — causes multi-panel state corruption
- [ ] Route companion responses to the panel that initiated the request:
  - Track `sessionId → portId` map for session-scoped messages
  - Track `lastRequester` per request type (ping, pick_folder, get_recent_workspaces)
  - Only broadcast: connection state events (`companion_ready`, `companion_disconnected`)
- [ ] Keep SW alive: `chrome.runtime.connectNative()` (Port, not `sendNativeMessage`) + 20s keepalive ping
- [ ] Stop keepalive when last panel disconnects (prevents zombie SW)

---

## File-by-File Spec

### manifest.json
```json
{
  "manifest_version": 3,
  "name": "Your Extension Name",
  "version": "1.0.0",
  "permissions": ["nativeMessaging", "sidePanel", "storage", "tabs"],
  "side_panel": { "default_path": "side-panel/panel.html" },
  "background": { "service_worker": "service-worker.js" },
  "action": { "default_title": "...", "default_icon": { "16": "icons/icon-16.png", "48": "...", "128": "..." } },
  "icons": { "16": "icons/icon-16.png", "48": "...", "128": "..." }
}
```

### service-worker.js — Required Patterns

```js
// ── Port-based NMH (keeps SW alive) ──
const nativePort = chrome.runtime.connectNative('com.your.host');

// ── Panel registry ──
const panelPorts = new Map();    // id → port
const sessionOwners = new Map(); // sessionId → portId
let lastFolderPicker = null, lastPinger = null, lastWorkspaceRequester = null, lastSessionStarter = null;

// ── Route companion → panel (NOT broadcast) ──
function routeCompanionMessage(msg) {
  switch (msg.type) {
    case 'output':
    case 'session_ended': {
      const owner = sessionOwners.get(msg.sessionId);
      if (owner) routeToPort(owner, msg);
      if (msg.type === 'session_ended') sessionOwners.delete(msg.sessionId);
      break;
    }
    case 'session_started':
    case 'claude_missing': {
      const owner = (msg.sessionId ? sessionOwners.get(msg.sessionId) : null) || lastSessionStarter;
      if (owner) { if (msg.sessionId) sessionOwners.set(msg.sessionId, owner); routeToPort(owner, msg); }
      else broadcast(msg);
      lastSessionStarter = null;
      break;
    }
    case 'pong': routeToPort(lastPinger, msg); lastPinger = null; break;
    case 'recent_workspaces': routeToPort(lastWorkspaceRequester, msg); lastWorkspaceRequester = null; break;
    case 'folder_picked': case 'folder_pick_cancelled': case 'folder_pick_error':
      routeToPort(lastFolderPicker, msg); lastFolderPicker = null; break;
    default: broadcast(msg); // companion_ready, companion_disconnected
  }
}

// ── Track requesters when panel sends ──
port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'ping': lastPinger = id; break;
    case 'get_recent_workspaces': lastWorkspaceRequester = id; break;
    case 'pick_folder': lastFolderPicker = id; break;
    case 'start_session': lastSessionStarter = id; sessionOwners.set(msg.sessionId, id); break;
    case 'restart_session': lastSessionStarter = id; sessionOwners.delete(msg.sessionId); break;
  }
  nativePort.postMessage(msg);
});

// ── Cleanup on disconnect ──
port.onDisconnect.addListener(() => {
  panelPorts.delete(id);
  for (const [sid, oid] of sessionOwners) if (oid === id) sessionOwners.delete(sid);
  if (lastFolderPicker === id) lastFolderPicker = null;
  if (lastPinger === id) lastPinger = null;
  if (lastWorkspaceRequester === id) lastWorkspaceRequester = null;
  if (lastSessionStarter === id) lastSessionStarter = null;
  if (panelPorts.size === 0) stopKeepalive();
});
```

### panel.js — Required Patterns

```js
// ── State machine — use IDs not JS objects ──
const STATES = { SETUP: 'state-setup', TERMINAL: 'state-terminal', CRASHED: 'state-crashed', ... };
function setState(state) {
  Object.values(STATES).forEach(id => document.getElementById(id)?.classList.add('hidden'));
  document.getElementById(state)?.classList.remove('hidden');
}

// ── Debounce guard — prevents double-spawn ──
let launching = false;
function launchSession() {
  if (launching) return;
  launching = true;
  currentSession = crypto.randomUUID();
  sendMsg({ type: 'start_session', sessionId: currentSession, workingDir: currentWorkDir });
}

// ── xterm.js resize — rAF required ──
requestAnimationFrame(() => { try { fitAddon.fit(); } catch (_) {} });
resizeObserver = new ResizeObserver(() => {
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => { fitAddon.fit(); sendMsg({ type: 'resize', ... }); }, 100);
});

// ── Filter output/session_ended by sessionId ──
case 'output':
  if (term && msg.sessionId === currentSession) term.write(msg.data);
  break;

// ── Always send panel_ready even if initTerminal throws ──
try { initTerminal(); } catch (err) { console.error(err); }
sendMsg({ type: 'panel_ready', sessionId: currentSession });

// ── Guard missing fields ──
const detected = msg.detected || {};
```

### host.js — Required Patterns

```js
// ── Buffered read loop (partial reads happen) ──
let readBuffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk]);
  while (readBuffer.length >= 4) {
    const msgLen = readBuffer.readUInt32LE(0);
    if (msgLen > 1024 * 1024) { readBuffer = Buffer.alloc(0); return; } // corrupt header
    if (readBuffer.length < 4 + msgLen) break;
    const msg = JSON.parse(readBuffer.slice(4, 4 + msgLen).toString('utf8'));
    readBuffer = readBuffer.slice(4 + msgLen);
    companion.handle(msg);
  }
});

// ── Framed write ──
function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const byteLen = Buffer.byteLength(json, 'utf8');
  const buf = Buffer.alloc(4 + byteLen);
  buf.writeUInt32LE(byteLen, 0);
  buf.write(json, 4, 'utf8');
  process.stdout.write(buf);
}

// ── Error safety ──
process.on('uncaughtException', (err) => log(`UNCAUGHT: ${err.stack}`));
process.on('unhandledRejection', (reason) => log(`REJECTION: ${reason}`));
```

### claude-bridge.js — Required Patterns

```js
class ClaudeBridge {
  constructor(...) {
    this.killed = false;  // REQUIRED — prevents onExit race on intentional kill
    this.buffer = [];     // buffer output until panel signals ready
    this.panelReady = false;
  }

  start() {
    // Windows: route through cmd.exe — CreateProcess can't exec .cmd wrappers
    const spawnFile = os.platform() === 'win32' ? 'cmd.exe' : this.claudePath;
    const spawnArgs = os.platform() === 'win32' ? ['/c', this.claudePath] : [];

    this.process = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 80, rows: 24,
      cwd: this.workingDir,
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    this.process.onData((data) => {
      if (this.panelReady) this.onOutput(data);
      else this.buffer.push(data);
    });

    this.process.onExit(({ exitCode, signal }) => {
      if (this.killed) return; // intentional kill — do not fire onExit
      this.onExit(exitCode, signal);
    });
  }

  flushBuffer() {
    this.panelReady = true;
    if (this.buffer.length > 0) {
      this.onOutput(this.buffer.join(''));
      this.buffer = [];
    }
  }

  kill() {
    if (!this.process) return;
    this.killed = true;
    try { this.process.kill(); } catch (_) {}
    // Windows: kill entire process tree
    if (os.platform() === 'win32' && this.process.pid) {
      try { require('child_process').execFileSync('taskkill', ['/PID', String(this.process.pid), '/T', '/F'], { stdio: 'pipe', timeout: 5000 }); } catch (_) {}
    }
    this.process = null;
  }
}
```

### companion.js — Required Patterns

```js
// ── restart_session: reuse sessionId, use handle() not _route() in setTimeout ──
case 'restart_session': {
  const bridge = this.sessions.get(msg.sessionId);
  const workingDir = bridge?.workingDir || this.store.getLastWorkspace()?.path;
  if (bridge) { bridge.kill(); this.sessions.delete(msg.sessionId); }
  if (workingDir) {
    setTimeout(() => {
      this.handle({ type: 'start_session', sessionId: msg.sessionId, workingDir });
      // handle() not _route() — errors send back error message, not uncaughtException
    }, 500);
  }
  break;
}

// ── Chunked output — 100KB raw limit ──
const MAX_CHUNK = 100 * 1024;
const buf = Buffer.from(data, 'utf8');
if (buf.length > MAX_CHUNK) {
  for (let i = 0; i < buf.length; i += MAX_CHUNK) {
    this.send({ type: 'output', sessionId, data: buf.slice(i, i + MAX_CHUNK).toString('utf8') });
  }
} else {
  this.send({ type: 'output', sessionId, data });
}
```

### scripts/setup.js — NMH Registration

```js
// ── Write NMH manifest ──
const manifest = {
  name: 'com.your.host',
  description: 'Your description',
  path: path.join(__dirname, '..', 'bin', 'host.bat'), // .bat on Windows
  type: 'stdio',
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ── Windows registry — file-based, no shell ──
if (os.platform() === 'win32') {
  require('child_process').execFileSync('reg', [
    'add',
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.your.host`,
    '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'
  ]);
}
```

---

## Setup Sequence (Copy-Paste Order)

```bash
# 1. Install PTY (two steps — ignore-scripts skips binary download)
npm install @homebridge/node-pty-prebuilt-multiarch --ignore-scripts
cd node_modules/@homebridge/node-pty-prebuilt-multiarch && npm run install && cd ../../..

# 2. Verify PTY loads
node -e "require('@homebridge/node-pty-prebuilt-multiarch'); console.log('OK')"

# 3. Register NMH (pass real extension ID)
CLAUDE_EXTENSION_ID=<your-extension-id> node scripts/setup.js

# 4. Load extension in Chrome
# chrome://extensions → Developer mode → Load unpacked → select workspace/ dir

# 5. Get extension ID from chrome://extensions page
# Re-run setup.js with real ID if it changed
```

---

## Pre-Ship Review Checklist

Run a parallel multi-agent code review covering these areas before first launch:

- [ ] NMH framing: 4-byte LE prefix, buffered reads, 1MB guard
- [ ] PTY spawning: platform branch, `cmd.exe /c` on Windows, `killed` flag
- [ ] SW routing: no broadcast of session-scoped messages, all request types tracked
- [ ] Panel state machine: all 6 states, `launching` guard, `sessionId` filters, `detected || {}`
- [ ] Error paths: `panel_ready` always sent, `handle()` in setTimeout, `restart_session` 500ms delay
- [ ] Security: no shell strings, no `innerHTML`, no CDN scripts
- [ ] Manifest: all required permissions including `tabs`
- [ ] UX: destructive actions have icon + confirm dialog

---

## UX Rules for Destructive Actions

Any button that clears session data or resets state:
1. **Icon:** use 🗑 (trash) not ↺ (looks like browser refresh)
2. **Tooltip:** describe the consequence — "New Session — clears current conversation"
3. **Confirm dialog:** `confirm('Start a new session? This will clear the current conversation.')`

Browser users have conditioned ↺ = "safe refresh." Anything destructive must visually break that pattern.

---

## Known Platform Quirks Reference

| Platform | Issue | Fix |
|----------|-------|-----|
| Windows | npm CLI installed as `.cmd` wrapper — PTY can't spawn directly | `cmd.exe /c <path>` |
| Windows | Chrome NMH requires `.bat` launcher, not `.js` | `host.bat` calls `node host.js` |
| Windows | Process tree not killed by `process.kill()` alone | `taskkill /PID /T /F` |
| Windows | Antivirus holds `session.json` open → `renameSync` EPERM | Catch and log; data loss acceptable for MVP |
| All | `--ignore-scripts` skips prebuilt binary download | Run `npm run install` in package subdir |
| MV3 | CSP blocks CDN `<script>` tags | Bundle xterm.js locally |
| MV3 | SW dies when idle | `connectNative` (Port) + 20s keepalive |
| Claude Code hooks | Shell strings in `child_process` blocked | Array args always |
| Claude Code hooks | `innerHTML` blocked | `replaceChildren()` |

/**
 * Panel JS — State machine + xterm.js terminal.
 * Extension owns ZERO state. All state in companion.
 */

// ── State machine ──

const STATES = {
  SETUP:          'state-setup',
  CLAUDE_MISSING: 'state-claude-missing',
  NO_PROJECT:     'state-no-project',
  PROJECT_READY:  'state-project-ready',
  TERMINAL:       'state-terminal',
  CRASHED:        'state-crashed',
};

let currentState    = null;
let currentSession  = null;
let currentWorkDir  = null;
let term            = null;
let fitAddon        = null;
let resizeObserver  = null;
let resizeDebounce  = null;
let launching       = false;   // debounce guard for launchSession

function setState(state) {
  Object.values(STATES).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const el = document.getElementById(state);
  if (el) el.classList.remove('hidden');
  currentState = state;
}

// ── Service Worker Port ──

const swPort = chrome.runtime.connect({ name: 'side-panel' });
swPort.onMessage.addListener(handleMessage);
swPort.onDisconnect.addListener(() => {
  setStatus('disconnected', 'Service worker disconnected — reload panel to reconnect');
});

function sendMsg(msg) { swPort.postMessage(msg); }

// ── xterm.js ──

function initTerminal() {
  if (term) { term.dispose(); term = null; }
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }

  term = new Terminal({
    fontFamily: '"Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    convertEol: true,
    scrollback: 5000,
    theme: {
      background:  '#1e1e1e',
      foreground:  '#cccccc',
      cursor:      '#cccccc',
      black:       '#000000',
      red:         '#f44747',
      green:       '#4ec9b0',
      yellow:      '#ddb100',
      blue:        '#569cd6',
      magenta:     '#c586c0',
      cyan:        '#4ec9b0',
      white:       '#d4d4d4',
      brightBlack: '#808080',
      brightRed:   '#f44747',
      brightGreen: '#4ec9b0',
      brightYellow:'#ddb100',
      brightBlue:  '#569cd6',
      brightMagenta:'#c586c0',
      brightCyan:  '#4ec9b0',
      brightWhite: '#ffffff',
    }
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const container = document.getElementById('terminal-container');
  container.replaceChildren();
  term.open(container);

  // Use rAF so layout has settled before fit() measures dimensions.
  requestAnimationFrame(() => {
    try { fitAddon.fit(); } catch (_) {}
  });

  // Keyboard → companion
  term.onData((data) => {
    if (currentSession) {
      sendMsg({ type: 'input', sessionId: currentSession, data });
    }
  });

  // ── Resize with debounce (100ms) ──
  resizeObserver = new ResizeObserver(() => {
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      if (!fitAddon || !term) return;
      try {
        fitAddon.fit();
        if (currentSession) {
          sendMsg({ type: 'resize', sessionId: currentSession, cols: term.cols, rows: term.rows });
        }
      } catch (_) {}
    }, 100);
  });
  resizeObserver.observe(container);
}

// ── Message handler ──

function handleMessage(msg) {
  switch (msg.type) {

    case 'companion_ready':
      setStatus('connected', 'Connected');
      sendMsg({ type: 'ping' });
      break;

    case 'companion_disconnected':
      setStatus('disconnected', 'Reconnecting...');
      break;

    case 'pong':
      setStatus('connected', 'Connected');
      if (!msg.claudeInstalled) {
        setState(STATES.CLAUDE_MISSING);
        return;
      }
      sendMsg({ type: 'get_recent_workspaces' });
      break;

    case 'claude_missing':
      setState(STATES.CLAUDE_MISSING);
      break;

    case 'recent_workspaces': {
      const last = msg.list?.[0];
      if (last) {
        currentWorkDir = last.path;
        const name = last.path.split(/[\\/]/).pop();
        document.getElementById('btn-reopen').textContent = name;
        document.getElementById('last-workspace').classList.remove('hidden');
      }
      setState(STATES.NO_PROJECT);
      break;
    }

    case 'folder_pick_cancelled':
      break;

    case 'folder_picked':
      currentWorkDir = msg.path;
      showProjectReady(msg);
      break;

    case 'folder_pick_error':
      // Show in status bar regardless of terminal state — error must be visible.
      setStatus('disconnected', `Folder error: ${msg.message}`);
      if (term) term.write(`\r\n\x1b[31mFolder picker error: ${msg.message}\x1b[0m\r\n`);
      break;

    case 'session_started': {
      launching = false;
      currentSession = msg.sessionId;
      setState(STATES.TERMINAL);
      // Wrap initTerminal — if it throws (xterm init failure), still send
      // panel_ready so companion doesn't buffer output indefinitely.
      try {
        initTerminal();
      } catch (err) {
        console.error('[Panel] initTerminal failed:', err);
      }
      sendMsg({ type: 'panel_ready', sessionId: currentSession });
      setProjectHeader(currentWorkDir);
      document.getElementById('btn-restart').classList.remove('hidden');
      break;
    }

    case 'output':
      // Filter by sessionId — prevents crosstalk when multiple panels open.
      if (term && msg.data && msg.sessionId === currentSession) term.write(msg.data);
      break;

    case 'session_ended':
      // Filter by sessionId — prevents a different panel's session ending ours.
      if (msg.sessionId !== currentSession) break;
      launching = false;
      if (msg.reason === 'normal') {
        currentSession = null;
        setState(STATES.NO_PROJECT);
      } else {
        setState(STATES.CRASHED);
        document.getElementById('crash-reason').textContent =
          msg.reason === 'crash' ? 'Claude Code exited unexpectedly.' : `Exited: ${msg.reason}`;
      }
      document.getElementById('btn-restart').classList.add('hidden');
      break;

    case 'keepalive_ack':
      break;

    case 'error':
      console.error('[Panel]', msg.message);
      launching = false;
      break;
  }
}

// ── UI helpers ──

function setStatus(cls, text) {
  document.getElementById('status-dot').className = cls;
  document.getElementById('status-text').textContent = text;
}

function setProjectHeader(dir) {
  if (!dir) return;
  const name = dir.split(/[\\/]/).pop();
  document.getElementById('project-name').textContent = name;
  document.getElementById('project-area').classList.remove('hidden');
  document.getElementById('footer-project').textContent = dir;
}

function showProjectReady(msg) {
  const { name } = msg;
  const detected = msg.detected || {};
  document.getElementById('detected-project-name').textContent = name;
  const badges = document.getElementById('detected-badges');
  badges.replaceChildren();
  if (detected.projectType)    addBadge(badges, detected.projectType);
  if (detected.packageManager) addBadge(badges, detected.packageManager);
  if (detected.git)            addBadge(badges, 'git');
  if (detected.claudeMd)       addBadge(badges, 'CLAUDE.md');
  if (detected.dockerfile)     addBadge(badges, 'Docker');
  setState(STATES.PROJECT_READY);
}

function addBadge(container, text) {
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = text;
  container.appendChild(b);
}

function launchSession() {
  if (!currentWorkDir) return;
  // Prevent double-spawn from rapid clicks or duplicate button wiring.
  if (launching) return;
  launching = true;
  currentSession = crypto.randomUUID();
  sendMsg({ type: 'start_session', sessionId: currentSession, workingDir: currentWorkDir });
}

// ── Button wiring ──

document.getElementById('btn-open-project').addEventListener('click', () => sendMsg({ type: 'pick_folder' }));
document.getElementById('btn-reopen').addEventListener('click', launchSession);
document.getElementById('btn-launch').addEventListener('click', launchSession);
document.getElementById('btn-change-folder').addEventListener('click', () => sendMsg({ type: 'pick_folder' }));
document.getElementById('btn-change-folder2').addEventListener('click', () => sendMsg({ type: 'pick_folder' }));

document.getElementById('btn-reconnect').addEventListener('click', () => {
  if (currentSession) sendMsg({ type: 'restart_session', sessionId: currentSession });
  else launchSession();
});

document.getElementById('btn-restart').addEventListener('click', () => {
  if (!currentSession) return;
  if (!confirm('Start a new session? This will clear the current conversation.')) return;
  sendMsg({ type: 'restart_session', sessionId: currentSession });
});

document.getElementById('btn-refresh').addEventListener('click', () => location.reload());
document.getElementById('btn-refresh2').addEventListener('click', () => location.reload());

document.getElementById('btn-tab').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('side-panel/panel.html') });
});

// ── Cleanup on close ──

window.addEventListener('beforeunload', () => {
  if (resizeObserver) resizeObserver.disconnect();
  if (resizeDebounce) clearTimeout(resizeDebounce);
  if (term) term.dispose();
});

// ── Init ──

setState(STATES.SETUP);
setStatus('disconnected', 'Connecting...');

/**
 * Service Worker — NMH bridge + panel routing.
 * Uses connectNative (Port) to keep SW alive indefinitely.
 * Keepalive ping every 20s as insurance.
 * Stops keepalive when no panels connected.
 *
 * Routing: companion responses are routed to the specific panel
 * that initiated the request, not broadcast to all panels.
 * This prevents multi-panel state corruption and output crosstalk.
 */

const HOST_NAME = 'com.claudecode.runtime';

let nativePort        = null;
let panelPorts        = new Map();  // id → port
let keepaliveInterval = null;
let reconnectTimer    = null;

// Per-request routing state
let sessionOwners          = new Map(); // sessionId → portId
let lastFolderPicker       = null;      // portId
let lastPinger             = null;      // portId
let lastWorkspaceRequester = null;      // portId
let lastSessionStarter     = null;      // portId — covers start_session + restart_session

// ── Routing helpers ──

function routeToPort(portId, msg) {
  const port = panelPorts.get(portId);
  if (port) try { port.postMessage(msg); } catch (_) {}
}

function broadcast(msg) {
  for (const [, port] of panelPorts) {
    try { port.postMessage(msg); } catch (_) {}
  }
}

function routeCompanionMessage(msg) {
  switch (msg.type) {

    case 'output': {
      const ownerId = sessionOwners.get(msg.sessionId);
      if (ownerId) routeToPort(ownerId, msg);
      break;
    }

    case 'session_started':
    case 'claude_missing': {
      // sessionOwners may already have this id if start_session was tracked by sessionId.
      // lastSessionStarter handles restart_session where the new sessionId is unknown upfront.
      // claude_missing is also a session-start response — route to the same requester.
      const ownerId = (msg.sessionId ? sessionOwners.get(msg.sessionId) : null) || lastSessionStarter;
      if (ownerId) {
        if (msg.sessionId) sessionOwners.set(msg.sessionId, ownerId);
        routeToPort(ownerId, msg);
      } else {
        broadcast(msg);
      }
      lastSessionStarter = null;
      break;
    }

    case 'session_ended': {
      const ownerId = sessionOwners.get(msg.sessionId);
      if (ownerId) routeToPort(ownerId, msg);
      sessionOwners.delete(msg.sessionId);
      break;
    }

    case 'folder_picked':
    case 'folder_pick_cancelled':
    case 'folder_pick_error': {
      if (lastFolderPicker) routeToPort(lastFolderPicker, msg);
      else broadcast(msg);
      lastFolderPicker = null;
      break;
    }

    case 'pong': {
      if (lastPinger) routeToPort(lastPinger, msg);
      else broadcast(msg);
      lastPinger = null;
      break;
    }

    case 'recent_workspaces': {
      if (lastWorkspaceRequester) routeToPort(lastWorkspaceRequester, msg);
      else broadcast(msg);
      lastWorkspaceRequester = null;
      break;
    }

    // Broadcast: connection state changes every panel needs to know
    case 'companion_ready':
    case 'companion_disconnected':
    case 'keepalive_ack':
    default:
      broadcast(msg);
  }
}

// ── NMH Connection ──

function connectNative() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    console.error('[SW] connectNative failed:', err);
    scheduleReconnect();
    return;
  }

  nativePort.onMessage.addListener(routeCompanionMessage);

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || 'unknown';
    console.warn('[SW] Disconnected:', err);
    nativePort = null;
    stopKeepalive();
    broadcast({ type: 'companion_disconnected', error: err });
    scheduleReconnect();
  });

  if (panelPorts.size > 0) startKeepalive();

  broadcast({ type: 'companion_ready' });
}

function scheduleReconnect(ms = 3000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(connectNative, ms);
}

// ── Keepalive ──

function startKeepalive() {
  stopKeepalive();
  keepaliveInterval = setInterval(() => {
    if (nativePort) nativePort.postMessage({ type: 'keepalive' });
  }, 20000);
}

function stopKeepalive() {
  if (keepaliveInterval) { clearInterval(keepaliveInterval); keepaliveInterval = null; }
}

// ── Panel Connections ──

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'side-panel') return;
  const id = `panel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  panelPorts.set(id, port);

  if (panelPorts.size === 1 && nativePort) startKeepalive();

  port.postMessage(nativePort
    ? { type: 'companion_ready' }
    : { type: 'companion_disconnected', error: 'Connecting...' }
  );

  port.onMessage.addListener((msg) => {
    // Track which panel initiated each request so we can route the response back.
    switch (msg.type) {
      case 'ping':
        lastPinger = id;
        break;
      case 'get_recent_workspaces':
        lastWorkspaceRequester = id;
        break;
      case 'pick_folder':
        lastFolderPicker = id;
        break;
      case 'start_session':
        lastSessionStarter = id;
        sessionOwners.set(msg.sessionId, id);
        break;
      case 'restart_session':
        // New sessionId unknown until companion replies — track via lastSessionStarter.
        lastSessionStarter = id;
        sessionOwners.delete(msg.sessionId);
        break;
    }
    if (nativePort) nativePort.postMessage(msg);
    else port.postMessage({ type: 'error', message: 'Companion not connected' });
  });

  port.onDisconnect.addListener(() => {
    panelPorts.delete(id);

    // Clean up routing state owned by this panel
    for (const [sessionId, ownerId] of sessionOwners) {
      if (ownerId === id) sessionOwners.delete(sessionId);
    }
    if (lastFolderPicker       === id) lastFolderPicker       = null;
    if (lastPinger             === id) lastPinger             = null;
    if (lastWorkspaceRequester === id) lastWorkspaceRequester = null;
    if (lastSessionStarter     === id) lastSessionStarter     = null;

    if (panelPorts.size === 0) stopKeepalive();
  });
});

// ── Icon click → open side panel ──

chrome.action.onClicked.addListener((tab) => {
  try {
    chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (err) {
    console.warn('[SW] sidePanel.open failed:', err);
  }
});

// ── Init ──
connectNative();

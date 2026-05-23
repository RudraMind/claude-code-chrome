#!/usr/bin/env node
/**
 * NMH Entry Point — Chrome launches this via Native Messaging.
 * Protocol: 4-byte little-endian length prefix + UTF-8 JSON.
 * stdout = NMH pipe (no console.log allowed).
 */

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ── Logging to file (stdout is NMH pipe) ──
const LOG_DIR  = path.join(os.homedir(), '.claudecode-runtime');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
const LOG_FILE = path.join(LOG_DIR, 'companion.log');

function log(msg) {
  try {
    // Log rotation: cap at 5MB
    try {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size > 5 * 1024 * 1024) {
        const old = LOG_FILE + '.old';
        try { fs.unlinkSync(old); } catch (_) {}
        fs.renameSync(LOG_FILE, old);
      }
    } catch (_) {}
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {}
}

log('=== companion started ===');
log(`Node ${process.version} | ${process.platform} | PID ${process.pid}`);

// ── Load companion ──
const Companion = require('../src/companion');
const companion = new Companion({ log });

// ── NMH read loop (buffered for partial reads) ──
let readBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk]);

  while (readBuffer.length >= 4) {
    const msgLen = readBuffer.readUInt32LE(0);

    if (msgLen > 1024 * 1024) {
      log(`Message too large: ${msgLen} bytes — dropping`);
      readBuffer = Buffer.alloc(0);
      return;
    }

    if (readBuffer.length < 4 + msgLen) break;

    const msgBuf = readBuffer.slice(4, 4 + msgLen);
    readBuffer = readBuffer.slice(4 + msgLen);

    try {
      const msg = JSON.parse(msgBuf.toString('utf8'));
      log(`RECV: ${msg.type}`);
      companion.handle(msg);
    } catch (err) {
      log(`Parse error: ${err.message}`);
    }
  }
});

process.stdin.on('end', () => {
  log('stdin closed — shutting down');
  companion.shutdown();
  process.exit(0);
});

// ── NMH write ──
function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const byteLen = Buffer.byteLength(json, 'utf8');

  if (byteLen > 900000) {
    log(`WARNING: large message ${msg.type} = ${byteLen} bytes`);
  }

  const buf = Buffer.alloc(4 + byteLen);
  buf.writeUInt32LE(byteLen, 0);
  buf.write(json, 4, 'utf8');
  process.stdout.write(buf);
}

companion.setSend(sendMessage);

// ── Error handling ──
process.on('uncaughtException', (err) => { log(`UNCAUGHT: ${err.stack}`); });
process.on('unhandledRejection', (reason) => { log(`REJECTION: ${reason}`); });
process.on('SIGTERM', () => { log('SIGTERM'); companion.shutdown(); process.exit(0); });

/**
 * Postinstall — registers NMH manifest so Chrome can find companion.
 * Run automatically by npm install, or manually:
 *   CLAUDE_EXTENSION_ID=xxx node scripts/setup.js
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

const HOST_NAME = 'com.claudecode.runtime';
const platform  = os.platform();

const EXTENSION_ID = process.env.CLAUDE_EXTENSION_ID || 'PLACEHOLDER_UPDATE_BEFORE_PUBLISH';

// On Windows → .bat wrapper. On Mac/Linux → .js directly.
const HOST_PATH = platform === 'win32'
  ? path.resolve(__dirname, '..', 'bin', 'host.bat')
  : path.resolve(__dirname, '..', 'bin', 'host.js');

// Make executable on Mac/Linux
if (platform !== 'win32') {
  try { fs.chmodSync(path.resolve(__dirname, '..', 'bin', 'host.js'), '755'); } catch (_) {}
}

const manifest = {
  name: HOST_NAME,
  description: 'Claude Code Workspace companion',
  path: HOST_PATH,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
};

const manifestJson = JSON.stringify(manifest, null, 2);

if (platform === 'win32') {
  const dir = path.join(os.homedir(), '.claudecode-runtime');
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, `${HOST_NAME}.json`);
  fs.writeFileSync(manifestPath, manifestJson);

  const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
  try {
    execFileSync('reg', ['add', regKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
      stdio: 'pipe'
    });
    console.log(`NMH registered: ${regKey}`);
  } catch (err) {
    console.warn('Registry write failed. Try as admin:');
    console.warn(`  reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`);
  }
  console.log(`Manifest: ${manifestPath}`);

} else if (platform === 'darwin') {
  const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${HOST_NAME}.json`), manifestJson);
  console.log('NMH registered (Mac)');

} else {
  for (const browser of ['google-chrome', 'chromium']) {
    const dir = path.join(os.homedir(), '.config', browser, 'NativeMessagingHosts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${HOST_NAME}.json`), manifestJson);
  }
  console.log('NMH registered (Linux)');
}

if (EXTENSION_ID.includes('PLACEHOLDER')) {
  console.log('\nExtension ID not set. After loading extension, run:');
  console.log('  CLAUDE_EXTENSION_ID=your_id node scripts/setup.js');
}

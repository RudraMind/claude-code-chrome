/**
 * Native OS folder picker from headless Node.js context.
 * IMPORTANT: Avoid "Select" in PowerShell strings — parses as Select-Object.
 * Uses execFileSync with array args throughout — no shell injection risk.
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

class FolderPicker {
  constructor({ log }) {
    this.log = log;
  }

  async pick() {
    const platform = os.platform();
    this.log(`FolderPicker: ${platform}`);

    try {
      let result;
      if (platform === 'win32')       result = this._windows();
      else if (platform === 'darwin') result = this._mac();
      else                            result = this._linux();

      if (!result || result === 'CANCELLED') return null;

      result = result.trim();
      if (result.endsWith(path.sep)) result = result.slice(0, -1);

      if (!fs.existsSync(result)) {
        this.log(`FolderPicker: path does not exist: ${result}`);
        return null;
      }

      this.log(`FolderPicker: picked "${result}"`);
      return result;
    } catch (err) {
      this.log(`FolderPicker error: ${err.message}`);
      throw err;
    }
  }

  _windows() {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$d.Description = 'Pick a project folder for Claude Code'",
      '$d.ShowNewFolderButton = $true',
      "if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}else{'CANCELLED'}"
    ].join(';');

    return execFileSync('powershell', ['-NoProfile', '-Command', script], {
      timeout: 120000,
      encoding: 'utf8'
    }).trim();
  }

  _mac() {
    try {
      const result = execFileSync('osascript', [
        '-e', 'POSIX path of (choose folder with prompt "Pick a project folder for Claude Code")'
      ], { timeout: 120000, encoding: 'utf8' }).trim();
      return result.endsWith('/') ? result.slice(0, -1) : result;
    } catch (err) {
      if (err.message.includes('User canceled')) return 'CANCELLED';
      throw err;
    }
  }

  _linux() {
    for (const tool of ['zenity', 'kdialog']) {
      try {
        execFileSync('which', [tool], { stdio: 'pipe' });
        let result;
        if (tool === 'zenity') {
          result = execFileSync('zenity', [
            '--file-selection', '--directory',
            '--title=Pick a project folder for Claude Code'
          ], { timeout: 120000, encoding: 'utf8' }).trim();
        } else {
          result = execFileSync('kdialog', [
            '--getexistingdirectory',
            '--title', 'Pick a project folder for Claude Code'
          ], { timeout: 120000, encoding: 'utf8' }).trim();
        }
        return result || 'CANCELLED';
      } catch (err) {
        if (err.status === 1) return 'CANCELLED';
      }
    }
    throw new Error('No folder picker available. Install zenity (GNOME) or kdialog (KDE).');
  }

  // ── Project Detection (Fix #7: no globs, use readdirSync) ──

  detect(folderPath) {
    const has = (name) => fs.existsSync(path.join(folderPath, name));
    const hasExt = (ext) => {
      try {
        return fs.readdirSync(folderPath).some(f => f.endsWith(ext));
      } catch (_) { return false; }
    };

    const detected = {
      git: has('.git'),
      claudeMd: has('CLAUDE.md'),
      dockerfile: has('Dockerfile') || has('docker-compose.yml') || has('docker-compose.yaml'),
      packageManager: null,
      projectType: null
    };

    // Package manager
    if      (has('pnpm-lock.yaml'))     detected.packageManager = 'pnpm';
    else if (has('yarn.lock'))          detected.packageManager = 'yarn';
    else if (has('bun.lockb'))          detected.packageManager = 'bun';
    else if (has('package-lock.json') || has('package.json')) detected.packageManager = 'npm';

    // Project type
    if (has('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(folderPath, 'package.json'), 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if      (deps['next'])       detected.projectType = 'Next.js';
        else if (deps['nuxt'])       detected.projectType = 'Nuxt';
        else if (deps['react'])      detected.projectType = 'React';
        else if (deps['vue'])        detected.projectType = 'Vue';
        else if (deps['svelte'])     detected.projectType = 'Svelte';
        else if (deps['angular'] || deps['@angular/core']) detected.projectType = 'Angular';
        else if (deps['express'] || deps['fastify'] || deps['koa'] || deps['hono'])
                                     detected.projectType = 'Node.js API';
        else if (deps['electron'])   detected.projectType = 'Electron';
        else                         detected.projectType = 'Node.js';
      } catch (_) {}
    } else if (has('requirements.txt') || has('pyproject.toml') || has('setup.py'))
      detected.projectType = 'Python';
    else if (has('Cargo.toml'))    detected.projectType = 'Rust';
    else if (has('go.mod'))        detected.projectType = 'Go';
    else if (has('build.gradle') || has('pom.xml'))  detected.projectType = 'Java';
    else if (hasExt('.sln') || hasExt('.csproj'))     detected.projectType = 'C#/.NET';

    this.log(`Detected: ${JSON.stringify(detected)}`);
    return detected;
  }
}

module.exports = FolderPicker;

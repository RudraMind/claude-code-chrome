# Claude Code Workspace

Run Claude Code CLI directly in Chrome — side panel terminal with ANSI colors, folder picker, and multi-session support.

![Status](https://img.shields.io/badge/status-MVP%20v1-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Mac%20%7C%20Linux-blue)

---

## What It Does

Opens Claude Code CLI inside a Chrome side panel (or full tab). No terminal app needed.

- Full ANSI / TrueColor rendering via xterm.js
- Native folder picker — pick any project directory
- Project detection: git, CLAUDE.md, framework, package manager
- Multi-panel: side panel + full tab simultaneously, independent sessions
- Persistent sessions: reopen panel → reconnects to last project
- Works on Windows, Mac, Linux

---

## Architecture

```
Chrome Extension (claudecode-workspace/)
    │
    │  Native Messaging Host (NMH)
    ▼
Node.js Companion (claudecode-runtime/)
    │
    │  PTY (node-pty)
    ▼
Claude Code CLI
```

The extension is a renderer only — all state lives in the companion.  
The companion spawns Claude Code in a PTY (full terminal emulation) and streams output to Chrome via NMH.

---

## Install

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 16
- [Claude Code CLI](https://docs.anthropic.com/claude-code) installed and authenticated
  ```
  npm install -g @anthropic-ai/claude-code
  claude --version
  ```

### Step 1: Clone the repo

```bash
git clone https://github.com/RudraMind/claude-code-chrome.git
cd claude-code-chrome
```

### Step 2: Install companion

```bash
cd claudecode-runtime
npm install
```

This installs `node-pty` (PTY emulation) and registers the Native Messaging Host automatically.

### Step 3: Load extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `claudecode-workspace/` folder
4. Copy the **Extension ID** shown

### Step 4: Register NMH with your Extension ID

**Windows:**
```powershell
cd claudecode-runtime
$env:CLAUDE_EXTENSION_ID = "YOUR_EXTENSION_ID_HERE"
node scripts/setup.js
```

**Mac / Linux:**
```bash
cd claudecode-runtime
CLAUDE_EXTENSION_ID=YOUR_EXTENSION_ID_HERE node scripts/setup.js
```

### Step 5: Reload extension

Go to `chrome://extensions` → click **↻ reload** on Claude Code Workspace.

### Step 6: Open

Click the Claude Code Workspace icon in your Chrome toolbar. The side panel opens.

---

## Usage

1. **Click extension icon** → side panel opens, green dot = companion connected
2. **Open Project Folder** → native OS folder picker
3. **Launch Claude Code** → full Claude Code TUI appears in panel
4. Type prompts, get responses — full Claude Code experience
5. **⤢ Full Tab** button → expand terminal to full browser tab
6. **🗑** button → start new session (with confirmation)

---

## Troubleshooting

**Red dot / companion not connected**
```
# Check companion log
cat ~/.claudecode-runtime/companion.log
```
- Verify Extension ID matches NMH manifest
- Reload extension after re-running `setup.js`

**Claude Code not found**
```
claude --version   # must work in terminal
```
- Ensure Claude Code is on PATH
- Windows: restart Chrome after installing Claude Code

**Folder picker doesn't appear (Windows)**
- PowerShell dialog may open behind other windows — check taskbar

**Blank terminal after launch**
- Claude may be authenticating on first run — check if browser opened Anthropic login page
- After login, terminal renders automatically

---

## Known Limitations (v2 Backlog)

- `pick_folder` blocks Node.js event loop while dialog is open (no input/resize during picker)
- No auto-reconnect if Chrome service worker restarts
- Session history not restored after full OS reboot (workspace path is preserved, not PTY state)

---

## Privacy

This extension communicates only with a locally-installed companion process on your machine. No data is sent to external servers.

See [Privacy Policy](https://rudramind.github.io/claude-code-chrome/privacy).

---

## License

MIT

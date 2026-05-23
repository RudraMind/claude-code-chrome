# Post-Mortem: Claude Code Workspace Chrome Extension — MVP v1

**Date:** 2026-05-22 → 2026-05-23  
**Repo:** https://github.com/RudraMind/claude-code-chrome  
**Result:** Shipped working MVP. All 4 test scenarios passing. Multi-panel support confirmed.

---

## What We Built

Chrome MV3 extension that runs Claude Code CLI inside Chrome via:
- Native Messaging Host (NMH) — Node.js companion process bridging Chrome ↔ OS
- PTY (node-pty) — full terminal emulation, ANSI colors, resize
- xterm.js — renders Claude Code TUI inside a side panel or full tab
- Windows: `cmd.exe /c <claudePath>` to work around npm `.cmd` wrapper limitation

---

## What Worked First Time

- ANSI/color rendering — xterm.js faithfully reproduces Claude Code TUI
- `cmd.exe /c claude` preserving `xterm-256color` TERM and PTY dimensions (was an open question at handshake — confirmed working)
- PowerShell `FolderBrowserDialog` folder picker
- Project detection (git, CLAUDE.md, package manager, framework)
- NMH registry entry (`HKCU\...\com.claudecode.runtime`)
- PTY binary loading (`conpty.node`, `pty.node`)
- Log rotation, atomic session.json writes
- `killed` flag preventing onExit race (caught in pre-test review)
- Buffer/flush pattern (PTY output buffered until panel signals ready)

---

## Bugs Found in Pre-Test Review (4-Agent Parallel Review)

**All 11 caught before first launch — none discovered through runtime failure.**

| # | Bug | Root Cause | Fix |
|---|-----|------------|-----|
| 1 | `conpty.node` missing at runtime | `npm install --ignore-scripts` skipped binary download | Run `npm run install` inside package subdir manually |
| 2 | `tabs` permission missing from manifest | Omission in initial spec | Added `"tabs"` to `manifest.json` permissions array |
| 3 | `pty.spawn` fails for `.cmd` on Windows | `CreateProcess` cannot exec `.cmd` npm wrappers directly | Spawn via `cmd.exe /c <claudePath>` on win32 |
| 4 | `onExit` race after restart | Async PTY exit fires after `sessions.delete`, deletes new session | Added `killed` flag to `ClaudeBridge` — intentional kills skip `onExit` |
| 5 | NMH 1MB limit breached | 512KB raw × worst-case JSON encoding (~6×) = up to 3MB | Reduced chunk limit to 100KB max |
| 6 | Restart error uncaught | `_route()` called directly in `setTimeout`, no `try/catch` | Changed to `handle()` — errors become sent error messages |
| 7 | `innerHTML = ''` blocked | Claude Code security hook blocks `innerHTML` assignment | Switched to `element.replaceChildren()` throughout |
| 8 | Shell-based `child_process` blocked | Claude Code security hook blocks shell-based spawning | File-based `execFileSync` with array args everywhere — no shell |
| 9 | Double-spawn on rapid click | No guard on `launchSession()` | Added `launching` boolean guard |
| 10 | Cross-session output | `output`/`session_ended` not filtered by sessionId | Filter both events: `if (msg.sessionId !== currentSession) break` |
| 11 | `panel_ready` skipped on init error | `initTerminal()` throw → companion buffers output forever | `try/catch` around `initTerminal()`, always send `panel_ready` after |
| 12 | Crash on missing `detected` field | `folder_picked` handler assumed `msg.detected` always present | Guard: `const detected = msg.detected \|\| {}` |

---

## Bugs Found During Live Testing

### Bug 13 — Multi-Panel Crosstalk (Critical)
**Symptom:** Opening full-tab view while side panel active → garbled text in both panels. Output from one panel's PTY stream written to the other's xterm simultaneously.

**Root Cause:** Service worker `broadcast()` sent every companion message to ALL connected panels. Panel B's `pong` hit Panel A → Panel A re-ran `get_recent_workspaces` → state machine reset to NO_PROJECT, destroying active terminal. PTY `output` chunks also went to all panels → both xterms wrote the same stream simultaneously → character-level interleaving.

**Fix:** Per-panel routing in service worker. Companion responses routed only to the panel that initiated the request:
- `output`, `session_started`, `session_ended` → session owner (tracked by sessionId)
- `pong` → panel that sent `ping`
- `recent_workspaces` → panel that sent `get_recent_workspaces`
- `folder_picked/cancelled/error` → panel that sent `pick_folder`
- `companion_ready`, `companion_disconnected` → broadcast (all panels need connection state)

### Bug 14 — `claude_missing` Broadcast (Moderate)
**Symptom:** If Claude CLI not found when Panel B starts a session, Panel A also receives `claude_missing` and its terminal state is destroyed.

**Root Cause:** `claude_missing` fell into `default: broadcast(msg)` in SW router.

**Fix:** Added `claude_missing` to the routing table alongside `session_started` — both routed to `lastSessionStarter`.

### Bug 15 — ↺ Button UX (Minor/UX)
**Symptom:** User clicked ↺ (restart icon) expecting reconnect/refresh, got session wiped with no warning.

**Root Cause:** Icon looks identical to browser refresh. No confirmation before destructive action.

**Fix:** 
- Icon: ↺ → 🗑 (trash — visually signals destructive)
- Tooltip: "New Session — clears current conversation"
- Confirm dialog before sending `restart_session`

---

## Learnings

### 1. NMH 1MB limit is deceptive
Raw PTY data looks small. JSON-encoded worst case (backslash/null flood) is 6× larger. Always chunk at `raw_limit / 6`. We used 100KB → ~600KB encoded → safely under 1MB.

### 2. Windows `.cmd` wrappers can't be spawned directly by PTY
`node-pty` calls `CreateProcess` which can't execute `.cmd` files — those require `cmd.exe` to interpret. On Windows: always `spawn('cmd.exe', ['/c', actualPath])`. This is true for any npm-installed CLI.

### 3. Claude Code security hooks block shell-based spawning and `innerHTML`
Any `child_process` call using a shell string (not array args) is blocked. `innerHTML =` assignment is blocked. Test with Claude Code's own security hooks before shipping — they're stricter than standard browser CSP.

### 4. SW broadcast = guaranteed multi-panel corruption
If a service worker broadcasts all messages to all clients, any app with multiple panels will corrupt. The fix pattern: track which client initiated each request, route the response back to that client only. Keep a Map of `sessionId → portId` and `lastRequester` per request type.

### 5. Parallel pre-test code review is worth it
4 agents reviewing different aspects in parallel caught 11 bugs before first launch. Zero runtime debugging needed for those issues. The cost: ~15 min of review. The saving: hours of debugging mysterious PTY/NMH failures.

### 6. Destructive UI actions need both icon AND confirm
Icon alone is misread (↺ looks like refresh to any browser user). Confirm dialog alone is easy to dismiss by habit. Both together = intentional friction that prevents accidents.

### 7. `--ignore-scripts` breaks prebuilt binary packages
`npm install --ignore-scripts` is a security practice but breaks packages like `node-pty-prebuilt-multiarch` that download platform binaries in their `install` script. Either: (a) omit `--ignore-scripts` for trusted packages, or (b) run `npm run install` in the package directory post-install.

---

## Known MVP Trade-offs (Not Fixed — v2 Backlog)

| Issue | Impact | v2 Fix |
|-------|--------|--------|
| `appendOutput` on every PTY chunk → I/O storm | Antivirus EPERM on `session.json`; high write rate | Debounce or write async |
| PTY crash before `panel_ready` → user sees CRASHED with no output | User must check companion.log | Flush buffer to xterm before transitioning to CRASHED state |
| `pick_folder` blocks Node.js event loop (execFileSync) | Input/resize queue during dialog | Run picker in child process |
| SW restart disconnects panel (no auto-reconnect) | Rare in dev; breaking in prod | Port reconnect with exponential backoff |
| `lastPinger` overwritten if two panels init simultaneously | Wrong panel gets `pong` | Replace single-slot trackers with request queue |
| `storage` permission declared, unused | Minor bloat | Remove in v2 |
| ClaudeDetector runs once at startup | Install-after-start invisible | Re-detect on ping |

---

## Final Verification Results

| Test | Result | Notes |
|------|--------|-------|
| Resize (side panel drag + full-tab expand) | PASS | xterm reflows, no artifacts, connection maintained |
| New Session (🗑 + confirm dialog) | PASS | Confirm works, folder preserved, clean welcome screen |
| Folder picker → different project | PASS | Badges update, new session in correct workdir |
| Panel reopen (close + reopen via icon) | PASS | Green dot on reopen, last-folder chip works |
| Multi-panel (side panel + full tab simultaneously) | PASS | Independent sessions, no crosstalk, different folders |

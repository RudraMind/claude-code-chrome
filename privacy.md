# Privacy Policy — Claude Code Workspace

**Last updated:** 2026-05-25

---

## Overview

Claude Code Workspace is a Chrome extension that runs the Claude Code CLI inside Chrome using a locally-installed companion process.

## Data Collection

**This extension does not collect, transmit, or store any personal data on external servers.**

## What the Extension Does

- Communicates with a companion process (`claudecode-runtime`) installed locally on your machine via Chrome's Native Messaging API
- The companion process spawns the Claude Code CLI in a PTY (terminal emulator)
- The companion stores one file locally: `~/.claudecode-runtime/session.json` — contains your last-opened workspace folder path and recent terminal output
- A log file is written to `~/.claudecode-runtime/companion.log` for debugging

## What Stays Local

All of the following remain on your machine only:
- Workspace folder paths you select
- Terminal output from Claude Code sessions
- Session state

## Third-Party Services

This extension does not connect to any third-party services. All Claude Code API calls are made by the Claude Code CLI process running locally, governed by [Anthropic's Privacy Policy](https://www.anthropic.com/privacy).

## Contact

Issues: https://github.com/RudraMind/claude-code-chrome/issues

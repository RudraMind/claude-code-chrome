---
layout: default
title: Privacy Policy
---

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
- The companion stores one file locally: `~/.claudecode-runtime/session.json` — contains your last-opened workspace folder path, detected project metadata (git, project type, package manager), and a rolling buffer of your last 500 terminal output chunks. This data may include code, file contents, and any text typed or printed during your Claude Code session. It is stored only on your local machine and never transmitted externally.
- A log file is written to `~/.claudecode-runtime/companion.log` for debugging purposes only

## What Stays Local

All of the following remain on your machine only and are never transmitted:
- Workspace folder paths you select
- Terminal output from Claude Code sessions (including any code, commands, or text processed by Claude)
- Session state and project metadata
- Companion log files

There is no retention limit enforcement beyond the 500-chunk rolling buffer for terminal output. No mechanism exists in this extension to remotely delete local data.

## Third-Party Services

This extension does not connect to any third-party services. All Claude Code API calls are made by the Claude Code CLI process running locally on your machine, governed by [Anthropic's Privacy Policy](https://www.anthropic.com/privacy).

## Contact

Issues: https://github.com/RudraMind/claude-code-chrome/issues

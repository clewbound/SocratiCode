# SocratiCode daemon mode

This guide covers running SocratiCode as a long-lived daemon instead of as
per-MCP-session stdio subprocesses. Daemon mode is useful when:

- You work in multiple git worktrees and want indexes shared across them.
- You run multiple Claude/Cline/Cursor sessions concurrently.
- You want HEAD-flip detection (branch switches reactively reindex).
- You want automatic GC of stale per-branch collections.

## Quickstart (macOS)

```bash
# 1. Install / update
npm i -g socraticode

# 2. (One-time) start the daemon to verify it works
socraticode daemon
# Listening on http://127.0.0.1:23700/mcp
# Ctrl-C to stop after verifying.

# 3. Install as a launchd service for autostart on login
cp $(npm root -g)/socraticode/launchd/com.socraticode.daemon.plist \
   ~/Library/LaunchAgents/com.socraticode.daemon.plist
launchctl load -w ~/Library/LaunchAgents/com.socraticode.daemon.plist

# 4. Verify it's running
socraticode daemon status

# 5. Update your MCP client config (e.g., .mcp.json):
#    "socraticode": { "type": "http", "url": "http://127.0.0.1:23700/mcp" }
```

## Linux (systemd-user)

Create `~/.config/systemd/user/socraticode-daemon.service`:

```ini
[Unit]
Description=SocratiCode daemon
After=network.target

[Service]
ExecStart=/usr/local/bin/socraticode daemon
Restart=always
RestartSec=5
Environment=SOCRATICODE_REPO_KEYING=true
Environment=SOCRATICODE_LOG_FILE=%h/.local/state/socraticode/daemon.log
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now socraticode-daemon
systemctl --user status socraticode-daemon
```

### Finding the binary path

If `/usr/local/bin/socraticode` doesn't exist on your system, find the actual path:

```bash
which socraticode
# or:
npm root -g
# socraticode binary is at: $(npm root -g)/socraticode/dist/index.js (invoke via node)
```

Update the `ProgramArguments` in your launchd plist accordingly.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `SOCRATICODE_REPO_KEYING` | (off) | Daemon mode implies `true`. Switches to per-(repo, branch) keying. |
| `SOCRATICODE_DAEMON_PORT` | `23700` | HTTP listen port. |
| `SOCRATICODE_DAEMON_BIND` | `127.0.0.1` | Listen address (loopback only by default). |
| `SOCRATICODE_LOG_FILE` | unset | If set, daemon writes structured logs to this file. |
| `SOCRATICODE_GC_GRACE_DAYS` | `7` | Grace period before deleting dead-branch collections. |
| `SOCRATICODE_GC_INACTIVITY_DAYS` | `14` | Inactivity timeout for implicit watchlist entries. |
| `SOCRATICODE_GC_INTERVAL_HOURS` | `24` | How often the periodic GC runs. |
| `SOCRATICODE_STATE_DIR` | XDG-default | Override watchlist+marker location. |
| `SOCRATICODE_REPO_ID` | unset | Pin a repo identifier (overrides common-dir derivation). |

## Migration from BRANCH_AWARE

If you previously ran with `SOCRATICODE_BRANCH_AWARE=true`, your existing collections are keyed by `<pathhash>__<branch>`. After enabling repo-keying:

```bash
socraticode migrate-legacy-keying --dry-run   # preview
socraticode migrate-legacy-keying              # rename in place
```

The migration is idempotent (gated by a marker file in the state dir). See the migration tool's --help for `--force` to re-run.

## Troubleshooting

- **Daemon won't start** — check `lsof -i :23700` for a port conflict; check the log file at `SOCRATICODE_LOG_FILE`.
- **MCP client can't connect** — verify `curl http://127.0.0.1:23700/healthz` returns `{"ok":true,...}`.
- **Stale lock files** — `cleanupStaleLocks` runs at daemon startup. If you're seeing "lock-holder" errors, restart the daemon.
- **Indexes seem out of date** — use `socraticode daemon watchlist` to confirm the path is registered, and `socraticode daemon gc --dry-run` to surface candidates for cleanup.
- **Worktree not auto-discovered** — implicit registration only triggers on the FIRST MCP call against a path. For pre-warming, run `socraticode daemon watch <path>`.

## Limitations (v1)

- Daemon is laptop-local; no shared-machine multi-user support.
- No pre-warm reconciliation: the first MCP query after a daemon restart eats reconciliation cost (cheap when content is unchanged thanks to fast-skip).
- HEAD-change detection requires the daemon to be running; flips that happen while the daemon is down are caught lazily on next query.
- `projectPath` is required on tool calls in daemon mode (no `process.cwd()` fallback).

See [the design doc](https://github.com/giancarloerra/socraticode/blob/main/docs/daemon-mode-design.md) for architectural detail.

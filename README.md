# Claude VS Code Status

A small, local-only VS Code extension that shows useful Claude Code session information directly in the VS Code status bar.

```text
Opus 5 (High) │ Context 4% · 38.9k/1m │ 5h 45% │ 7d 5%
```

Claude VS Code Status is designed to be transparent and easy to audit. It does not sign in to your Anthropic account, call unofficial APIs, send telemetry, or upload your conversations anywhere.

## What it shows

The status bar can display:

- Active Claude model, for example `Opus 5` or `Sonnet 5`
- Effort level, when Claude exposes it
- Current context-window usage as a percentage
- Current context tokens and context-window size
- 5-hour usage percentage
- 7-day usage percentage

Hover over the status item for more detail, including fresh input tokens, cache-write tokens, cache-read tokens, last output tokens, rate-limit reset times, Claude Code version, data source, and the selected session.

## How it works

The extension uses two local data sources.

### Native Claude Code for VS Code

For conversations started in the official Claude Code VS Code extension, model, effort, and token metadata are read from Claude Code's local transcript files under your home directory:

```text
~/.claude/projects/
```

Only the metadata needed to build the status display is retained in memory. The extension does not transmit transcript contents.

### Optional 5h / 7d usage bridge

Claude's native VS Code transcript does not currently expose the account-level 5-hour and 7-day usage fields used by this extension. To obtain those values, Claude VS Code Status can install a small local `statusLine` bridge in Claude Code.

On first run, VS Code asks whether you want to enable this bridge. No terminal commands are required.

If enabled, the extension:

1. Creates a backup of `~/.claude/settings.json`.
2. Writes a small local bridge under `~/.claude/vscode-status/`.
3. Registers it as Claude Code's `statusLine` command.
4. Stores only the status metadata needed by the extension in `~/.claude/vscode-status/sessions/`.

If another `statusLine` is already configured, the extension will not silently replace it. It asks for confirmation and saves the previous configuration so it can be restored later.

The bridge can be removed at any time with **Claude Status: Disable Usage Bridge and Restore Previous StatusLine**.

## Installation

### From a VSIX

1. Download the `.vsix` release.
2. Open VS Code.
3. Open **Extensions**.
4. Open the `...` menu and choose **Install from VSIX...**.
5. Select the downloaded file.
6. Reload VS Code if prompted.

No shell, `jq`, Python, or manual setup commands are required.

### Marketplace

Marketplace installation can be added after the project is published under a VS Code Marketplace publisher account.

## First run

Open a project in VS Code and use Claude Code normally. After Claude produces a response, the status item should appear automatically.

The extension may ask once whether you want to enable the optional 5h/7d usage bridge. Choose **Enable 5h/7d** if you want those fields. Model and context information can work without the bridge for native VS Code conversations.

## Multiple Claude conversations

Claude Code may have several conversations associated with the same workspace. By default, Claude VS Code Status selects the most recently active matching native conversation.

Click the status-bar item to select and pin a specific conversation. Use **Claude Status: Clear Session Pin (Auto-detect)** to return to automatic selection.

## Commands

Open the VS Code Command Palette and search for `Claude Status`:

- **Claude Status: Enable/Update 5h & 7d Usage Bridge** — installs or updates the local rate-limit bridge.
- **Claude Status: Refresh** — immediately refreshes the display.
- **Claude Status: Select/Pin Session** — selects a Claude conversation for the current VS Code workspace.
- **Claude Status: Clear Session Pin (Auto-detect)** — returns to automatic conversation selection.
- **Claude Status: Disable Usage Bridge and Restore Previous StatusLine** — removes the bridge and restores the previous Claude `statusLine` configuration when available.

## Settings

### `claudeVscodeStatus.refreshInterval`

How often, in seconds, the extension checks local Claude files. Default: `2`.

This does not make network requests.

### `claudeVscodeStatus.showTokens`

Show token counts next to the context percentage. Default: `true`.

### `claudeVscodeStatus.defaultContextWindowSize`

Fallback context-window size when a native transcript does not expose an explicit size. Default: `1000000`.

When the fallback is used, the tooltip labels the window size as a fallback.

## Platform support

Version 1.1.0 is designed for:

- macOS — primary tested platform
- Linux — supported by the same POSIX bridge and platform-independent path handling
- Windows — supported with a PowerShell bridge and Windows path handling

No user-entered terminal commands are required on any platform. Because macOS is the primary tested environment for the initial public release, Windows and Linux users are encouraged to report compatibility issues with their Claude Code version and VS Code version.

## Privacy and security

Claude VS Code Status is intentionally local-only:

- No telemetry
- No analytics
- No external network requests
- No Anthropic credentials are requested or stored
- No cookies are read
- No unofficial Claude API is used
- No conversation data is uploaded

The extension reads local Claude Code transcript metadata to determine the active model and token usage. The optional bridge receives Claude Code's `statusLine` JSON locally and writes a reduced metadata object to a local cache.

The cache directory is:

```text
~/.claude/vscode-status/
```

Bridge cache entries older than seven days are cleaned up automatically when the bridge runs.

## Important compatibility note

The native transcript format under `~/.claude` is an implementation detail of Claude Code and may change between Claude Code releases. The parser is intentionally defensive, but a future Claude Code update may temporarily break native transcript detection until the extension is updated.

The 5h/7d fields also depend on Claude Code exposing rate-limit information to its `statusLine` input.

## Troubleshooting

If the status bar says `Claude: waiting for data`, send a message in the Claude Code panel and wait for the response to complete. Then run **Claude Status: Refresh**.

If the wrong conversation is selected, click the status item and pin the correct session.

If model/context works but `5h –% │ 7d –%` is shown, enable the usage bridge from the Command Palette. Rate-limit values appear after Claude Code emits status data.

If you already use a custom Claude Code `statusLine`, review the confirmation dialog carefully before enabling the usage bridge. The extension always attempts to preserve and restore the previous configuration.

## Development

Requirements:

- Node.js
- npm
- VS Code

Install dependencies and compile:

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host.

For a Marketplace release, set the `publisher` field in `package.json` to your real VS Code Marketplace publisher ID and package/publish with the official VS Code extension tooling.

## License

MIT. See [LICENSE](LICENSE).

## Disclaimer

This is an independent community project and is not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are trademarks of their respective owner.

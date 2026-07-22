# Unit: webui-settings

Files: src/webuiSettings.ts, src/webuiSettings.test.ts

## Purpose

Manages persistence and validation of Web UI settings (instance name and tab icon) stored as a JSON file, including migration from a legacy file path to the current state directory.

## Key Exports

- `WebUiSettings` — Type defining the settings shape (`instanceName`, `tabIcon`)
- `getWebUiSettingsPath(stateDir?)` — Returns the current settings file path
- `getLegacyWebUiSettingsPath(baseDir?)` — Returns the legacy settings file path
- `normalizeWebUiInstanceName(value)` — Validates and normalizes the instance name string
- `normalizeWebUiTabIcon(value)` — Validates and normalizes the tab icon string
- `readWebUiSettings(options?)` — Reads settings from disk with legacy migration fallback
- `writeWebUiSettings(settings, options?)` — Validates and writes settings to disk

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `getWebUiSettingsPath(stateDir)` | ~15 | Builds path to the settings JSON file |
| `getLegacyWebUiSettingsPath(baseDir)` | ~19 | Builds path to the legacy settings file |
| `isSamePath(a, b)` | ~23 | Compares two paths after resolving them |
| `normalizeWebUiInstanceName(value)` | ~27 | Sanitizes and length-checks instance name |
| `normalizeWebUiTabIcon(value)` | ~44 | Sanitizes and length-checks tab icon |
| `readWebUiSettingsFromPath(filePath)` | ~62 | Reads and normalizes settings from a given file |
| `readWebUiSettings(options)` | ~69 | Reads settings with fallback to legacy path and auto-migration |
| `writeWebUiSettings(settings, options)` | ~96 | Normalizes and persists settings to disk |

## Dependencies

- `./config` — `BASE_DIR`, `STATE_DIR` (directory path constants)
- `./common` — `logger` (structured logging)

## Behavior

- Normalizes string fields by stripping control characters, collapsing whitespace, and enforcing max lengths (80 chars for instance name, 16 grapheme chars for tab icon).
- On read, if the current settings file doesn't exist but a legacy file does, it migrates by copying the parsed content to the new location.
- Returns safe defaults (`{ instanceName: '', tabIcon: '' }`) when files are missing or unreadable.
- Write operations ensure the target directory exists before persisting.

## Integration

- Consumed by the web UI layer to display a custom instance name and browser tab icon.
- Relies on `config` module for base/state directory paths, making it environment-aware.
- The migration logic bridges older installations to the current state directory layout transparently on first read.

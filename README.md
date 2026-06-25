# EclipseTabGuard

A smart tab suspender browser extension built with TypeScript. Works on Firefox and Chrome.

## What it does

EclipseTabGuard automatically **suspends** browser tabs that haven't been used for a configurable period of time. Suspended tabs free their memory but remain in your tab bar — clicking one simply reloads it.

## Features

- **Auto-suspend** — tabs inactive past a configurable timeout are suspended automatically (checked every minute)
- **Blacklist** — domains that are always suspended immediately on the next check, regardless of timeout
- **Whitelist** — domains that are never suspended
- **Tab browser** — view all open tabs with their status (Active / Suspended / Pinned) and click to focus any tab
- **Suspend on startup** — optionally suspend all background tabs the moment the browser opens
- **Suspend Now** — manually trigger suspension of all eligible tabs instantly

## Smart skip rules

| Rule | Default |
|---|---|
| Skip the currently active tab | always on |
| Skip pinned tabs | off |
| Skip tabs playing audio | on |
| Skip tabs still loading | on |
| Suspend on startup | off |
| Inactivity timeout | 3 minutes |

## Storage

- **Settings** — saved to `chrome.storage.local` (persistent, local-only, 5 MB limit)
- **Tab activity timestamps** — saved to `chrome.storage.session` (in-memory, cleared on browser close)

## Development

```bash
npm install
npm run build      # typecheck -> compile -> copy assets -> dist/
npm run package    # build + zip to eclipsetabguard.zip
```

Load the `dist/` folder as an unpacked extension in your browser.

## Permissions

| Permission | Reason |
|---|---|
| `tabs` | Read tab state (active, pinned, audible, URL) and discard inactive tabs |
| `storage` | Persist settings (`local`) and activity timestamps (`session`) |
| `alarms` | Schedule a periodic suspension check every 1 minute |
| `idle` | Reserved for future idle-state awareness |

## Privacy

EclipseTabGuard does not collect, store, or transmit any user data.

All suspension logic runs entirely on your device. The extension reads tab metadata (URL hostname, active/pinned/audible state) solely to decide whether to suspend a tab — this data is never sent anywhere, logged, or shared with any third party.

## License

MIT
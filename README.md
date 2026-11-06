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
- **Cache warming** *(beta)* — periodically re-fetches suspended tab URLs in the background to keep them fresh in the HTTP cache, so they load faster when clicked
- **Save video timestamps** *(beta)* — automatically save the latest timestamp when paused and restore it after a page reload; briefly undo a save in the notification, or manage saved timestamps from the popup's Videos panel

## Smart skip rules

| Rule | Default |
|---|---|
| Skip the currently active tab | always on |
| Skip pinned tabs | off |
| Skip tabs playing audio | on |
| Skip tabs still loading | off |
| Suspend on startup | on |
| Inactivity timeout | 3 minutes |
| Cache warming | off |
| Cache warm interval | 10 minutes |
| Save video timestamps | off |
| Video save alerts | on |
| Video minimum change | 30 seconds (not applied by default) |
| Video undo cooldown | 10 seconds (same video) |

## Storage

- **Settings** — saved to `chrome.storage.sync` (synced across devices, 100 KB limit)
- **Tab activity timestamps** — saved to `chrome.storage.session` (in-memory, cleared on browser close)
- **Saved video timestamps** — saved to `chrome.storage.local` on this device; view or delete individual timestamps, or clear them all, from the Videos panel

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
| `scripting` + host access | Inject the optional video-timestamp monitor into open web pages |

## Privacy

EclipseTabGuard does not transmit user data.

All extension logic runs on your device. When Save video timestamps is enabled, the extension reads video timestamps and the page title and URL when a video is paused. These records are stored in the browser's local extension storage and can be individually deleted or cleared from the Videos panel. The feature is off by default.

## License

MIT
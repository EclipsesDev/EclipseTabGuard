# EclipseTabGuard

A smart tab suspender browser extension (Manifest V3) built with TypeScript.

## What it does

EclipseTabGuard automatically **discards** (suspends) browser tabs that haven't been used for a configurable period of time. Discarded tabs free their memory but remain in your tab bar — clicking one simply reloads it.

### Smart rules

| Rule | Default |
|---|---|
| Skip pinned tabs | ✅ on |
| Skip tabs playing audio | ✅ on |
| Skip the currently active tab | always on |
| Configurable timeout | 30 minutes |
| Per-domain whitelist | empty |

## Development

```bash
npm install
npm run build      # typecheck → compile → copy assets → dist/
npm run package    # build + zip to eclipsetabguard.zip
```

Load the `dist/` folder as an unpacked extension in your browser.

## Permissions used

| Permission | Reason |
|---|---|
| `tabs` | Read tab state, discard inactive tabs |
| `storage` | Persist settings (sync) and activity map (session) |
| `alarms` | Periodic check every 1 minute |
| `idle` | Reserved for future idle-state awareness |

## License

MIT
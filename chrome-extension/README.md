# NetRoute — Chrome extension

See which ISP, network and datacenter serves every site you visit, right from the toolbar.

- **Toolbar badge** — country code of the server the current tab is loaded from. Orange = datacenter / hosting / CDN, blue = ISP network, grey = local. Hover for the full name.
- **Popup** — the server's IP, owner (ISP · org), ASN, location and reverse DNS; every other host the page connected to, grouped by network, with request counts (the page's own domains are outlined in blue).
- **Trace route** — streams a live traceroute from your Mac to the exact server IP Chrome used, shows the chain of networks it crosses, and links to the full map in the NetRoute app. Click any host chip to trace that host instead.

The badge and connection list work on their own. **Route tracing needs the NetRoute app running** (`python3 netroute.py` in the repo root) because a browser extension can't run `traceroute`; the green/red dot in the popup header shows whether the app is reachable.

## Install

**Load unpacked (recommended, works in every Chrome channel)**

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the `chrome-extension/src` folder
   (or unzip `dist/netroute-extension-v1.0.0.zip` somewhere and pick that folder).
3. Pin NetRoute from the puzzle-piece menu, then reload any open tabs.

**Packed `.crx`** — `dist/netroute-extension-v1.0.0.crx` is a signed CRX3 package. Drag it onto `chrome://extensions` with Developer mode on. Stable Chrome on macOS/Windows blocks `.crx` files that don't come from the Web Store; Dev/Canary channels and Linux usually accept them. If Chrome refuses, use Load unpacked.

**Chrome Web Store** — upload `dist/netroute-extension-v1.0.0.zip` in the developer dashboard.

## Build

```bash
python3 build.py
```

Writes `dist/netroute-extension-v<version>.zip` and a signed `.crx` (needs only Python 3 and `openssl`). The signing key is created on first run in `keys/netroute-extension.pem` and is git-ignored. Keep it: building with the same key keeps the same extension ID, so new versions install over the old one. Bump `version` in `src/manifest.json` before each release.

`python3 tools/make_icons.py` redraws the icons in `src/icons/`.

## Privacy

- Server IPs your tabs connect to are sent to [ip-api.com](https://ip-api.com) for the ISP / ASN / location lookup (cached for 24 hours in the extension's local storage). Page URLs and contents are never sent anywhere.
- Per-tab connection lists are kept in session storage and cleared when Chrome closes or the tab is closed.
- Traceroutes go only to the NetRoute app on `127.0.0.1:8765`.

## Permissions

| Permission | Why |
|---|---|
| `webRequest` | read the server IP of each request a tab makes (read-only, nothing is blocked or changed) |
| `<all_urls>` host access | needed for `webRequest` on every site, plus calls to ip-api.com and the local app |
| `storage` | cache lookups and keep per-tab state while the service worker sleeps |

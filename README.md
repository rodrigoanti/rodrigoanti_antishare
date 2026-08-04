# AntiShare

LAN mesh folder sharing (model B): each machine picks a local folder, serves it over HTTP, and discovers peers on the LAN.

## Stack

- Electron + TypeScript (electron-vite)
- Share HTTP server in Node (main process)
- UDP broadcast peer discovery
- Typed IPC via `contextBridge` (`window.antishare`)

## Quick start

```bash
npm install
npm run dev
```

Scripts: `dev` · `build` · `start` (preview) · `dist:win` (Windows NSIS installer) · `dist:win:portable`

## Windows installer

Produces an NSIS setup `.exe` under `dist/` (desktop + Start Menu shortcuts).

```bash
npm install
npm run dist:win
```

Artifact: `dist/AntiShare-<version>-win-x64-setup.exe`

Portable (no install): `npm run dist:win:portable` → `dist/AntiShare-<version>-win-x64-portable.exe`

App icon: `build/icon.ico` / `build/icon.png` (blue folder matching the in-app Finder icons).

Config: `electron-builder.yml` (`appId` `com.antishare.app`, packages `out/` from electron-vite).  
`dist:win` forces `--x64`. Signing is optional (`CSC_IDENTITY_AUTO_DISCOVERY=false` skips code signing).

Generic pack: `npm run dist` (uses targets from `electron-builder.yml`).

## Share HTTP API (fixed port `8765`, bind `0.0.0.0`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | HTML directory listing (`?path=`); `Accept: application/json` or `?format=json` for JSON |
| GET | `/api/list?path=` | `{ name, path, isDir, size, mtime }[]` |
| GET | `/api/download?path=` | File download (paths confined under share root; `..` blocked) |
| POST | `/api/upload?path=` | Multipart upload into share root (creates dirs) |

Optional header: `X-Share-Token` when a token is configured.

### curl examples

```bash
# List
curl -s 'http://127.0.0.1:8765/api/list?path='

# Download
curl -OJ 'http://127.0.0.1:8765/api/download?path=readme.txt'

# Upload
curl -F 'file=@./local.txt' 'http://127.0.0.1:8765/api/upload?path='

# With token
curl -s -H 'X-Share-Token: secret' 'http://127.0.0.1:8765/api/list?path='

# Path traversal (should fail 403)
curl -s 'http://127.0.0.1:8765/api/list?path=../../etc'
```

## IPC (`window.antishare`)

| Channel | Args | Result |
|---------|------|--------|
| `share:selectFolder` | — | folder path or `null` |
| `share:start` | `{ folder, token? }` | `{ ok, urls[], port }` (port always `8765`) |
| `share:stop` | — | `{ ok }` |
| `share:status` | — | `{ running, folder, port, urls[], tokenRequired }` |
| `share:listLocal` | `{ path? }` | `{ ok, entries?, folder? }` from settings/active share root |
| `settings:get` | — | `{ folder, token?, autoStart }` |
| `settings:set` | partial settings | saved `ShareSettings` |
| `network:diagnose` | — | `{ checks[], summaryEs }` probes LAN readiness (Spanish) |
| `files:startDrag` | `{ kind:'local', path }` \| `{ kind:'remote', … }` | `{ ok }` prepare+drag (macOS OK; Windows: prefer prepare) |
| `files:prepareDrag` | same as startDrag | `{ ok, filePath? }` download/resolve ahead of dragstart |
| `files:startDragLocal` | absolute `filePath` | `{ ok }` call from `dragstart` (Windows-safe) |
| `peers:list` | — | `Peer[]` |
| `peers:onUpdate` | event | `Peer[]` |
| `peers:addManual` | `{ host, port, tokenRequired?, token? }` | `{ ok, peer? }` |
| `peers:removeManual` | `{ host, port }` | `{ ok }` |
| `remote:list` | `{ baseUrl, path?, token? }` | entries |
| `remote:download` | `{ baseUrl, path, destPath?, token? }` | `{ ok, destPath? }` → OS Downloads si no hay `destPath` |
| `remote:upload` | `{ baseUrl, path, filePath, token? }` | `{ ok }` |
| `shell:showItemInFolder` | `path` | `{ ok }` reveals file in Finder/Explorador |

### Downloads folder (both OS)

When `destPath` is omitted, files go to `app.getPath('downloads')`:

- **macOS:** `~/Downloads`
- **Windows:** `%USERPROFILE%\Downloads` (e.g. `C:\Users\<you>\Downloads`)

Collisions become `name (1).ext`, `name (2).ext`, …. Explicit `destPath` (drag temp under `%TEMP%\antishare-drag`) is unchanged.

### Drag-out on Windows

Remote drag should **prepare before/during pointerdown**, then start drag synchronously on `dragstart`:

```ts
const prep = await antishare.prepareDrag({ kind: 'remote', baseUrl, path, token })
// on dragstart:
await antishare.startDragLocal(prep.filePath!)
```

Local files can use `startDrag({ kind:'local', path })` or the same prepare + `startDragLocal` flow. Icons are a non-empty 64×64 PNG (`resources/drag-icon.png`).


Shared types: `src/shared/types.ts` (for Frontend).

## Peer discovery

- UDP listen starts with the app; announce only while sharing (~2s)
- Targets: multicast `239.255.76.67`, `255.255.255.255`, and per-iface subnet broadcast (`x.x.x.255`) on port **8766**
- Self-filter: same **local IP and share port** only — remote peers may use the same port number
- Manual join: `window.antishare.addManualPeer({ host, port })` probes `GET /api/list` and upserts the peer
- Stale UDP peers drop after ~25s; manual peers stay until `removeManualPeer`

**Firewall:** both machines should allow AntiShare (UDP **8766** discovery, TCP share port e.g. **8765**). On Windows, allow the app through the firewall when prompted.

### Verify two instances see each other

1. Start share on **both** machines (TCP **8765**, UDP discovery **8766**).
2. Within a few seconds each should list the other via `peers:list` / `peers:onUpdate`.
3. If the list stays empty (UDP blocked): `addManualPeer({ host: '<lan-ip>', port: 8765 })`.
4. Smoke: `npx tsx scripts/smoke-discovery.ts`
5. Or curl: `curl -s http://<peer-lan-ip>:8765/api/list`

Share port is fixed at **8765** (not configurable). Home UI lists the local folder via `share:listLocal`.

## Project layout

```
src/main/       Electron main, share server, discovery, remote client, IPC
src/preload/    contextBridge API
src/renderer/   UI stub (Frontend)
src/shared/     Shared TypeScript contracts
```

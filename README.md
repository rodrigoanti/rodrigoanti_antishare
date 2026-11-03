# AntiShare

LAN folder sync by **groups**: a group has a name and a password; each member picks which local folder it syncs, and every member keeps an identical copy (no central server).

## Stack

- Electron + TypeScript (electron-vite)
- Group HTTP server in Node (main process, port 8765)
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

## Groups

- **Create:** name + password + local folder. **Join:** pick a group seen on the LAN, type its password, choose your folder.
- **Any member manages:** rename, change password, move its own folder, leave, or delete for everyone (files stay on disk).
- **Password change:** every other member is paused ("La clave cambió") until it types the new one, so someone who only knew the old password is out.
- Code: `src/main/groupManager.ts` (memberships, engines, server hooks), `groupStore.ts` (`userData/groups.json`, keys only), `groupAuth.ts`.

## Group HTTP API (fixed port `8765`, bind `0.0.0.0`)

Every `/g/` route needs `X-Group-Auth: <deviceId>.<ms>.<hmac-sha256(key, METHOD\npath?query\nms)>`, where `key = scrypt(password, "antishare-group:" + groupId)`. The password never travels; signatures expire after 5 min.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/hello` | `{ app, name, deviceId }` — unauthenticated liveness probe |
| GET | `/g/:id/meta` | `{ id, meta: { name, deleted, rev, at, by }, keySince }` |
| GET | `/g/:id/index` | `{ groupId, deviceId, deviceName, entries }` — per-file hash + version vector |
| GET | `/g/:id/download?path=` | File bytes (confined to the group folder) |
| POST | `/g/:id/notify` | `{ deviceId }` — "I have changes", members pull right away |

### Sync

- Local edits: folder watcher + rescan every 20s; files still being written are skipped until stable (`src/main/syncIndex.ts`).
- Remote changes: download to a temp file, verify sha256, then swap in (`src/main/syncEngine.ts`).
- Deletions propagate as tombstones; an edit always beats a concurrent delete.
- Concurrent edits: the most recent save keeps the name, the other becomes `name (conflicto de PC fecha).ext`.
- Index lives in `userData/sync/`, never inside the synced folder. Smoke: `npm run smoke:sync` (whole group life on two devices).

## IPC (`window.antishare`)

| Channel | Args | Result |
|---------|------|--------|
| `groups:list` | — | `{ serverRunning, groups[], discovered[] }` |
| `groups:create` | `{ name, password, folder }` | `{ ok, group? }` |
| `groups:join` | `{ id, password, folder }` | `{ ok, group? }` (also unlocks after a password change) |
| `groups:update` | `{ id, name?, password?, folder? }` | `{ ok, group? }` |
| `groups:leave` | `{ id, forEveryone }` | `{ ok }` |
| `share:listLocal` | `{ groupId, path? }` | `{ ok, entries? }` |
| `files:*` | `{ groupId, … }` | import, export, mkdir, rename, move, remove, open |
| `network:diagnose` | — | `{ checks[], summaryEs }` probes LAN readiness (Spanish) |
| `shell:showItemInFolder` | `path` | `{ ok }` reveals file in Finder/Explorador |

Shared types: `src/shared/types.ts` (for Frontend).

## Peer discovery

- UDP listen and announce (~2s) run for the whole app life; each announce lists the device's groups (`{ id, name, keySince, deleted? }`, never keys)
- Targets: multicast `239.255.76.67`, `255.255.255.255`, and per-iface subnet broadcast (`x.x.x.255`) on port **8766**
- Self-filter: same **local IP and share port** only — remote peers may use the same port number
- Stale UDP peers drop after ~10s

**Firewall:** both machines should allow AntiShare (UDP **8766** discovery, TCP **8765** groups). On Windows, allow the app through the firewall when prompted.

### Verify two instances see each other

1. Open AntiShare on both machines; create a group on one.
2. Within a few seconds the other lists it under **En la red**.
3. If not, run the network check (gear on the welcome screen) or `curl -s http://<peer-lan-ip>:8765/api/hello`.

## Project layout

```
src/main/       Electron main, group server + manager, sync engine, discovery, IPC
src/preload/    contextBridge API
src/renderer/   UI stub (Frontend)
src/shared/     Shared TypeScript contracts
```

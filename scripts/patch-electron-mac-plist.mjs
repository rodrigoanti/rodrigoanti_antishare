#!/usr/bin/env node
/**
 * Inject Local Network TCC keys into Electron.app Info.plist (dev / npm run dev).
 * Packaged AntiShare.app gets the same keys via electron-builder mac.extendInfo.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const USAGE =
  'AntiShare descubre otros equipos en tu red local (Wi‑Fi o Ethernet) y comparte carpetas en la LAN. Sin este permiso, los peers no pueden verte ni abrir tu share.'

const BONJOUR = ['_antishare._udp.', '_http._tcp.']

function electronAppPlist() {
  if (process.platform !== 'darwin') return null
  try {
    const require = createRequire(import.meta.url)
    const electronPath = require('electron')
    // .../Electron.app/Contents/MacOS/Electron
    const plist = join(dirname(electronPath), '..', 'Info.plist')
    return existsSync(plist) ? plist : null
  } catch {
    const fallback = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'node_modules/electron/dist/Electron.app/Contents/Info.plist'
    )
    return existsSync(fallback) ? fallback : null
  }
}

function buddy(plist, command) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function tryBuddy(plist, command) {
  try {
    return buddy(plist, command).trim()
  } catch {
    return null
  }
}

function main() {
  if (process.platform !== 'darwin') {
    process.exit(0)
  }
  const plist = electronAppPlist()
  if (!plist) {
    console.warn('[patch-electron-mac-plist] Electron.app Info.plist not found')
    process.exit(0)
  }

  const current = tryBuddy(plist, 'Print :NSLocalNetworkUsageDescription')
  if (current !== USAGE) {
    if (current != null) tryBuddy(plist, 'Delete :NSLocalNetworkUsageDescription')
    buddy(plist, `Add :NSLocalNetworkUsageDescription string ${JSON.stringify(USAGE)}`)
  }

  tryBuddy(plist, 'Delete :NSBonjourServices')
  buddy(plist, 'Add :NSBonjourServices array')
  BONJOUR.forEach((svc, i) => {
    buddy(plist, `Add :NSBonjourServices:${i} string ${JSON.stringify(svc)}`)
  })

  const verify = tryBuddy(plist, 'Print :NSLocalNetworkUsageDescription')
  if (!verify) {
    console.error('[patch-electron-mac-plist] failed to write NSLocalNetworkUsageDescription')
    process.exit(1)
  }
  console.log('[patch-electron-mac-plist] patched', plist)
}

main()

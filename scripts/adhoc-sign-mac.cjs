/**
 * electron-builder afterPack hook (macOS).
 *
 * Without a Developer ID, electron-builder skips signing and ships the Electron
 * linker-signed stub: `Identifier=Electron`, `Sealed Resources=none`, no entitlements.
 * macOS then keys the Local Network (TCC) grant to "Electron" instead of AntiShare and
 * can deny LAN access silently. Ad-hoc signing inside-out gives a sealed bundle whose
 * identifier comes from our Info.plist, so TCC can identify the app.
 */
const { execFileSync } = require('child_process')
const { existsSync, readdirSync, statSync } = require('fs')
const { join, resolve } = require('path')

const ENTITLEMENTS = resolve(__dirname, '..', 'build', 'entitlements.mac.plist')

function isMachOCode(path) {
  return /\.(dylib|so|node)$/.test(path)
}

/** Nested bundles and Mach-O files, deepest first (codesign requires inside-out). */
function collectNestedCode(appPath) {
  const found = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (/\.(app|framework)$/.test(entry.name)) {
          found.push({ path: full, depth })
        }
        walk(full, depth + 1)
      } else if (entry.isFile() && isMachOCode(entry.name)) {
        found.push({ path: full, depth })
      }
    }
  }
  walk(join(appPath, 'Contents'), 1)
  return found.sort((a, b) => b.depth - a.depth).map((e) => e.path)
}

function sign(target) {
  execFileSync(
    'codesign',
    [
      '--force',
      '--sign',
      '-',
      '--timestamp=none',
      '--options',
      'runtime',
      '--entitlements',
      ENTITLEMENTS,
      target
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'true') return

  const appName = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${appName}.app`)
  if (!existsSync(appPath) || !statSync(appPath).isDirectory()) return
  if (!existsSync(ENTITLEMENTS)) {
    throw new Error(`Missing entitlements file: ${ENTITLEMENTS}`)
  }

  for (const nested of collectNestedCode(appPath)) {
    sign(nested)
  }
  sign(appPath)

  execFileSync('codesign', ['--verify', '--strict', appPath], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
  console.log(`  • ad-hoc signed and verified ${appName}.app`)
}

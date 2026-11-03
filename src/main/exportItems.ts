/**
 * Export group items to a user-chosen absolute folder (Guardar como…).
 * Progress: real byte totals from copyPathsToDirectory.
 */
import { statSync } from 'fs'
import type { ExportItemsRequest, ExportItemsResult } from '../shared/types'
import { copyPathsToDirectory } from './importFiles'
import { resolveSafe } from './pathSafe'

export async function exportItemsToFolder(
  localRoot: string | null,
  req: ExportItemsRequest,
  onProgress?: (copiedBytes: number, totalBytes: number) => void
): Promise<ExportItemsResult> {
  const items = Array.isArray(req.items) ? req.items : []
  if (items.length === 0) {
    return { ok: false, exported: 0, error: 'No hay ítems para exportar.' }
  }
  if (!localRoot) {
    return { ok: false, exported: 0, error: 'Ese grupo no tiene una carpeta disponible en este equipo.' }
  }

  const sources: string[] = []
  for (const item of items) {
    if (!item || typeof item.path !== 'string' || !item.path.trim()) {
      return { ok: false, exported: 0, error: 'Ruta de ítem inválida.' }
    }
    try {
      const abs = resolveSafe(localRoot, item.path)
      const st = statSync(abs)
      if (!st.isFile() && !st.isDirectory()) {
        return { ok: false, exported: 0, error: 'La ruta no es un archivo ni una carpeta.' }
      }
      sources.push(abs)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ok: false,
        exported: 0,
        error: msg.includes('traversal') ? 'Ruta no permitida (path traversal bloqueado).' : msg
      }
    }
  }

  const copied = await copyPathsToDirectory(sources, req.destDir, onProgress)
  if (!copied.ok) {
    return { ok: false, exported: copied.copied, destPaths: copied.destPaths, error: copied.error }
  }
  return { ok: true, exported: copied.copied, destPaths: copied.destPaths }
}

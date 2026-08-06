/**
 * Export share items (local or remote) to a user-chosen absolute folder.
 * Reuses prepareDrag materialization + async copyTree.
 */
import type { ExportItemsRequest, ExportItemsResult } from '../shared/types'
import { handlePrepareDrag } from './drag'
import { copyPathsToDirectory } from './importFiles'

export async function exportItemsToFolder(
  localRoot: string | null,
  req: ExportItemsRequest
): Promise<ExportItemsResult> {
  const items = Array.isArray(req.items) ? req.items : []
  if (items.length === 0) {
    return { ok: false, exported: 0, error: 'No hay ítems para exportar.' }
  }

  const sources: string[] = []
  for (const item of items) {
    if (!item || typeof item.path !== 'string' || !item.path.trim()) {
      return { ok: false, exported: 0, error: 'Ruta de ítem inválida.' }
    }
    const prepared =
      item.kind === 'local'
        ? await handlePrepareDrag(
            { kind: 'local', path: item.path, isDir: item.isDir },
            localRoot
          )
        : await handlePrepareDrag(
            {
              kind: 'remote',
              baseUrl: item.baseUrl || '',
              path: item.path,
              token: item.token,
              isDir: item.isDir
            },
            localRoot
          )
    if (!prepared.ok || !prepared.filePath) {
      return {
        ok: false,
        exported: 0,
        error: prepared.error || 'No se pudo preparar el ítem para exportar.'
      }
    }
    sources.push(prepared.filePath)
  }

  const copied = await copyPathsToDirectory(sources, req.destDir)
  if (!copied.ok) {
    return { ok: false, exported: copied.copied, destPaths: copied.destPaths, error: copied.error }
  }
  return { ok: true, exported: copied.copied, destPaths: copied.destPaths }
}

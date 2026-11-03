import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { GroupMeta } from '../shared/types'

/** One membership persisted on this device. Keys are stored, passwords never are. */
export interface GroupRecord {
  id: string
  meta: GroupMeta
  /** Group key (hex) derived from the password. */
  key: string
  /** When this key was set. A member announcing a newer one changed the password. */
  keySince: number
  folder: string | null
}

/** True when meta `a` should replace `b` (last writer wins, ties broken by device id). */
export function isNewerMeta(a: GroupMeta, b: GroupMeta): boolean {
  if (a.rev !== b.rev) return a.rev > b.rev
  if (a.at !== b.at) return a.at > b.at
  return a.by > b.by
}

function isRecord(r: unknown): r is GroupRecord {
  const g = r as GroupRecord
  return (
    !!g &&
    typeof g.id === 'string' &&
    typeof g.key === 'string' &&
    typeof g.keySince === 'number' &&
    !!g.meta &&
    typeof g.meta.name === 'string'
  )
}

export class GroupStore {
  private groups = new Map<string, GroupRecord>()

  constructor(private readonly file: string) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { groups?: unknown[] }
      for (const g of raw.groups ?? []) if (isRecord(g)) this.groups.set(g.id, g)
    } catch (err) {
      console.error('[groups] load failed', err instanceof Error ? err.message : err)
    }
  }

  save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ groups: [...this.groups.values()] }, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('[groups] save failed', err instanceof Error ? err.message : err)
    }
  }

  list(): GroupRecord[] {
    return [...this.groups.values()]
  }

  get(id: string): GroupRecord | undefined {
    return this.groups.get(id)
  }

  put(record: GroupRecord): void {
    this.groups.set(record.id, record)
    this.save()
  }

  remove(id: string): void {
    if (this.groups.delete(id)) this.save()
  }
}

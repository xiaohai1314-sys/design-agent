import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'

export interface FileSnapshotEntry {
  id: string
  filePath: string
  snapshotPath: string
  beforeRefPath?: string
  createdAt: number
  size: number
  sha256: string
  sourceTool: string
  summary?: string
  kind: 'text' | 'image' | 'binary'
}

const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024
const MAX_SNAPSHOTS_PER_FILE = 12
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'])
const TEXT_EXTS = new Set([
  '.md',
  '.txt',
  '.json',
  '.py',
  '.rb',
  '.ms',
  '.js',
  '.ts',
  '.tsx',
  '.css',
  '.html',
  '.htm',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.xml'
])

function inferKind(filePath: string): 'text' | 'image' | 'binary' {
  const ext = extname(filePath).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}

function normPath(p: string): string {
  return resolve(p).replace(/\\/g, '/')
}

function pathKeyHash(targetPath: string): string {
  return createHash('sha1').update(normPath(targetPath).toLowerCase()).digest('hex').slice(0, 16)
}

function fileSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function findSnapshotsBaseDir(targetPath: string, explicitRootDir?: string): string {
  if (explicitRootDir?.trim()) {
    return join(explicitRootDir.trim(), '.zmo', 'snapshots')
  }
  let cur = dirname(resolve(targetPath))
  for (let i = 0; i < 6; i++) {
    const candidateZmo = join(cur, '.zmo')
    if (existsSync(candidateZmo)) {
      return join(candidateZmo, 'snapshots')
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return join(dirname(resolve(targetPath)), '.zmo', 'snapshots')
}

function metaFilePath(baseDir: string, targetPath: string): string {
  return join(baseDir, pathKeyHash(targetPath), 'history.json')
}

function readMeta(metaPath: string): FileSnapshotEntry[] {
  if (!existsSync(metaPath)) return []
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf8'))
    return Array.isArray(raw) ? (raw as FileSnapshotEntry[]) : []
  } catch {
    return []
  }
}

function writeMeta(metaPath: string, entries: FileSnapshotEntry[]): void {
  mkdirSync(dirname(metaPath), { recursive: true })
  writeFileSync(metaPath, JSON.stringify(entries, null, 2), 'utf8')
}

function pruneOldEntries(entries: FileSnapshotEntry[]): FileSnapshotEntry[] {
  if (entries.length <= MAX_SNAPSHOTS_PER_FILE) return entries
  const kept = entries.slice(0, MAX_SNAPSHOTS_PER_FILE)
  for (const dropped of entries.slice(MAX_SNAPSHOTS_PER_FILE)) {
    try {
      if (dropped.snapshotPath && existsSync(dropped.snapshotPath)) {
        rmSync(dropped.snapshotPath, { force: true })
      }
    } catch {
      // ignore prune error
    }
  }
  return kept
}

/** 在修改/覆写现有文件之前保存 Before 版本快照 */
export function capturePreEditSnapshot(params: {
  targetPath: string
  rootDir?: string
  sourceTool: string
  summary?: string
}): FileSnapshotEntry | null {
  try {
    const absTarget = resolve(params.targetPath)
    if (!existsSync(absTarget)) return null
    const st = statSync(absTarget)
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return null

    const baseDir = findSnapshotsBaseDir(absTarget, params.rootDir)
    const metaPath = metaFilePath(baseDir, absTarget)
    const existing = readMeta(metaPath)
    const sha = fileSha256(absTarget)

    // 紧邻的上一条如果是普通内容快照且哈希完全一致，则跳过重复落盘
    if (existing.length > 0 && !existing[0].beforeRefPath && existing[0].sha256 === sha) {
      return existing[0]
    }

    const bucketDir = dirname(metaPath)
    mkdirSync(bucketDir, { recursive: true })
    const ext = extname(absTarget) || '.bak'
    const id = `snap_${Date.now()}_${randomUUID().slice(0, 6)}`
    const snapshotPath = join(bucketDir, `${id}${ext}`)
    copyFileSync(absTarget, snapshotPath)

    const entry: FileSnapshotEntry = {
      id,
      filePath: normPath(absTarget),
      snapshotPath: normPath(snapshotPath),
      createdAt: Date.now(),
      size: st.size,
      sha256: sha,
      sourceTool: params.sourceTool,
      summary: params.summary,
      kind: inferKind(absTarget)
    }

    const updated = pruneOldEntries([entry, ...existing])
    writeMeta(metaPath, updated)
    return entry
  } catch {
    return null
  }
}

/** 为图生图产出文件记录原图（Before）溯源快照，支持滑块对比及回滚到原图 */
export function recordImageLineageSnapshot(params: {
  afterPath: string
  beforeRefPath: string
  rootDir?: string
  sourceTool: string
  summary?: string
}): FileSnapshotEntry | null {
  try {
    const absAfter = resolve(params.afterPath)
    const absBefore = resolve(params.beforeRefPath)
    if (!existsSync(absBefore)) return null
    const st = statSync(absBefore)
    if (!st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return null

    const baseDir = findSnapshotsBaseDir(absAfter, params.rootDir)
    const metaPath = metaFilePath(baseDir, absAfter)
    const existing = readMeta(metaPath)

    const bucketDir = dirname(metaPath)
    mkdirSync(bucketDir, { recursive: true })
    const ext = extname(absBefore) || '.png'
    const id = `ref_${Date.now()}_${randomUUID().slice(0, 6)}`
    const snapshotPath = join(bucketDir, `${id}${ext}`)
    copyFileSync(absBefore, snapshotPath)

    const entry: FileSnapshotEntry = {
      id,
      filePath: normPath(absAfter),
      snapshotPath: normPath(snapshotPath),
      beforeRefPath: normPath(absBefore),
      createdAt: Date.now(),
      size: st.size,
      sha256: fileSha256(absBefore),
      sourceTool: params.sourceTool,
      summary: params.summary,
      kind: 'image'
    }

    const updated = pruneOldEntries([entry, ...existing])
    writeMeta(metaPath, updated)
    return entry
  } catch {
    return null
  }
}

export function listFileSnapshots(params: {
  filePath: string
  rootDir?: string
}): FileSnapshotEntry[] {
  try {
    const absTarget = resolve(params.filePath)
    const candidateBases = [findSnapshotsBaseDir(absTarget, params.rootDir)]
    const autoBase = findSnapshotsBaseDir(absTarget)
    if (!candidateBases.includes(autoBase)) candidateBases.push(autoBase)

    const seen = new Set<string>()
    const out: FileSnapshotEntry[] = []
    for (const base of candidateBases) {
      const entries = readMeta(metaFilePath(base, absTarget))
      for (const e of entries) {
        if (!e.id || seen.has(e.id)) continue
        if (existsSync(e.snapshotPath)) {
          seen.add(e.id)
          out.push(e)
        }
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export function restoreFileSnapshot(params: {
  filePath: string
  snapshotId: string
  rootDir?: string
}): { ok: boolean; error?: string; restoredFrom?: FileSnapshotEntry } {
  try {
    const absTarget = resolve(params.filePath)
    const entries = listFileSnapshots({ filePath: absTarget, rootDir: params.rootDir })
    const hit = entries.find((e) => e.id === params.snapshotId)
    if (!hit || !existsSync(hit.snapshotPath)) {
      return { ok: false, error: '未找到指定版本快照或快照文件已被清理' }
    }

    // 回滚前先把当前磁盘内容备份成一条 pre_rollback 快照，确保回滚本身也可逆
    if (existsSync(absTarget)) {
      capturePreEditSnapshot({
        targetPath: absTarget,
        rootDir: params.rootDir,
        sourceTool: 'pre_rollback',
        summary: '回滚前自动备份'
      })
    }

    mkdirSync(dirname(absTarget), { recursive: true })
    copyFileSync(hit.snapshotPath, absTarget)
    return { ok: true, restoredFrom: hit }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

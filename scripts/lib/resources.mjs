// 资源包的逐文件清单：打包时生成，解包时校验，装好后自检。
// 只有整个 tarball 的 sha256 时，解压中断、文件被替换、只拷贝了一半都查不出来。
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const MANIFEST_NAME = '.resources-manifest.json'
export const MANIFEST_PATH = `resources/${MANIFEST_NAME}`

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('data', (c) => h.update(c))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

export function walkFiles(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walkFiles(full, out)
    else if (e.isFile()) out.push(full)
  }
  return out
}

export const toPosix = (p) => p.split(sep).join('/')

export async function buildManifest(root, entries, extra = {}) {
  const files = {}
  let bytes = 0
  for (const entry of entries) {
    for (const full of walkFiles(join(root, entry))) {
      const rel = toPosix(relative(root, full))
      const size = statSync(full).size
      files[rel] = { size, sha256: await hashFile(full) }
      bytes += size
    }
  }
  return {
    version: 1,
    ...extra,
    entries,
    fileCount: Object.keys(files).length,
    bytes,
    files
  }
}

/**
 * 按清单核对 root 下的文件。root 应是清单路径的基准目录
 * （解包校验时传暂存目录，装好后自检时传仓库根目录）。
 */
export async function verifyManifest(root, manifest, onProgress) {
  const files = manifest?.files ?? {}
  const missing = []
  const mismatched = []
  let done = 0
  for (const [rel, meta] of Object.entries(files)) {
    const full = join(root, rel)
    let size
    try {
      size = statSync(full).size
    } catch {
      missing.push(rel)
      continue
    }
    if (size !== meta.size) mismatched.push({ rel, reason: `大小不符（期望 ${meta.size}，实际 ${size}）` })
    else if ((await hashFile(full)) !== meta.sha256) mismatched.push({ rel, reason: 'sha256 不符' })
    done += 1
    if (onProgress && done % 500 === 0) onProgress(done, Object.keys(files).length)
  }
  return { missing, mismatched, ok: missing.length === 0 && mismatched.length === 0 }
}

/** 清单里有、实际目录里多出来的文件（不算失败，只用于提示）。 */
export function findUnlisted(root, manifest) {
  const listed = new Set(Object.keys(manifest?.files ?? {}))
  const extra = []
  for (const entry of manifest?.entries ?? []) {
    for (const full of walkFiles(join(root, entry))) {
      const rel = toPosix(relative(root, full))
      if (!listed.has(rel)) extra.push(rel)
    }
  }
  return extra
}

/**
 * 把暂存目录里的文件写入 root，覆盖前先挪进 backupDir。
 * 中途出错就按相反顺序还原，调用方据此判断 resources/ 是否还是原样。
 */
export function applyStaged(root, staging, files, backupDir) {
  // 包是外部来的：路径逃出 root 的一律拒绝，不能靠 join 把 ".." 当成普通目录名
  const unsafe = files.find((rel) => /^[/\\]/.test(rel) || /^[a-zA-Z]:/.test(rel) || rel.split(/[/\\]/).includes('..'))
  if (unsafe) {
    return { ok: false, applied: [], restored: true, error: new Error(`清单里有非法路径：${unsafe}`) }
  }
  const applied = []
  try {
    for (const rel of files) {
      const src = join(staging, rel)
      const dest = join(root, rel)
      mkdirSync(dirname(dest), { recursive: true })
      let backedUp = false
      if (existsSync(dest)) {
        const bak = join(backupDir, rel)
        mkdirSync(dirname(bak), { recursive: true })
        renameSync(dest, bak)
        backedUp = true
      }
      try {
        renameSync(src, dest)
      } catch {
        // 跨卷或文件被占用时退回复制
        copyFileSync(src, dest)
      }
      applied.push({ rel, backedUp })
    }
    return { ok: true, applied }
  } catch (error) {
    let restored = true
    for (const { rel, backedUp } of applied.reverse()) {
      const dest = join(root, rel)
      try {
        rmSync(dest, { force: true })
        if (backedUp) {
          mkdirSync(dirname(dest), { recursive: true })
          renameSync(join(backupDir, rel), dest)
        }
      } catch {
        restored = false
      }
    }
    return { ok: false, applied, restored, error }
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

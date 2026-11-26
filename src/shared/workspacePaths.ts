import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

function isWithin(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function resolveThroughExistingAncestor(targetPath: string): string {
  let current = resolve(targetPath)
  const missingParts: string[] = []

  while (true) {
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() && !existsSync(current)) {
        throw new Error(`拒绝经过失效符号链接访问路径：${current}`)
      }
      const real = realpathSync.native(current)
      return resolve(real, ...missingParts.reverse())
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('拒绝经过失效符号链接')) {
        throw error
      }
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missingParts.push(basename(current))
      current = parent
    }
  }
}

/** Resolve a user-supplied path and reject lexical traversal or symlink escape from rootDir. */
export function resolvePathWithinRoot(rootDir: string, inputPath?: string): string {
  if (!rootDir?.trim()) throw new Error('缺少工作区根目录')
  const root = resolve(rootDir)
  const candidate = !inputPath || !inputPath.trim()
    ? root
    : isAbsolute(inputPath.trim())
      ? resolve(inputPath.trim())
      : resolve(root, inputPath.trim())

  if (!isWithin(root, candidate)) {
    throw new Error(`路径超出当前工作区范围：${candidate}`)
  }

  const realRoot = resolveThroughExistingAncestor(root)
  const realCandidate = resolveThroughExistingAncestor(candidate)
  if (!isWithin(realRoot, realCandidate)) {
    throw new Error(`路径通过符号链接超出当前工作区范围：${candidate}`)
  }
  return candidate
}

/** Compare canonical paths when possible; useful for exact-file read grants. */
export function samePath(left: string, right: string): boolean {
  try {
    const a = existsSync(left) ? realpathSync.native(left) : resolve(left)
    const b = existsSync(right) ? realpathSync.native(right) : resolve(right)
    const normalizedA = resolve(a)
    const normalizedB = resolve(b)
    return process.platform === 'win32'
      ? normalizedA.toLowerCase() === normalizedB.toLowerCase()
      : normalizedA === normalizedB
  } catch {
    return false
  }
}

/** Whether a path is inside rootDir after both lexical and symlink-aware validation. */
export function isPathWithinRoot(rootDir: string, targetPath: string): boolean {
  try {
    resolvePathWithinRoot(rootDir, targetPath)
    return true
  } catch {
    return false
  }
}

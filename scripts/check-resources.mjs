#!/usr/bin/env node
// 检查 resources/ 下未纳入 Git 的运行资源是否齐全，并说明缺失时受影响的功能。
// 用法：npm run check:resources    （有必需资源缺失时退出码为 1）
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const res = (...p) => join(root, 'resources', ...p)

const nonEmptyDir = (p) => {
  try {
    return statSync(p).isDirectory() && readdirSync(p).length > 0
  } catch {
    return false
  }
}

const checks = [
  { label: '内置 Python', path: res('runtime', 'python', 'python.exe'), impact: '技能脚本与 Python 类连接器回退到系统 python' },
  { label: '内置 Node', path: res('runtime', 'node', 'node.exe'), impact: 'Photoshop 连接器回退到 Electron 自带的 Node' },
  { label: '规范索引器', path: res('runtime', 'reg-indexer.exe'), impact: '规范检索回退到逐文件扫描（较慢）' },
  { label: '原生分词库', path: res('runtime', 'zmo_native.dll'), impact: '规范索引器无法运行' },
  { label: 'DWG 转换（LibreDWG）', path: res('skills', 'cad', 'vendor', 'win64'), dir: true, impact: '无法解析 .dwg 图纸（.dxf 不受影响）' },
  { label: 'SketchUp 连接器依赖', path: res('mcp', 'sketchup', 'lib'), dir: true, impact: 'SketchUp 连接器不可用' },
  { label: 'Blender 连接器依赖', path: res('mcp', 'blender', 'lib'), dir: true, impact: 'Blender 连接器不可用' },
  { label: '3ds Max 连接器依赖', path: res('mcp', '3dsmax', 'lib'), dir: true, impact: '3ds Max 连接器不可用' },
  { label: 'multicad 连接器', path: res('mcp', 'multicad', 'lib', 'server.py'), impact: 'CAD 编辑连接器不可用' },
  { label: 'Photoshop 连接器依赖', path: res('mcp', 'photoshop', 'node_modules'), dir: true, impact: 'Photoshop 连接器不可用（可在该目录执行 npm install）' },
  { label: 'computer-use 驱动', path: res('mcp', 'computer-use', 'cua-driver.exe'), impact: 'computer-use 连接器不可用' }
]

let missing = 0
console.log('运行资源检查（resources/）\n')
for (const c of checks) {
  const ok = c.dir ? nonEmptyDir(c.path) : existsSync(c.path)
  if (!ok) missing++
  const rel = c.path.slice(root.length + 1).replace(/\\/g, '/')
  console.log(`${ok ? '✅' : '❌'} ${c.label.padEnd(16, '　')} ${rel}${ok ? '' : `\n     缺失影响：${c.impact}`}`)
}
console.log(missing === 0 ? '\n全部就绪。' : `\n共 ${missing} 项缺失，详见 README 的“运行资源”一节。`)
process.exitCode = missing === 0 ? 0 : 1

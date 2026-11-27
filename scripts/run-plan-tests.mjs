#!/usr/bin/env node
// 跑 scripts/test_plan_scripts.py：优先用内置 Python，没有就退回系统 python。
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundled = join(root, 'resources', 'runtime', 'python', 'python.exe')
const python = existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python' : 'python3'

const res = spawnSync(python, [join(root, 'scripts', 'test_plan_scripts.py')], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
})

if (res.error) {
  console.error('无法启动 Python：', res.error.message)
  process.exit(1)
}
process.exit(res.status ?? 1)

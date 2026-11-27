#!/usr/bin/env node
// 资源包清单与写入回滚的测试。
// 用法：npm run test:resources
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { downloadResumable } from './lib/download.mjs'
import { applyStaged, buildManifest, verifyManifest } from './lib/resources.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'da-res-'))

function writeIn(root, rel, body) {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

const cases = []
const test = (name, fn) => cases.push({ name, fn })

test('清单能发现缺失和内容改动', async () => {
  const root = join(scratch, 't1')
  writeIn(root, 'resources/a/1.txt', 'one')
  writeIn(root, 'resources/a/2.txt', 'two')
  const manifest = await buildManifest(root, ['resources/a'])
  assert.equal(manifest.fileCount, 2)
  assert.ok((await verifyManifest(root, manifest)).ok)

  writeFileSync(join(root, 'resources/a/1.txt'), 'ONE')
  const changed = await verifyManifest(root, manifest)
  assert.equal(changed.mismatched.length, 1)
  assert.match(changed.mismatched[0].reason, /sha256/)

  rmSync(join(root, 'resources/a/2.txt'))
  const removed = await verifyManifest(root, manifest)
  assert.deepEqual(removed.missing, ['resources/a/2.txt'])
})

test('大小变了不必算哈希就能判出来', async () => {
  const root = join(scratch, 't2')
  writeIn(root, 'resources/a.txt', 'abc')
  const manifest = await buildManifest(root, ['resources'])
  writeFileSync(join(root, 'resources/a.txt'), 'abcd')
  const check = await verifyManifest(root, manifest)
  assert.equal(check.mismatched.length, 1)
  assert.match(check.mismatched[0].reason, /大小不符/)
})

test('写入后内容与暂存一致，覆盖的记了备份', () => {
  const root = join(scratch, 't3/root')
  const staging = join(scratch, 't3/staging')
  writeIn(root, 'resources/x.txt', 'old')
  writeIn(staging, 'resources/x.txt', 'new')
  writeIn(staging, 'resources/y.txt', 'added')

  const r = applyStaged(root, staging, ['resources/x.txt', 'resources/y.txt'], join(scratch, 't3/backup'))
  assert.ok(r.ok)
  assert.equal(readFileSync(join(root, 'resources/x.txt'), 'utf8'), 'new')
  assert.equal(readFileSync(join(root, 'resources/y.txt'), 'utf8'), 'added')
  assert.equal(r.applied.filter((a) => a.backedUp).length, 1)
})

test('写入中途失败会回滚到原样', () => {
  const root = join(scratch, 't4/root')
  const staging = join(scratch, 't4/staging')
  writeIn(root, 'resources/x.txt', 'old-x')
  writeIn(root, 'resources/y.txt', 'old-y')
  writeIn(staging, 'resources/x.txt', 'new-x')
  writeIn(staging, 'resources/y.txt', 'new-y')

  // 第三个文件的目标路径要穿过一个普通文件，创建目录必然失败
  const r = applyStaged(
    root,
    staging,
    ['resources/x.txt', 'resources/y.txt', 'resources/x.txt/deep.txt'],
    join(scratch, 't4/backup')
  )
  assert.equal(r.ok, false)
  assert.equal(r.restored, true)
  assert.equal(readFileSync(join(root, 'resources/x.txt'), 'utf8'), 'old-x')
  assert.equal(readFileSync(join(root, 'resources/y.txt'), 'utf8'), 'old-y')
})

test('清单里的越界路径会被拒绝', () => {
  const root = join(scratch, 't5/root')
  writeIn(root, 'resources/x.txt', 'old')
  const r = applyStaged(root, join(scratch, 't5/staging'), ['../escape.txt'], join(scratch, 't5/backup'))
  assert.equal(r.ok, false)
  assert.match(r.error.message, /非法路径/)
})

test('下载中断后从断点续传，最终内容完整', async () => {
  const payload = Buffer.alloc(300 * 1024)
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251

  let firstHit = true
  const server = createServer((req, res) => {
    const range = req.headers.range
    const start = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0
    if (firstHit && !range) {
      // 第一次只发三分之一就断线
      firstHit = false
      res.writeHead(200, { 'content-length': payload.length })
      res.write(payload.subarray(0, 100 * 1024))
      setTimeout(() => res.destroy(), 20)
      return
    }
    res.writeHead(range ? 206 : 200, {
      'content-length': payload.length - start,
      ...(range ? { 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {})
    })
    res.end(payload.subarray(start))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const dest = join(scratch, 'dl', 'bundle.bin')
  mkdirSync(dirname(dest), { recursive: true })

  try {
    await downloadResumable(`http://127.0.0.1:${port}/bundle.bin`, dest, {
      attempts: 3,
      retryBaseMs: 30,
      stallMs: 5000
    })
  } finally {
    server.close()
  }

  assert.equal(firstHit, false, '应当触发过一次断线')
  assert.ok(readFileSync(dest).equals(payload), '续传后内容应与源文件一致')
})

let failed = 0
for (const { name, fn } of cases) {
  try {
    await fn()
    console.log(`✅ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`❌ ${name}\n   ${error.message}`)
  }
}

rmSync(scratch, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exitCode = failed ? 1 : 0

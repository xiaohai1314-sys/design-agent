// 大文件下载：断点续传、自动重试、卡死检测。
// 322 MB 的包在普通宽带上跑十分钟，中途断一次就得从头来，这里按已有字节数续传。
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { once } from 'node:events'

const DEFAULT_STALL_MS = 60_000
const DEFAULT_ATTEMPTS = 5

/**
 * 下到 dest。已存在的部分会被当成断点，用 Range 续传；
 * 服务端不支持 Range（返回 200）时从头写，不会拼出错位的文件。
 */
export async function downloadResumable(
  url,
  dest,
  { headers = {}, attempts = DEFAULT_ATTEMPTS, stallMs = DEFAULT_STALL_MS, retryBaseMs = 2000, onProgress, onRetry } = {}
) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadOnce(url, dest, headers, { stallMs, onProgress })
      return
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      const wait = Math.min(retryBaseMs * attempt, 10000)
      const have = existsSync(dest) ? statSync(dest).size : 0
      onRetry?.(attempt, error, have, wait)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw lastError ?? new Error('下载失败')
}

async function downloadOnce(url, dest, headers, { stallMs, onProgress }) {
  const offset = existsSync(dest) ? statSync(dest).size : 0
  const reqHeaders = { ...headers }
  if (offset > 0) reqHeaders.Range = `bytes=${offset}-`

  const ctrl = new AbortController()
  let stall = null
  const armStall = () => {
    if (stall) clearTimeout(stall)
    stall = setTimeout(
      () => ctrl.abort(new Error(`连续 ${Math.round(stallMs / 1000)} 秒没有收到数据`)),
      stallMs
    )
  }
  armStall()

  let file = null
  try {
    const res = await fetch(url, { redirect: 'follow', headers: reqHeaders, signal: ctrl.signal })
    // 416：本地已有的字节数已经超过服务端文件，当作下完
    if (res.status === 416) return
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`)

    // 只有真的返回 206 才追加，否则必须从头写
    const appending = offset > 0 && res.status === 206
    const start = appending ? offset : 0
    const length = Number(res.headers.get('content-length') ?? 0)
    const total = length > 0 ? start + length : 0

    file = createWriteStream(dest, { flags: appending ? 'a' : 'w' })
    let received = start
    for await (const chunk of res.body) {
      armStall()
      if (!file.write(chunk)) await once(file, 'drain')
      received += chunk.length
      onProgress?.(received, total)
    }
    await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())))
    file = null
    if (total > 0 && received < total) {
      throw new Error(`只收到 ${received} / ${total} 字节`)
    }
  } catch (error) {
    if (file) await new Promise((resolve) => file.close(() => resolve()))
    throw error
  } finally {
    if (stall) clearTimeout(stall)
  }
}

import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const maxWaitMs = 300_000
const validId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const requestPath = (dir, id) => path.join(dir, 'requests', id + '.json')
const answerPath = (dir, id) => path.join(dir, 'answers', id + '.txt')
const simpleDelimiter = 'NO explanations. NO notes. Input:\n\n'

async function readIfPresent(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

async function publish(file, content) {
  const pending = file + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(pending, content, { encoding: 'utf8', flag: 'wx' })
    await rename(pending, file)
  } finally {
    await rm(pending, { force: true })
  }
}

function afterMarker(text, marker) {
  const start = text.indexOf(marker)
  if (start >= 0) return text.slice(start + marker.length)
}

function modelRequest(messages) {
  const content = messages.map(({ role, content }) => ({
    role, text: content.map(part => part.text).join(''),
  }))
  if (content.length === 1 && content[0].role === 'user') {
    const { text } = content[0]
    const layoutPrompt = /^You are a professional [^\n]+\n\nFollow all rules strictly\.\n\n## (Structure Rules|Rules)\n/.exec(text)
    if (layoutPrompt?.[1] === 'Structure Rules') {
      try {
        const rows = JSON.parse(afterMarker(text, '## Here is the input:\n'))
        if (Array.isArray(rows) && rows.length && rows.every(row =>
          row && (typeof row.id === 'number' || typeof row.id === 'string') && typeof row.input === 'string')) {
          return { format: 'paragraphs', paragraphs: rows.map(({ id, input }) => ({ id, input })) }
        }
      } catch {
        // A different engine prompt can still be translated using its full messages.
      }
    }
    const source = layoutPrompt?.[1] === 'Rules'
      ? afterMarker(text, 'Now translate the following text:\n\n')
      : text.startsWith('You are a professional,authentic machine translation engine.') ? afterMarker(text, simpleDelimiter) : undefined
    if (source !== undefined) return { format: 'plain', text: source }
  }
  return { format: 'engine', messages: content }
}

export async function openChat(batch, { scratch = os.tmpdir(), target }) {
  const directory = await mkdtemp(path.join(path.resolve(scratch), 'pdf-chat-'))
  const requests = path.join(directory, 'requests')
  const answers = path.join(directory, 'answers')
  await mkdir(requests)
  await mkdir(answers)
  await writeFile(path.join(directory, 'job.json'), '{"kind":"pdf-chat-v1"}')
  const stopFile = path.join(directory, 'stop')
  const watch = setInterval(() => {
    if (existsSync(stopFile)) batch.abort(new Error('已取消翻译。'))
  }, 300)
  watch.unref()
  let sequence = 0

  return {
    directory,
    route: {
      model: 'current-chat',
      requestTimeoutMs: maxWaitMs,
      workers: 6,
      isProbe(messages) {
        const text = messages[0]?.content
        return messages.length === 1 && messages[0].role === 'user' &&
          text.startsWith('You are a professional,authentic machine translation engine.') &&
          afterMarker(text, simpleDelimiter) === 'Hello'
      },
      llm: {
        async *stream({ messages, signal }) {
          const id = randomUUID()
          const request = requestPath(directory, id)
          const answer = answerPath(directory, id)
          try {
            await publish(request, JSON.stringify({ id, sequence: ++sequence, target, ...modelRequest(messages) }))
            while (!signal.aborted) {
              const text = await readIfPresent(answer)
              if (text !== undefined) {
                yield { type: 'text-delta', text }
                return
              }
              await delay(250, undefined, { signal })
            }
            signal.throwIfAborted()
          } finally {
            await Promise.all([rm(request, { force: true }), rm(answer, { force: true })])
          }
        },
      },
    },
    async finish(summary) {
      clearInterval(watch)
      await publish(path.join(directory, 'done.json'), JSON.stringify(summary))
      await rm(path.join(directory, 'reply.json'), { force: true })
    },
  }
}

async function next(dir) {
  const until = Date.now() + 9000
  do {
    const done = await readIfPresent(path.join(dir, 'done.json'))
    if (done !== undefined) return { state: 'done', ...JSON.parse(done) }
    const pending = []
    for (const name of await readdir(path.join(dir, 'requests'))) {
      if (!name.endsWith('.json') || existsSync(answerPath(dir, name.slice(0, -5)))) continue
      const data = await readIfPresent(path.join(dir, 'requests', name))
      if (data) pending.push(JSON.parse(data))
    }
    if (pending.length) {
      pending.sort((a, b) => a.sequence - b.sequence)
      let chars = 0
      const requests = []
      for (const { sequence, ...request } of pending) {
        const size = JSON.stringify(request).length
        if (requests.length && chars + size > 6500) break
        requests.push(request)
        chars += size
      }
      return { state: 'translate', requests }
    }
    await delay(300)
  } while (Date.now() < until)
  return { state: 'waiting' }
}

async function submit(dir, file) {
  const rows = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
  const ids = new Set()
  if (!Array.isArray(rows) || !rows.length || rows.length > 6) throw new Error('译文应为 1 到 6 项的 JSON 数组。')
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !validId.test(row.id) || ids.has(row.id))
      throw new Error('每项译文需提供一个不同的请求 id。')
    ids.add(row.id)
  }
  const prepared = []
  const accepted = []
  const skipped = []
  for (const { id, text, paragraphs } of rows) {
    const pending = await readIfPresent(requestPath(dir, id))
    const answer = answerPath(dir, id)
    if (!pending || existsSync(answer)) {
      skipped.push(id)
      continue
    }
    const request = JSON.parse(pending)
    if (request.format === 'paragraphs') {
      if (!Array.isArray(paragraphs) || paragraphs.length !== request.paragraphs.length ||
          !paragraphs.every((row, index) => row && row.id === request.paragraphs[index].id &&
            typeof row.output === 'string' && row.output.trim())) {
        throw new Error('分段请求必须按原顺序提供每个段落的 id 和非空 output。请求 ' + id)
      }
      prepared.push({ id, answer, content: JSON.stringify(paragraphs.map(({ id, output }) => ({ id, output }))) })
    } else {
      if (typeof text !== 'string' || !text.trim()) throw new Error('译文 text 不能为空。请求 ' + id)
      prepared.push({ id, answer, content: text })
    }
  }
  for (const { id, answer, content } of prepared) {
    await publish(answer, content)
    accepted.push(id)
  }
  return { accepted, skipped }
}

async function command() {
  const [action, directory, file] = process.argv.slice(2)
  if (!directory || !['next', 'submit', 'stop'].includes(action) || (action === 'submit' && !file)) {
    throw new Error('用法：node chat.mjs next|stop JOB_DIR，或 node chat.mjs submit JOB_DIR REPLY_JSON。')
  }
  const dir = path.resolve(directory)
  const marker = await readIfPresent(path.join(dir, 'job.json'))
  if (marker !== '{"kind":"pdf-chat-v1"}') throw new Error('找不到当前聊天翻译任务。')
  if (action === 'next') return next(dir)
  if (action === 'submit') return submit(dir, path.resolve(file))
  await writeFile(path.join(dir, 'stop'), '')
  return { state: 'stopping' }
}

const invokedDirectly = import.meta.main ?? (process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
if (invokedDirectly) {
  command().then(
    result => console.log(JSON.stringify(result)),
    error => {
      console.log(JSON.stringify({ error: error.message }))
      process.exitCode = 1
    },
  )
}

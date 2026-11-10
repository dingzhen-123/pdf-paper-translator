import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkEngine, engineVersion, translatePdf } from './engine.mjs'
import { openChat } from './chat.mjs'

const languages = new Set(['zh-CN', 'en', 'ja', 'de', 'fr'])
const maxBytes = 60 * 1024 * 1024
const terminalProviderErrors = new Set([401, 402, 403, 404])

function emit(event, data = {}) {
  console.log(JSON.stringify({ event, ...data }))
}

function modelSettings(modelOverride) {
  const baseUrl = process.env.PDF_TRANSLATE_BASE_URL?.trim()
  const apiKey = process.env.PDF_TRANSLATE_API_KEY?.trim()
  const model = (modelOverride ?? process.env.PDF_TRANSLATE_MODEL)?.trim()
  if (!baseUrl || !apiKey || !model) {
    throw new Error('请配置 PDF_TRANSLATE_BASE_URL、PDF_TRANSLATE_API_KEY 和 PDF_TRANSLATE_MODEL。也可用 --model 指定模型。')
  }
  let url
  try { url = new URL(baseUrl) } catch {}
  const loopback = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('模型 API 地址必须是 HTTPS，或本机 HTTP 地址。请填写 API 根地址。')
  }
  const basePath = url.pathname.replace(/\/+$/, '')
  if (basePath.endsWith('/chat/completions')) {
    throw new Error('请填写模型 API 根地址，脚本会自动追加 /chat/completions。')
  }
  url.pathname = basePath + '/chat/completions'
  return { url, apiKey, model }
}

function createModelRoute({ url, apiKey, model }, onProblem) {
  return {
    provider: 'compatible-api',
    model,
    llm: {
      async *stream({ system, messages, signal }) {
        let response
        try {
          response = await fetch(url, {
            method: 'POST',
            redirect: 'error',
            headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
            body: JSON.stringify({
              model, stream: false,
              messages: [
                { role: 'system', content: system },
                ...messages.map(({ role, content }) => ({ role, content: content.map(part => part.text).join('') })),
              ],
            }),
            signal,
          })
        } catch {
          onProblem('连接模型 API 失败或请求超时。')
          throw new Error('模型 API 请求失败。')
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          onProblem('模型 API 返回 HTTP ' + response.status + '。', terminalProviderErrors.has(response.status))
          throw new Error('模型 API 请求失败。')
        }
        const data = await response.json()
        const tokens = data.usage
        if (tokens && Number.isFinite(tokens.total_tokens)) {
          const cacheHits = tokens.prompt_cache_hit_tokens ?? tokens.prompt_tokens_details?.cached_tokens ?? 0
          yield {
            type: 'usage',
            usage: {
              inputTokens: tokens.prompt_cache_miss_tokens ?? Math.max(0, (tokens.prompt_tokens ?? 0) - cacheHits),
              outputTokens: tokens.completion_tokens,
              cacheReadTokens: cacheHits,
              totalTokens: tokens.total_tokens,
            },
          }
        }
        const choice = data.choices?.[0]
        const text = choice?.message?.content
        if (typeof text !== 'string' || !text.trim() || (choice.finish_reason && choice.finish_reason !== 'stop')) {
          onProblem('模型没有返回完整译文。')
          yield { type: 'finish', reason: { kind: 'error' } }
          return
        }
        yield { type: 'text-delta', text }
      },
    },
  }
}

async function validatePdf(input) {
  const handle = await open(input, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) throw new Error('请选择单份不超过 60 MB 的 PDF 文件。')
    const header = Buffer.alloc(Math.min(info.size, 1024))
    await handle.read(header, 0, header.length, 0)
    if (!header.includes('%PDF-')) throw new Error('输入没有有效的 PDF 文件头。')
  } finally {
    await handle.close()
  }
}

async function saveOutput(file, outputFolder, input, { target, mode }) {
  const name = path.basename(input).replace(/\.pdf$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '')
  const base = Array.from(name).slice(0, 55).join('') || '文献'
  const stem = base + '-' + target + '-' + mode
  for (let version = 1; version <= 1000; version++) {
    const suffix = version === 1 ? '' : ' (' + version + ')'
    const destination = path.join(outputFolder, stem + suffix + '.pdf')
    try {
      await copyFile(file, destination, constants.COPYFILE_EXCL)
      return destination
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw new Error('输出目录下的同名译文过多，请另选目录。')
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: 'string', default: 'zh-CN' },
      mode: { type: 'string', default: 'mono' },
      pages: { type: 'string', default: '' },
      out: { type: 'string', default: 'translated-pdfs' },
      scratch: { type: 'string' },
      api: { type: 'boolean' },
      'check-engine': { type: 'boolean' },
      model: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log('node translate.mjs [--target zh-CN|en|ja|de|fr] [--mode mono|dual] [--pages 1-3,5] [--out DIRECTORY] [--scratch DIRECTORY] [--api [--model ID]] -- FILE.pdf [FILE.pdf ...]')
    console.log('node translate.mjs --check-engine')
    return
  }
  if (values['check-engine']) {
    const engine = await checkEngine()
    emit('engine', { ...engine, recommendedVersion: engineVersion })
    if (engine.state !== 'ready') process.exitCode = 1
    return
  }
  if (!positionals.length) throw new Error('请传入至少一份 PDF 文件。')
  const { target, mode } = values
  const pages = values.pages.replace(/\s+/g, '')
  if (!languages.has(target)) throw new Error('目标语言请选择 zh-CN、en、ja、de 或 fr。')
  if (!['mono', 'dual'].includes(mode)) throw new Error('输出形式请选择 mono 或 dual。')
  if (pages && (pages.length > 200 || !/^[1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*$/.test(pages) ||
      pages.split(',').some(range => {
        const [first, last = first] = range.split('-').map(Number)
        return first > last || last > 100_000
      }))) throw new Error('请用 1-3,5 这样的格式指定页码，或省略 --pages。')

  const settings = values.api || values.model !== undefined ? modelSettings(values.model) : null
  const engine = await checkEngine()
  if (engine.state !== 'ready') {
    emit('engine', { ...engine, recommendedVersion: engineVersion })
    throw new Error('PDF 排版引擎不可用。请按 references/setup.md 安装或设置 PDF_TRANSLATE_ENGINE。')
  }
  const out = path.resolve(values.out)
  await mkdir(out, { recursive: true })
  const batch = new AbortController()
  const chat = settings ? null : await openChat(batch, { scratch: values.scratch, target })
  if (chat) emit('chat', { directory: chat.directory })
  let interrupted
  function interrupt(signal) {
    interrupted = signal
    batch.abort(new Error('已取消翻译。'))
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  let completed = 0
  let failed = 0
  try {
    for (const file of positionals) {
      if (batch.signal.aborted) break
      const input = path.resolve(file)
      const options = { target, mode, pages }
      const timeout = AbortSignal.timeout(45 * 60_000)
      const signal = AbortSignal.any([batch.signal, timeout])
      let directory
      let apiIssue
      let usage
      let progress
      let stage
      emit('start', { input, model: settings?.model ?? 'current-chat' })
      try {
        await validatePdf(input)
        signal.throwIfAborted()
        directory = await mkdtemp(path.join(os.tmpdir(), 'pdf-translate-'))
        await copyFile(input, path.join(directory, 'paper.pdf'))
        const route = chat?.route ?? createModelRoute(settings, (message, terminal) => {
          apiIssue = message
          if (terminal) batch.abort(new Error(message))
        })
        const translated = await translatePdf(directory, options, route, signal, update => {
          usage = update.usage ?? usage
          const nextProgress = update.progress ?? progress
          const nextStage = update.stage ?? stage
          if (nextProgress !== progress || nextStage !== stage) {
            progress = nextProgress
            stage = nextStage
            emit('progress', { input, progress, stage, usage })
          }
        })
        signal.throwIfAborted()
        const output = await saveOutput(translated, out, input, options)
        completed++
        emit('output', { input, output, progress: 100, usage })
      } catch (error) {
        failed++
        const message = batch.signal.aborted ? batch.signal.reason.message
          : timeout.aborted ? '单篇文献翻译超时。'
            : apiIssue && error.message.includes('部分段落') ? apiIssue + error.message
              : error.code === 'ENOENT' ? '找不到输入文件或输出目录。' : error.message
        emit('error', { input, message, usage })
        if (error.code === 'ENGINE_UNAVAILABLE') break
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
      }
    }
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
  const summary = { completed, failed, remaining: positionals.length - completed - failed }
  await chat?.finish(summary)
  emit('summary', summary)
  if (interrupted) process.exitCode = interrupted === 'SIGINT' ? 130 : 143
  else if (failed || batch.signal.aborted) process.exitCode = 1
}

main().catch(error => {
  emit('error', { message: error.message })
  process.exitCode = 1
})

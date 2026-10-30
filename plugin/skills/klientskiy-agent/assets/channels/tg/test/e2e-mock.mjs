#!/usr/bin/env node
/**
 * Сквозная проверка server.mjs без настоящего Telegram. Поднимает на 127.0.0.1
 * поддельный Bot API, запускает канал как MCP-сервер (так же, как Claude Code)
 * и гоняет сценарии: незнакомец в личке при dmPolicy=open, метка источника,
 * reply с нарезкой длинного текста, голосовое с расшифровкой, pairing, группа,
 * offset после рестарта. Токен фиктивный, наружу запросов нет.
 *
 * Нужны зависимости плагина (bun install или npm i в папке tg/):
 *   node test/e2e-mock.mjs
 *   TG_E2E_RUNTIME=bun node test/e2e-mock.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const SERVER = join(PLUGIN, 'server.mjs')
const RUNTIME = process.env.TG_E2E_RUNTIME || process.execPath
const TOKEN = '123456:e2e-fake-token-not-real-0123456789'
const TMP = mkdtempSync(join(tmpdir(), 'tg-e2e-'))
const STATE = join(TMP, 'state')
mkdirSync(STATE, { recursive: true })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let passed = 0
const step = (name) => { passed++; console.log(`  ok  ${name}`) }

// ───────────────────────── поддельный Telegram ─────────────────────────

const ME = { id: 900, is_bot: true, first_name: 'ИИмпульс', username: 'iimpuls_ai_bot' }
const MARINA = { id: 555, is_bot: false, first_name: 'Марина', username: 'marina' }
const SOSED = { id: 222, is_bot: false, first_name: 'Сосед' }
const calls = []            // все запросы к API
let queue = []
let waiters = []
let midSeq = 1000

function push(list) {
  queue.push(...list)
  for (const w of waiters.splice(0)) w()
}
let updSeq = 0
const message = (over = {}) => ({
  update_id: ++updSeq,
  message: {
    message_id: ++midSeq, date: Math.floor(Date.now() / 1000),
    chat: { id: 555, type: 'private' }, from: MARINA, ...over,
  },
})

const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks)
  let body = null
  try { body = raw.length && /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw) : null } catch {}
  const json = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  const ok = (result) => json({ ok: true, result })

  // GET /file/bot<token>/<путь> — скачивание вложения
  if (url.pathname.startsWith(`/file/bot${TOKEN}/`)) {
    calls.push({ method: 'download', path: url.pathname })
    res.writeHead(200, { 'content-type': 'audio/ogg' })
    res.end(Buffer.from('OggS-поддельное-голосовое'))
    return
  }
  const m = url.pathname.match(new RegExp(`^/bot${TOKEN.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/(\\w+)$`))
  if (!m) { res.writeHead(404); res.end('{}'); return }
  const method = m[1]
  calls.push({ method, body })

  if (method === 'getMe') return ok(ME)
  if (method === 'getUpdates') {
    if (!queue.length) await new Promise(r => { waiters.push(r); setTimeout(r, 500) })
    const offset = Number(body?.offset ?? 0)
    if (offset) queue = queue.filter(u => u.update_id >= offset)
    return ok(queue.splice(0))
  }
  if (method === 'sendMessage') return ok({ message_id: ++midSeq, chat: { id: body.chat_id }, text: body.text })
  if (method === 'sendChatAction') return ok(true)
  if (method === 'editMessageText') return ok({ message_id: Number(body.message_id), text: body.text })
  if (method === 'getFile') return ok({ file_id: body.file_id, file_path: `voice/${body.file_id}.oga`, file_size: 2048 })
  if (method === 'sendPhoto' || method === 'sendDocument') return ok({ message_id: ++midSeq })
  return json({ ok: false, error_code: 400, description: `поддельный API не знает ${method}` })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${srv.address().port}`

// расшифровка: печатает текст в stdout, как настоящая команда
const FAKE_WHISPER = join(TMP, 'whisper.mjs')
writeFileSync(FAKE_WHISPER, 'console.log("хочу бота для языкового центра")\n')

writeFileSync(join(STATE, 'access.json'), JSON.stringify({ dmPolicy: 'open', allowFrom: [], groups: {} }, null, 2))
writeFileSync(join(STATE, '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`)
chmodSync(join(STATE, '.env'), 0o600)

const ENV = {
  ...process.env,
  TG_STATE_DIR: STATE,
  TG_API_BASE: BASE,
  TG_POLL_TIMEOUT: '1',
  TG_TEXT_CHUNK: '500',
  TG_TRANSCRIBE_CMD: `${process.execPath} ${FAKE_WHISPER}`,
  TG_TRANSCRIBE_NOTICE_AFTER_SEC: '3600',
}
delete ENV.TELEGRAM_BOT_TOKEN

const transport = new StdioClientTransport({ command: RUNTIME, args: [SERVER], env: ENV, cwd: PLUGIN, stderr: 'pipe' })
const client = new Client({ name: 'e2e', version: '0' }, { capabilities: {} })
const notes = []
client.fallbackNotificationHandler = async (n) => {
  if (n.method === 'notifications/claude/channel') notes.push(n.params)
}

let stderr = ''
async function until(fn, ms = 15000, what = 'условие') {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(`не дождался: ${what}\n--- stderr канала ---\n${stderr.split(TOKEN).join('<TOKEN!>')}`)
}
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => r.content?.map(c => c.text).join('\n') ?? ''
const sent = (chatId) => calls.filter(c => c.method === 'sendMessage' && String(c.body?.chat_id) === String(chatId))

try {
  await client.connect(transport)
  transport.stderr?.on('data', d => { stderr += d.toString() })

  const tools = (await client.listTools()).tools.map(t => t.name).sort()
  assert.deepEqual(tools, ['download_attachment', 'edit_message', 'reply'])
  step('MCP поднялся, инструменты: ' + tools.join(', '))

  await until(() => calls.some(c => c.method === 'getMe'), 10000, 'getMe')
  await until(() => { try { return readFileSync(join(STATE, 'bot.pid'), 'utf8').trim() } catch { return '' } }, 5000, 'bot.pid')
  step('канал представился боту и занял bot.pid')

  // ── незнакомец в личке при open ──
  push([message({ text: 'Здравствуйте! Сколько стоит бот для детского центра?' })])
  const n1 = await until(() => notes.find(n => n.content.includes('Сколько стоит')), 15000, 'входящее от незнакомца')
  assert.equal(n1.meta.chat_type, 'dialog')
  assert.equal(n1.meta.chat_id, '555')
  assert.equal(n1.meta.user, 'Марина')
  assert.equal(n1.meta.username, 'marina')
  assert.equal(calls.some(c => c.method === 'sendMessage' && /код/i.test(c.body?.text ?? '')), false)
  step('незнакомец при dmPolicy=open дошёл до агента, кода ему не отправляли')

  // ── ответ агента, длинный текст режется ──
  const long = 'Основная работа — не код, а база знаний. '.repeat(30)
  const r1 = await call('reply', { chat_id: '555', text: long })
  assert.match(textOf(r1), /отправлено/)
  const parts = sent(555)
  assert.ok(parts.length >= 2, `длинный ответ должен уйти частями, ушло ${parts.length}`)
  assert.ok(parts.every(p => p.body.text.length <= 500))
  step(`агент ответил, длинный текст ушёл ${parts.length} частями`)

  // ── метка источника ──
  push([message({ text: '/start storis_28_10' })])
  const n2 = await until(() => notes.find(n => n.meta.start_payload), 15000, 'метка источника')
  assert.equal(n2.meta.start_payload, 'storis_28_10')
  step('метка источника из ссылки доехала до агента')

  // ── голосовое с расшифровкой ──
  push([message({ voice: { file_id: 'voice-1', duration: 6, file_size: 2048 } })])
  const n3 = await until(() => notes.find(n => n.content.includes('расшифровка')), 20000, 'расшифровка голосового')
  assert.match(n3.content, /хочу бота для языкового центра/)
  assert.equal(n3.meta.transcribed, 'yes')
  assert.ok(calls.some(c => c.method === 'getFile'), 'должен был спросить getFile')
  assert.ok(calls.some(c => c.method === 'download'), 'должен был скачать файл')
  step('голосовое скачано и расшифровано')

  // ── фото: путь уходит агенту ──
  push([message({ photo: [{ file_id: 'ph-small', file_size: 100 }, { file_id: 'ph-big', file_size: 9000 }], caption: 'наш прайс' })])
  const n4 = await until(() => notes.find(n => n.meta.image_path), 15000, 'фото')
  assert.match(n4.meta.image_path, /inbox/)
  assert.ok(calls.some(c => c.method === 'getFile' && c.body.file_id === 'ph-big'), 'качаем самый большой размер')
  step('фото скачано, путь передан агенту')

  // ── правка сообщения ──
  const r2 = await call('edit_message', { chat_id: '555', message_id: String(midSeq), text: 'поправленный ответ' })
  assert.match(textOf(r2), /исправлено/)
  step('edit_message работает')

  // ── в незнакомую личку первыми не пишем ──
  const r3 = await call('reply', { chat_id: '424242', text: 'здравствуйте' })
  assert.equal(r3.isError, true)
  assert.match(textOf(r3), /не разрешён/)
  step('в чат, который не писал боту, агент написать не может')

  // ── группа: не в списке — молчим, в списке — отвечаем всем ──
  push([message({ chat: { id: -100777, type: 'supergroup' }, from: SOSED, text: 'а вы делаете сайты?' })])
  await sleep(1500)
  assert.equal(notes.some(n => n.content.includes('делаете сайты')), false)
  step('в группе, которой нет в access.json, бот молчит')

  writeFileSync(join(STATE, 'access.json'), JSON.stringify({
    dmPolicy: 'open', allowFrom: [], groups: { '-100777': { requireMention: false } },
  }, null, 2))
  await sleep(300)
  push([message({ chat: { id: -100777, type: 'supergroup' }, from: SOSED, text: 'а внедрение сколько стоит?' })])
  const n5 = await until(() => notes.find(n => n.content.includes('внедрение сколько')), 15000, 'сообщение из группы')
  assert.equal(n5.meta.chat_type, 'chat')
  step('в группе из access.json бот слышит любого участника')

  // ── offset сохранён: после рестарта старое не придёт заново ──
  const st = JSON.parse(readFileSync(join(STATE, 'updates.json'), 'utf8'))
  assert.ok(st.offset > 1, 'offset должен быть сохранён')
  step(`offset сохранён (${st.offset}) — после рестарта повторов не будет`)

  // ── pairing: политика для личного помощника ──
  writeFileSync(join(STATE, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [], groups: {} }, null, 2))
  await sleep(300)
  const before = notes.length
  push([message({ from: SOSED, chat: { id: 222, type: 'private' }, text: 'пустите меня' })])
  await until(() => sent(222).some(c => /код/i.test(c.body.text)), 15000, 'код pairing')
  assert.equal(notes.length, before, 'при pairing сообщение в сессию не попадает')
  step('при pairing незнакомец получает код, а не ответ — поэтому клиентскому боту нужен open')

  console.log(`\n${passed} ok`)
} catch (e) {
  console.error(`\nFAIL: ${e.message}`)
  process.exitCode = 1
} finally {
  try { await client.close() } catch {}
  srv.close()
  await sleep(300)
  rmSync(TMP, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)

#!/usr/bin/env node
/**
 * Сквозная проверка server.mjs без настоящего MAX. Поднимает на 127.0.0.1
 * поддельный Bot API, запускает канал как MCP-сервер (так же, как Claude Code)
 * и гоняет сценарии: входящие, голосовое с расшифровкой, pairing, reply
 * с нарезкой и файлами, download_attachment, edit_message, marker, один
 * потребитель на папку. Токен фиктивный, наружу запросов нет.
 *
 * Нужны зависимости плагина (bun install или npm i в папке max/):
 *   node test/e2e-mock.mjs                    — сервер под node
 *   MAX_E2E_RUNTIME=bun node test/e2e-mock.mjs — сервер под bun
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const SERVER = join(PLUGIN, 'server.mjs')
const RUNTIME = process.env.MAX_E2E_RUNTIME || process.execPath
const TOKEN = 'e2e-fake-token-not-real-0123456789'
const TMP = mkdtempSync(join(tmpdir(), 'max-e2e-'))
const STATE = join(TMP, 'state')
mkdirSync(STATE, { recursive: true })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let passed = 0
const step = (name) => { passed++; console.log(`  ok  ${name}`) }

// ───────────────────────── поддельный MAX ─────────────────────────

const BOT = { user_id: 900, name: 'Помощник', username: 'mama_helper_bot', is_bot: true }
const MAMA = { user_id: 111, name: 'Мама', username: 'mama', is_bot: false }
const STRANGER = { user_id: 222, name: 'Сосед', is_bot: false }
const reqs = []
let queue = []
let waiters = []
let markerSeq = 100
let sentSeq = 0
const notReadyOnce = new Set()
const messages = new Map()

function pushUpdates(list) {
  queue.push(...list)
  for (const w of waiters.splice(0)) w()
}
const msg = (user, chatId, mid, text, attachments) => ({
  update_type: 'message_created', timestamp: Date.now(),
  message: {
    sender: user, recipient: { chat_id: chatId, chat_type: 'dialog' }, timestamp: Date.now(),
    body: { mid, seq: 1, text, attachments: attachments ?? null },
  },
})

const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks)
  let body = null
  try { body = raw.length && /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw) : null } catch {}
  const r = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body, ctype: req.headers['content-type'], size: raw.length, rawText: raw.toString('latin1') }
  reqs.push(r)
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  const base = `http://127.0.0.1:${srv.address().port}`

  if (req.method === 'GET' && url.pathname === '/me') return json(200, BOT)
  if (req.method === 'GET' && url.pathname === '/updates') {
    if (!queue.length) await new Promise(r => { waiters.push(r); setTimeout(r, 800) })
    const ups = queue.splice(0)
    if (ups.length) markerSeq++
    for (const u of ups) if (u.message?.body?.mid) messages.set(u.message.body.mid, u.message)
    return json(200, { updates: ups, marker: markerSeq })
  }
  if (req.method === 'POST' && url.pathname === '/messages') {
    const tok = body?.attachments?.[0]?.payload?.token ?? JSON.stringify(body?.attachments?.[0]?.payload ?? '')
    if (body?.attachments?.length && !notReadyOnce.has(tok)) {
      notReadyOnce.add(tok)
      return json(400, { code: 'attachment.not.ready', message: 'Key: errors.process.attachment.file.not.processed' })
    }
    sentSeq++
    const m = {
      sender: BOT, recipient: { chat_id: Number(url.searchParams.get('chat_id') ?? 7777), chat_type: 'dialog' },
      timestamp: Date.now(), body: { mid: `mid.bot${sentSeq}`, seq: sentSeq, text: body?.text ?? null },
    }
    messages.set(m.body.mid, m)
    return json(200, { message: m })
  }
  if (req.method === 'PUT' && url.pathname === '/messages') return json(200, { success: true })
  if (req.method === 'POST' && /^\/chats\/[^/]+\/actions$/.test(url.pathname)) return json(200, { success: true })
  if (req.method === 'POST' && url.pathname === '/uploads') {
    const type = url.searchParams.get('type')
    return json(200, { url: `${base}/upload-target/${type}`, ...(type === 'audio' || type === 'video' ? { token: `up-${type}` } : {}) })
  }
  if (req.method === 'POST' && url.pathname.startsWith('/upload-target/')) {
    const type = url.pathname.split('/').pop()
    if (type === 'image') return json(200, { photos: { k1: { token: 'photo-token-1' } } })
    if (type === 'file') return json(200, { token: 'file-token-1' })
    res.writeHead(200, { 'content-type': 'text/xml' }); return res.end('<retval>1</retval>')
  }
  if (req.method === 'GET' && url.pathname === '/cdn/voice') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return res.end(Buffer.concat([Buffer.from('OggS\0\x02'), Buffer.alloc(2000, 7)]))
  }
  if (req.method === 'GET' && url.pathname === '/cdn/photo.jpg') {
    res.writeHead(200, { 'content-type': 'image/jpeg' })   // MAX врёт: на деле WebP
    return res.end(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 '), Buffer.alloc(500, 1)]))
  }
  if (req.method === 'GET' && url.pathname.startsWith('/messages/')) {
    const m = messages.get(decodeURIComponent(url.pathname.slice('/messages/'.length)))
    return m ? json(200, m) : json(404, { code: 'not.found', message: 'message not found' })
  }
  json(404, { code: 'not.found', message: `${req.method} ${url.pathname}` })
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${srv.address().port}`
const cdn = (p) => `${BASE}/cdn/${p}`

// ───────────────────────── запуск канала ─────────────────────────

writeFileSync(join(STATE, '.env'), '# тестовый .env: токен приходит из окружения\n')
writeFileSync(join(STATE, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: ['111'], groups: {}, pending: {}, note: 'ручная заметка' }, null, 2))

const ENV = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  MAX_STATE_DIR: STATE, MAX_BOT_TOKEN: TOKEN, MAX_API_BASE: BASE,
  MAX_TRANSCRIBE_CMD: `"${process.execPath}" -e "setTimeout(()=>console.log('Купи хлеба и позвони Кате'),300)"`,
  MAX_TRANSCRIBE_NOTICE_AFTER_SEC: '0',
  MAX_POLL_TIMEOUT: '1',
}
let stderr = ''
const transport = new StdioClientTransport({ command: RUNTIME, args: [SERVER], env: ENV, cwd: PLUGIN, stderr: 'pipe' })
transport.stderr?.on('data', d => { stderr += d.toString() })
const client = new Client({ name: 'e2e', version: '0' }, { capabilities: {} })
const notes = []
client.fallbackNotificationHandler = async (n) => { if (n.method === 'notifications/claude/channel') notes.push(n.params) }

async function until(fn, ms = 15000, what = 'условие') {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(`не дождался: ${what}\n--- stderr канала ---\n${stderr.split(TOKEN).join('<TOKEN!>')}`)
}
const readPid = () => { try { return parseInt(readFileSync(join(STATE, 'bot.pid'), 'utf8'), 10) || 0 } catch { return 0 } }
const call = (name, args) => client.callTool({ name, arguments: args })
const textOf = (r) => r.content?.map(c => c.text).join('\n') ?? ''
const sentTo = (chatId) => reqs.filter(r => r.method === 'POST' && r.path === '/messages' && r.query.chat_id === String(chatId) && r.body?.text)

try {
  await client.connect(transport)
  const firstPid = await until(readPid, 5000, 'bot.pid')
  const tools = (await client.listTools()).tools.map(t => t.name).sort()
  assert.deepEqual(tools, ['download_attachment', 'edit_message', 'reply'])
  step('MCP поднялся, инструменты: ' + tools.join(', '))

  // ── входящие ──
  pushUpdates([
    msg(MAMA, 5001, 'mid.t1', 'Привет, это мама'),
    msg(MAMA, 5001, 'mid.v1', '', [{ type: 'audio', payload: { url: cdn('voice'), token: 'v1' } }]),
    msg(STRANGER, 6001, 'mid.s1', 'кто это?'),
  ])
  await until(() => notes.length >= 2, 15000, 'два уведомления')
  assert.equal(notes[0].content, 'Привет, это мама')
  assert.equal(notes[0].meta.chat_id, '5001')
  assert.equal(notes[0].meta.user_id, '111')
  assert.equal(notes[0].meta.user, 'Мама')
  assert.equal(notes[0].meta.message_id, 'mid.t1')
  step('текст мамы пришёл в сессию с метой')

  assert.equal(notes[1].content, '[голосовое, расшифровка]: Купи хлеба и позвони Кате')
  assert.ok(notes[1].meta.audio_path.endsWith('.ogg'), notes[1].meta.audio_path)
  assert.equal(readFileSync(notes[1].meta.audio_path).subarray(0, 4).toString(), 'OggS')
  assert.equal(notes[1].meta.attachment_id, 'mid.v1:0')
  assert.ok(sentTo(5001).some(r => r.body.text === 'Слушаю голосовое…'), 'служебное «Слушаю голосовое…»')
  assert.ok(reqs.some(r => r.path === '/chats/5001/actions' && r.body?.action === 'typing_on'), 'typing_on')
  const cdnReqs = reqs.filter(r => r.path.startsWith('/cdn/'))
  assert.ok(cdnReqs.length && cdnReqs.every(r => !r.auth), 'на CDN токен не уходит')
  step('голосовое скачано, расшифровано, «Слушаю голосовое…» и typing_on ушли')

  assert.equal(notes.length, 2, 'незнакомец не попал в сессию')
  const pairMsg = await until(() => sentTo(6001)[0], 5000, 'код pairing')
  const access1 = JSON.parse(readFileSync(join(STATE, 'access.json'), 'utf8'))
  const [code, pend] = Object.entries(access1.pending)[0]
  assert.ok(pairMsg.body.text.includes(code))
  assert.equal(pend.senderId, '222')
  assert.equal(pend.chatId, '6001')
  assert.equal(access1.note, 'ручная заметка', 'ручные ключи access.json не потерялись')
  step(`незнакомцу ушёл код ${code}, в access.json появился pending`)

  const apiReqs = reqs.filter(r => !r.path.startsWith('/cdn/') && !r.path.startsWith('/upload-target/'))
  assert.ok(apiReqs.every(r => r.auth === TOKEN), 'Authorization: <токен> без Bearer')
  step('Authorization на всех запросах к API — токен без Bearer')

  // ── reply ──
  const para = 'Строка ответа. '.repeat(60).trim()
  const long = Array.from({ length: 6 }, () => para).join('\n\n')
  const before = sentTo(5001).length
  const r1 = await call('reply', { chat_id: '5001', text: long, reply_to: 'mid.t1' })
  assert.ok(!r1.isError, textOf(r1))
  const parts = sentTo(5001).slice(before)
  assert.equal(parts.length, 2)
  assert.deepEqual(parts[0].body.link, { type: 'reply', mid: 'mid.t1' })
  assert.equal(parts[1].body.link, undefined)
  assert.ok(parts.every(p => p.body.text.length <= 4000 && p.body.format === undefined))
  assert.match(textOf(r1), /отправлено 2 сообщ/)
  const firstMid = textOf(r1).match(/mid\.bot\d+/)[0]
  step('длинный reply нарезан на 2 части, reply_to только у первой, без format')

  const png = join(TMP, 'pill.png')
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
  const ogg = join(TMP, 'answer.ogg')
  writeFileSync(ogg, Buffer.concat([Buffer.from('OggS'), Buffer.alloc(100)]))
  const r2 = await call('reply', { chat_id: '5001', text: 'Вот фото и аудио', files: [png, ogg] })
  assert.ok(!r2.isError, textOf(r2))
  const ups = reqs.filter(r => r.path.startsWith('/upload-target/'))
  assert.deepEqual(ups.map(u => u.path), ['/upload-target/image', '/upload-target/audio'])
  assert.ok(ups.every(u => !u.auth && /multipart\/form-data/.test(u.ctype) && u.rawText.includes('name="data"')))
  const withAtt = reqs.filter(r => r.path === '/messages' && r.body?.attachments)
  assert.deepEqual(withAtt.map(r => r.body.attachments[0]), [
    { type: 'image', payload: { photos: { k1: { token: 'photo-token-1' } } } },
    { type: 'image', payload: { photos: { k1: { token: 'photo-token-1' } } } },
    { type: 'audio', payload: { token: 'up-audio' } },
    { type: 'audio', payload: { token: 'up-audio' } },
  ])
  step('файлы: image → photos, audio → token из /uploads; attachment.not.ready переждан')

  const r3 = await call('reply', { chat_id: '6001', text: 'не должно уйти' })
  assert.ok(r3.isError && /не разрешён/.test(textOf(r3)))
  const r4 = await call('reply', { chat_id: '5001', text: 'x', files: [join(STATE, '.env')] })
  assert.ok(r4.isError && /не отправляю файл состояния/.test(textOf(r4)))
  const r5 = await call('reply', { chat_id: '5001', text: 'x', files: ['relative.txt'] })
  assert.ok(r5.isError && /абсолютный/.test(textOf(r5)))
  step('исходящий гейт: чужой чат, .env и относительный путь — отказ')

  // ── вложения ──
  const d1 = await call('download_attachment', { chat_id: '5001', attachment_id: 'mid.v1:0' })
  assert.ok(!d1.isError, textOf(d1))
  assert.ok(existsSync(textOf(d1).trim()))
  const d2 = await call('download_attachment', { chat_id: '6001', attachment_id: 'mid.v1:0' })
  assert.ok(d2.isError)
  step('download_attachment по attachment_id; чужой чат — отказ')

  pushUpdates([msg(MAMA, 5001, 'mid.p1', 'смотри', [{ type: 'image', payload: { photo_id: 1, token: 'p', url: cdn('photo.jpg') } }])])
  await until(() => notes.length >= 3, 10000, 'уведомление с фото')
  assert.equal(notes[2].content, 'смотри\n[фото]')
  assert.ok(notes[2].meta.image_path.endsWith('.webp'), `расширение по байтам, а не по url: ${notes[2].meta.image_path}`)
  step('фото скачано автоматически, расширение определено по содержимому (webp)')

  // ── одобрение pairing ──
  const acc = JSON.parse(readFileSync(join(STATE, 'access.json'), 'utf8'))
  acc.allowFrom.push('222')
  writeFileSync(join(STATE, 'access.json'), JSON.stringify(acc, null, 2))
  await until(() => sentTo(6001).some(r => r.body.text.startsWith('Готово, доступ открыт')), 10000, 'подтверждение одобрения')
  await until(() => Object.keys(JSON.parse(readFileSync(join(STATE, 'access.json'), 'utf8')).pending).length === 0, 5000, 'pending очищен')
  const r6 = await call('reply', { chat_id: '6001', text: 'Здравствуйте!' })
  assert.ok(!r6.isError, textOf(r6))
  step('админ вписал 222 в allowFrom → «доступ открыт», pending очищен, reply в его чат разрешён')

  // ── edit_message ──
  const e1 = await call('edit_message', { chat_id: '5001', message_id: firstMid, text: 'исправлено' })
  assert.ok(!e1.isError, textOf(e1))
  assert.ok(reqs.some(r => r.method === 'PUT' && r.query.message_id === firstMid && r.body?.text === 'исправлено'))
  const e2 = await call('edit_message', { chat_id: '5001', message_id: 'mid.t1', text: 'чужое' })
  assert.ok(e2.isError)
  step('edit_message правит своё, чужое — отказ')

  // ── marker и дубли ──
  await sleep(1200)
  const st = JSON.parse(readFileSync(join(STATE, 'updates.json'), 'utf8'))
  assert.equal(st.marker, String(markerSeq))
  assert.ok(st.seen.includes('mid.t1') && st.seen.includes('mid.v1'))
  const markersSent = reqs.filter(r => r.path === '/updates').map(r => r.query.marker)
  assert.equal(markersSent[0], undefined, 'первый опрос без marker')
  assert.ok(markersSent.slice(1).every(Boolean), 'дальше marker передаётся')
  const n0 = notes.length
  pushUpdates([msg(MAMA, 5001, 'mid.t1', 'Привет, это мама')])
  await sleep(2500)
  assert.equal(notes.length, n0, 'повторно доставленное сообщение отсечено')
  step(`marker сохранён (${st.marker}), повтор mid отсечён`)

  assert.ok(!stderr.includes(TOKEN), 'токен в stderr!')
  step('токена нет в логах канала')

  // ── один потребитель на папку ──
  const second = spawn(RUNTIME, [SERVER], { env: ENV, cwd: PLUGIN, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr2 = ''
  second.stderr.on('data', d => { stderr2 += d })
  await until(() => readPid() === second.pid, 8000, 'второй занял bot.pid')
  await until(() => { try { process.kill(firstPid, 0); return false } catch { return true } }, 8000, 'первый погашен')
  assert.match(stderr2, new RegExp(`гашу прошлый поллер этой папки pid=${firstPid}`))
  step(`второй экземпляр погасил первый (pid ${firstPid}) и занял bot.pid`)
  second.stdin.end()
  await until(() => !existsSync(join(STATE, 'bot.pid')), 5000, 'bot.pid убран при выходе')
  step('по EOF на stdin канал выходит и убирает bot.pid')

  // посторонний процесс в bot.pid не трогаем; заодно схема Bearer
  const stranger = spawn('sleep', ['30'], { stdio: 'ignore' })
  writeFileSync(join(STATE, 'bot.pid'), String(stranger.pid))
  const meCount = reqs.filter(r => r.path === '/me').length
  const third = spawn(RUNTIME, [SERVER], { env: { ...ENV, MAX_AUTH_SCHEME: 'bearer' }, cwd: PLUGIN, stdio: ['pipe', 'ignore', 'pipe'] })
  await until(() => readPid() === third.pid, 8000, 'третий занял bot.pid')
  await until(() => reqs.filter(r => r.path === '/me').length > meCount, 8000, 'GET /me от третьего')
  process.kill(stranger.pid, 0)
  assert.equal(reqs.filter(r => r.path === '/me').at(-1).auth, `Bearer ${TOKEN}`)
  step('посторонний pid в bot.pid не тронут; MAX_AUTH_SCHEME=bearer шлёт «Bearer <токен>»')
  third.kill('SIGTERM')
  stranger.kill('SIGTERM')
  await sleep(500)
} finally {
  try { await client.close() } catch {}
  srv.close()
  rmSync(TMP, { recursive: true, force: true })
}
console.log(`\n${passed} ok`)
process.exit(0)

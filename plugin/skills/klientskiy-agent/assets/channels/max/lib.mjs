/**
 * Чистые функции канала MAX: нарезка текста, разбор update, доступ, pairing,
 * сборка уведомления, запуск расшифровки. Ничего не делает при импорте —
 * поэтому test/selftest.mjs гоняет их без сети и без MCP.
 *
 * server.mjs — всё, что с побочными эффектами (сеть, файлы, процесс).
 */

import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { resolve as resolvePath, join, extname, basename } from 'path'

export const MAX_TEXT_LIMIT = 4000          // жёсткий предел MAX на text
export const DEFAULT_CHUNK = 3900           // запас, как в рабочем мосте ccc-max-bridge
export const PACKAGE_NAME = 'claude-channel-max'

// ───────────────────────────── .env ─────────────────────────────

/** KEY=VALUE построчно; # — комментарий; кавычки вокруг значения снимаются. */
export function parseEnvFile(text) {
  const out = {}
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
        (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/** Вырезает секреты из любой строки, которая уходит в лог или в ответ инструмента. */
export function makeRedactor(secrets) {
  const list = (secrets ?? []).filter(s => typeof s === 'string' && s.length >= 6)
  return (s) => {
    let out = String(s)
    for (const sec of list) out = out.split(sec).join('***')
    return out
  }
}

// ───────────────────────────── текст ─────────────────────────────

/**
 * Режет текст на куски не длиннее limit. Сначала по абзацам, потом по строкам,
 * по концу предложения, по пробелу; в крайнем случае — жёстко, но не посреди
 * суррогатной пары (эмодзи).
 */
export function chunkText(text, limit = DEFAULT_CHUNK) {
  const s = String(text ?? '')
  limit = Math.max(1, Math.min(limit, MAX_TEXT_LIMIT))
  if (s.length <= limit) return [s]
  const out = []
  let rest = s
  while (rest.length > limit) {
    const win = rest.slice(0, limit)
    let cut = -1
    const para = win.lastIndexOf('\n\n')
    if (para >= limit * 0.5) cut = para
    if (cut < 0) {
      const line = win.lastIndexOf('\n')
      if (line >= limit * 0.5) cut = line
    }
    if (cut < 0) {
      // конец предложения: режем после знака
      let best = -1
      for (const re of [/[.!?…][)»"']?\s/g]) {
        let m
        while ((m = re.exec(win)) !== null) best = m.index + m[0].length - 1
      }
      if (best >= limit * 0.5) cut = best
    }
    if (cut < 0) {
      const sp = win.lastIndexOf(' ')
      if (sp >= limit * 0.3) cut = sp
    }
    if (cut <= 0) {
      cut = limit
      const code = rest.charCodeAt(cut - 1)
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1   // не рвём эмодзи
    }
    const piece = rest.slice(0, cut).replace(/\s+$/, '')
    if (piece) out.push(piece)
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest) out.push(rest)
  return out.length ? out : ['']
}

/**
 * Имена и названия файлов задаёт отправитель, а они попадают в атрибуты тега
 * <channel>. Убираем символы, которыми можно «выйти» из тега или подделать мету.
 */
export function safeName(s, max = 120) {
  if (s == null) return undefined
  const v = String(s).replace(/[<>\[\]\r\n\t;"`\\]/g, '_').trim()
  return v ? v.slice(0, max) : undefined
}

export function displayName(user) {
  if (!user) return ''
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return user.name || full || user.username || String(user.user_id ?? '')
}

// ───────────────────────────── доступ ─────────────────────────────

// `open` — для клиентских ботов: личку пишут незнакомые люди, и код для владельца вместо
// ответа означал бы потерянного клиента. Для личных помощников остаётся `pairing`.
export const DM_POLICIES = ['open', 'allowlist', 'pairing', 'disabled']

export function defaultAccess() {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

/**
 * Приводит access.json к рабочему виду. Неизвестные ключи сохраняются, чтобы
 * запись pending не стирала то, что админ дописал руками. `chats` — старое
 * имя из ВК-плагина, читается как `groups`.
 */
export function normalizeAccess(raw) {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const warnings = []
  let dmPolicy = r.dmPolicy ?? 'pairing'
  if (!DM_POLICIES.includes(dmPolicy)) {
    warnings.push(`dmPolicy "${dmPolicy}" не поддерживается, работаю как "allowlist"`)
    dmPolicy = 'allowlist'
  }
  const groupsRaw = r.groups ?? r.chats ?? {}
  const groups = {}
  for (const [id, g] of Object.entries(groupsRaw && typeof groupsRaw === 'object' ? groupsRaw : {})) {
    groups[String(id)] = {
      ...(g && typeof g === 'object' ? g : {}),
      requireMention: g?.requireMention !== false,
      allowFrom: Array.isArray(g?.allowFrom) ? g.allowFrom.map(String) : [],
    }
  }
  const access = {
    ...r,
    dmPolicy,
    allowFrom: Array.isArray(r.allowFrom) ? r.allowFrom.map(String) : [],
    groups,
    pending: (r.pending && typeof r.pending === 'object') ? { ...r.pending } : {},
    mentionPatterns: Array.isArray(r.mentionPatterns) ? r.mentionPatterns.map(String) : [],
  }
  if (r.chats && !r.groups) delete access.chats
  return { access, warnings }
}

/**
 * Разбор текста access.json. Если файл битый (админ правит руками и ошибся
 * запятой) — НЕ откладываем его в сторону и не пишем поверх, а работаем
 * по последней удачной версии: иначе мама молча потеряет доступ.
 */
export function parseAccessText(text, lastGood) {
  if (text == null) return { access: lastGood ?? defaultAccess(), ok: true, missing: true, warnings: [] }
  try {
    const { access, warnings } = normalizeAccess(JSON.parse(text))
    return { access, ok: true, warnings }
  } catch (e) {
    return { access: lastGood ?? { ...defaultAccess(), dmPolicy: 'allowlist' }, ok: false, error: String(e.message ?? e), warnings: [] }
  }
}

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000   // одобряют правкой файла — даём сутки
export const PENDING_MAX = 3
export const PENDING_REPLIES_MAX = 2

export function pruneExpired(access, now = Date.now()) {
  let changed = false
  for (const [code, p] of Object.entries(access.pending ?? {})) {
    if (!p || typeof p !== 'object' || (p.expiresAt ?? 0) < now) {
      delete access.pending[code]
      changed = true
    }
  }
  return changed
}

export function newPairingCode(rand = randomBytes) {
  return rand(3).toString('hex')
}

/** Позвали ли бота в групповом чате. */
export function isMentioned(ev, bot, patterns = []) {
  const text = ev.text ?? ''
  const uname = bot?.username ? String(bot.username).replace(/^@/, '').toLowerCase() : ''
  for (const mk of ev.markup ?? []) {
    if (mk?.type !== 'user_mention') continue
    if (bot?.user_id != null && mk.user_id != null && String(mk.user_id) === String(bot.user_id)) return true
    if (uname && mk.user_link && String(mk.user_link).replace(/^@/, '').toLowerCase() === uname) return true
  }
  if (uname) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])@${uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu')
    if (re.test(text)) return true
  }
  if (ev.link?.type === 'reply' && bot?.user_id != null &&
      String(ev.link.sender?.user_id ?? '') === String(bot.user_id)) return true
  for (const p of patterns) {
    try { if (new RegExp(p, 'iu').test(text)) return true } catch { /* кривой regex из файла */ }
  }
  return false
}

/**
 * Решение по входящему: deliver | drop | pair. Для pair мутирует access.pending,
 * вызывающий сохраняет файл (changed=true).
 */
export function gateDecision(access, ev, bot, { now = Date.now(), rand = randomBytes } = {}) {
  if (ev.isBot) return { action: 'drop', reason: 'бот' }
  if (bot?.user_id != null && ev.userId === String(bot.user_id)) return { action: 'drop', reason: 'своё сообщение' }
  if (!ev.userId) return { action: 'drop', reason: 'нет отправителя' }
  if (access.dmPolicy === 'disabled') return { action: 'drop', reason: 'канал выключен (dmPolicy=disabled)' }

  if (ev.chatType === 'dialog') {
    if (access.dmPolicy === 'open') return { action: 'deliver' }
    if (access.allowFrom.includes(ev.userId)) return { action: 'deliver' }
    if (access.dmPolicy !== 'pairing') return { action: 'drop', reason: 'не в allowFrom' }
    for (const [code, p] of Object.entries(access.pending)) {
      if (String(p.senderId) === ev.userId) {
        if ((p.replies ?? 1) >= PENDING_REPLIES_MAX) return { action: 'drop', reason: 'ждёт одобрения, код уже отправлен' }
        p.replies = (p.replies ?? 1) + 1
        return { action: 'pair', code, isResend: true, changed: true }
      }
    }
    if (Object.keys(access.pending).length >= PENDING_MAX) return { action: 'drop', reason: 'очередь pending заполнена' }
    let code = newPairingCode(rand)
    while (access.pending[code]) code = newPairingCode(rand)
    access.pending[code] = {
      senderId: ev.userId,
      chatId: ev.chatId,
      name: safeName(displayName(ev.user)) ?? '',
      username: safeName(ev.user?.username) ?? '',
      createdAt: now,
      expiresAt: now + PENDING_TTL_MS,
      replies: 1,
    }
    return { action: 'pair', code, isResend: false, changed: true }
  }

  if (ev.chatType === 'chat') {
    const g = access.groups[ev.chatId]
    if (!g) return { action: 'drop', reason: 'чат не в groups' }
    // Свой allowFrom у группы — закрытая комната: слушаем только этих людей.
    // Пусто: при dmPolicy=open (клиентский бот) отвечаем любому участнику — так же
    // работает официальный telegram-плагин, на котором куратор отвечает в чате потока.
    // При pairing/allowlist (личный помощник) действует общий allowFrom: иначе любой
    // участник группы стал бы «своим» и получил доступ к личному агенту.
    const allow = g.allowFrom.length ? g.allowFrom : (access.dmPolicy === 'open' ? null : access.allowFrom)
    if (allow && !allow.includes(ev.userId)) return { action: 'drop', reason: 'отправитель не в allowFrom' }
    if (g.requireMention && ev.kind === 'message' && !isMentioned(ev, bot, access.mentionPatterns)) {
      return { action: 'drop', reason: 'не позвали', quiet: true }
    }
    return { action: 'deliver' }
  }
  return { action: 'drop', reason: `тип чата ${ev.chatType ?? '?'}` }
}

/** Ожидающие pairing, которых админ уже вписал в allowFrom. */
export function findApproved(access) {
  return Object.entries(access.pending ?? {})
    .filter(([, p]) => p && access.allowFrom.includes(String(p.senderId)))
    .map(([code, p]) => ({ code, ...p }))
}

/**
 * Исходящий гейт: писать можно только туда, откуда приняли бы входящее.
 * В MAX chat_id лички ≠ user_id, поэтому храним соответствие dialogs.json.
 */
export function resolveOutbound(access, dialogs, { chat_id, user_id } = {}) {
  const cid = chat_id != null && chat_id !== '' ? String(chat_id) : ''
  const uid = user_id != null && user_id !== '' ? String(user_id) : ''
  if (cid) {
    if (access.groups[cid]) return { chatId: cid, kind: 'chat' }
    const owner = dialogs?.[cid]
    // dmPolicy=open — клиентский бот: отвечаем любому, кто сам написал (такая личка попала
    // в dialogs на входящем). Без этого бот принимал бы сообщения и не мог ответить.
    if (owner && (access.dmPolicy === 'open' || access.allowFrom.includes(String(owner)))) {
      return { chatId: cid, kind: 'dialog', userId: String(owner) }
    }
    throw new Error(`chat_id ${cid} не разрешён: это не группа из access.json и не личка человека, который писал боту`)
  }
  if (uid) {
    // При open первым не пишем никому: отвечать можно только тому, кто сам написал
    // (такой человек есть в dialogs). Иначе агента можно уговорить разослать сообщения.
    const wroteFirst = Object.values(dialogs ?? {}).some((u) => String(u) === uid)
    if (access.dmPolicy === 'open') {
      if (!wroteFirst) throw new Error(`user_id ${uid} сам боту не писал — первым не пишем`)
    } else if (!access.allowFrom.includes(uid)) {
      throw new Error(`user_id ${uid} не в allowFrom`)
    }
    const known = Object.entries(dialogs ?? {}).find(([, u]) => String(u) === uid)
    return known ? { chatId: known[0], kind: 'dialog', userId: uid } : { userId: uid, kind: 'dialog' }
  }
  throw new Error('нужен chat_id (или user_id)')
}

// ───────────────────────── разбор update ─────────────────────────

/** Приводит update MAX к плоскому событию или null, если нас оно не касается. */
export function normalizeUpdate(u) {
  if (!u || typeof u !== 'object') return null
  if (u.update_type === 'message_created' && u.message) {
    const m = u.message
    const body = m.body ?? {}
    const sender = m.sender ?? null
    const rec = m.recipient ?? {}
    return {
      kind: 'message',
      chatId: rec.chat_id != null ? String(rec.chat_id) : '',
      chatType: rec.chat_type ?? '',
      userId: sender?.user_id != null ? String(sender.user_id) : '',
      isBot: !!sender?.is_bot,
      user: sender,
      mid: body.mid != null ? String(body.mid) : '',
      ts: Number(m.timestamp ?? u.timestamp ?? 0),
      text: body.text ?? '',
      markup: Array.isArray(body.markup) ? body.markup : [],
      link: m.link ?? null,
      message: m,
      locale: u.user_locale ?? undefined,
    }
  }
  if (u.update_type === 'bot_started' && u.user) {
    return {
      kind: 'started',
      chatId: u.chat_id != null ? String(u.chat_id) : '',
      chatType: 'dialog',
      userId: u.user.user_id != null ? String(u.user.user_id) : '',
      isBot: !!u.user.is_bot,
      user: u.user,
      mid: '',
      ts: Number(u.timestamp ?? 0),
      text: '',
      markup: [],
      link: null,
      payload: u.payload ?? undefined,
      message: null,
      locale: u.user_locale ?? undefined,
    }
  }
  return null
}

/**
 * Ошибка сервера MAX (max-bot-api-client-ts#250, maxapi#191/#235, октябрь 2026): на нативное голосовое и
 * видеокружок бот получает message_created БЕЗ message — ни звука, ни отправителя, ни mid, и в GET /messages
 * его тоже нет. Если бот закрыт allowlist'ом на одного человека, такое событие почти наверняка от него:
 * вернём, кому сообщить агенту. Иначе null (кто прислал — неизвестно). { skip } — повтор чаще minGapMs.
 */
export function opaqueTarget(u, access, dialogs, lastAt, now, minGapMs = 120_000) {
  if (!u || u.update_type !== 'message_created' || u.message) return null
  const allow = (access?.allowFrom ?? []).map(String)
  if (access?.dmPolicy !== 'allowlist' || allow.length !== 1) return null
  if (now - (lastAt ?? 0) < minGapMs) return { skip: true }
  const userId = allow[0]
  const chatId = Object.entries(dialogs ?? {}).find(([, uid]) => String(uid) === userId)?.[0] ?? ''
  return { userId, chatId }
}

export const OPAQUE_TEXT =
  '[голосовое или видеокружок — MAX не передаёт ботам содержимое таких сообщений, звука нет]'

/**
 * Форма update для служебного журнала: тип, вложения (свои и из пересланного) с ключами payload,
 * есть ли текст. БЕЗ текста, ссылок, токенов и имён — журнал можно смотреть, не нарушая приватность.
 */
export function updateShape(u) {
  if (!u || typeof u !== 'object') return 'не объект'
  const m = u.message ?? {}
  const att = (list) => (Array.isArray(list) ? list : []).map((a) => {
    const keys = Object.keys(a?.payload ?? {}).filter((k) => !/token|url/i.test(k)).sort()
    const has = ['url', 'token'].filter((k) => a?.payload?.[k] != null)
    return `${a?.type ?? '?'}${has.length ? '+' + has.join('+') : ''}${keys.length ? '{' + keys.join(',') + '}' : ''}`
  })
  const parts = [`type=${u.update_type ?? '?'}`]
  if (m.recipient?.chat_type) parts.push(`chat=${m.recipient.chat_type}`)
  if (m.sender?.user_id != null) parts.push(`from=${m.sender.user_id}${m.sender.is_bot ? '(бот)' : ''}`)
  if (u.update_type === 'message_created' || m.body) {
    parts.push(`text=${m.body?.text ? 'да' : 'нет'}`)
    const own = att(m.body?.attachments)
    if (own.length) parts.push(`att=[${own.join(' ')}]`)
    const extra = Object.keys(m.body ?? {}).filter((k) => !['mid', 'seq', 'text', 'attachments', 'markup'].includes(k))
    if (extra.length) parts.push(`body+{${extra.join(',')}}`)
  }
  if (m.link) {
    const inner = att(m.link.message?.attachments)
    parts.push(`link=${m.link.type ?? '?'}(text=${m.link.message?.text ? 'да' : 'нет'}${inner.length ? ' att=[' + inner.join(' ') + ']' : ''})`)
  }
  return parts.join(' ')
}

/**
 * Все вложения сообщения в одном порядке: сначала свои, потом из пересланного.
 * Тот же порядок получается и для Message из GET /messages/{mid}, поэтому
 * attachment_id = "<mid>:<индекс>" переживает рестарт.
 */
export function enumerateAttachments(message) {
  if (!message) return []
  const own = message.body?.attachments ?? []
  const fwd = message.link?.type === 'forward' ? (message.link?.message?.attachments ?? []) : []
  return [...own, ...fwd].map((att, idx) => ({ idx, att, forwarded: idx >= own.length }))
}

const DOWNLOADABLE = new Set(['image', 'audio', 'video', 'file', 'sticker'])

function vcfField(vcf, key) {
  const m = String(vcf ?? '').match(new RegExp(`^${key}[^:\\n]*:(.+)$`, 'mi'))
  return m ? m[1].trim() : ''
}

/** Короткое описание вложения для текста уведомления. */
export function describeAttachment(att) {
  const t = att?.type
  const p = att?.payload ?? {}
  switch (t) {
    case 'image': return { kind: 'image', downloadable: true, label: '[фото]' }
    case 'audio': return { kind: 'audio', downloadable: true, label: '[голосовое сообщение]' }
    case 'video': {
      const d = att.duration ? `, ${fmtDuration(att.duration)}` : ''
      return { kind: 'video', downloadable: true, label: `[видео${d}]`, duration: att.duration }
    }
    case 'file': {
      const name = safeName(att.filename) ?? 'файл'
      return { kind: 'file', downloadable: true, label: `[файл: ${name}${att.size ? `, ${fmtSize(att.size)}` : ''}]`, name, size: att.size }
    }
    case 'sticker': return { kind: 'sticker', downloadable: true, label: '[стикер]' }
    case 'contact': {
      const name = safeName(p.max_info ? displayName(p.max_info) : vcfField(p.vcf_info, 'FN')) ?? ''
      const tel = safeName(vcfField(p.vcf_info, 'TEL')) ?? ''
      return { kind: 'contact', downloadable: false, label: `[контакт: ${[name, tel].filter(Boolean).join(', ') || 'без данных'}]` }
    }
    case 'location':
      return { kind: 'location', downloadable: false, label: `[геопозиция: ${att.latitude}, ${att.longitude}]` }
    case 'share': {
      const title = safeName(att.title, 200)
      return { kind: 'share', downloadable: false, label: `[ссылка: ${p.url ?? ''}${title ? ` — ${title}` : ''}]` }
    }
    case 'inline_keyboard': return { kind: 'keyboard', downloadable: false, label: '' }
    default: return { kind: String(t ?? 'unknown'), downloadable: DOWNLOADABLE.has(t), label: `[вложение: ${safeName(t) ?? '?'}]` }
  }
}

export function fmtDuration(sec) {
  const s = Math.round(Number(sec) || 0)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function fmtSize(n) {
  const b = Number(n) || 0
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} МБ`
  if (b >= 1024) return `${Math.round(b / 1024)} КБ`
  return `${b} Б`
}

// ─────────────────────────── файлы ───────────────────────────

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.tif', '.tiff', '.bmp', '.heic', '.webp'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm'])
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.opus', '.aac', '.flac'])

/** Как отправлять файл в MAX. Если тип не примут — server.mjs повторит как file. */
export function fileKind(path) {
  const e = extname(String(path)).toLowerCase()
  if (IMAGE_EXT.has(e)) return 'image'
  if (VIDEO_EXT.has(e)) return 'video'
  if (AUDIO_EXT.has(e)) return 'audio'
  return 'file'
}

/** Лимиты MAX на загрузку (dev.max.ru, POST /uploads). */
export const UPLOAD_LIMITS = {
  image: 50 * 1024 * 1024,
  video: 250 * 1024 * 1024,
  audio: 256 * 1024 * 1024,
  file: 4 * 1024 * 1024 * 1024,
}

const CT_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/heic': 'heic', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'application/pdf': 'pdf',
}

export function extFromContentType(ct) {
  const base = String(ct ?? '').split(';')[0].trim().toLowerCase()
  return CT_EXT[base] ?? ''
}

/** Расширение по первым байтам: MAX отдаёт «.jpg», который на деле WebP, и т.п. */
export function sniffExt(buf) {
  if (!buf || buf.length < 4) return ''
  const b = Buffer.from(buf)
  const s = (o, n) => b.subarray(o, o + n).toString('latin1')
  if (s(0, 4) === 'OggS') return 'ogg'
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && b.length > 2 && (b[1] & 0x06) !== 0)) return 'mp3'
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac'
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'webp'
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav'
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg'
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return 'png'
  if (s(0, 3) === 'GIF') return 'gif'
  if (s(0, 4) === '%PDF') return 'pdf'
  if (s(0, 4) === '\x1aE\xdf\xa3') return 'webm'
  if (s(4, 4) === 'ftyp') {
    const brand = s(8, 4)
    if (/^M4A|^M4B/.test(brand)) return 'm4a'
    if (/^heic|^heix|^mif1/.test(brand)) return 'heic'
    if (/^qt/.test(brand)) return 'mov'
    return 'mp4'
  }
  return ''
}

/** Имя файла от отправителя → безопасное имя внутри inbox. */
export function safeFileName(name, fallback = 'file') {
  const base = basename(String(name ?? '')).normalize('NFC')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^[.\s]+/, '').trim().slice(0, 100)
  return base || fallback
}

export function safeIdPart(s) {
  return String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(-32) || 'x'
}

export const DEFAULT_EXT = { image: 'jpg', audio: 'ogg', video: 'mp4', sticker: 'webp', file: 'bin' }

// ───────────────────────── маркер /updates ─────────────────────────

/**
 * marker — int64. JSON.parse теряет точность за 2^53, поэтому, если число
 * большое, берём его из сырого текста ответа и храним строкой.
 */
export function extractMarker(raw, parsed) {
  const v = parsed?.marker
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v)
  const all = [...String(raw).matchAll(/(?<!\\)"marker"\s*:\s*(-?\d+)/g)]
  return all.length ? all[all.length - 1][1] : String(v)
}

// ───────────────────────── pid / один потребитель ─────────────────────────

/**
 * Вердикт по процессу из bot.pid:
 *   dead     — процесса нет, файл можно перезаписать;
 *   ours     — это max-канал с ЭТОЙ папкой состояния, его можно гасить;
 *   foreign  — посторонний (pid переиспользован) или max-канал другой папки — не трогаем;
 *   unknown  — живой и похож на наш, но проверить нельзя — не трогаем и выходим с ошибкой.
 */
export function holderVerdict(h) {
  if (!h.alive) return 'dead'
  if (h.pid === h.selfPid || (h.parentPid && h.pid === h.parentPid)) return 'foreign'
  if (h.args == null) return 'unknown'
  if (!/server\.mjs/.test(h.args)) return 'foreign'
  if (h.pkgName === undefined) return 'unknown'
  if (h.pkgName !== PACKAGE_NAME) return 'foreign'
  if (h.stateDir === undefined) return h.envReadable === 'unsupported' ? 'ours' : 'unknown'
  if (resolvePath(h.stateDir) !== resolvePath(h.ourStateDir)) return 'foreign'
  return 'ours'
}

/** Папка состояния чужого процесса по его окружению (как её вычислил бы server.mjs). */
export function stateDirFromEnv(env) {
  if (env.MAX_STATE_DIR) return env.MAX_STATE_DIR
  const cfg = env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, '.claude') : undefined)
  return cfg ? join(cfg, 'channels', 'max') : undefined
}

// ───────────────────────── расшифровка голосовых ─────────────────────────

/** Разбивает строку команды на argv без shell: кавычки '...' и "...", экранирование \. */
export function splitCommand(str) {
  const out = []
  let cur = ''
  let quote = null
  let has = false
  const s = String(str ?? '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) { quote = null; continue }
      if (c === '\\' && quote === '"' && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) { cur += s[++i]; continue }
      cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; continue }
    if (/\s/.test(c)) { if (has || cur) { out.push(cur); cur = ''; has = false } continue }
    cur += c
  }
  if (quote) throw new Error('незакрытая кавычка в MAX_TRANSCRIBE_CMD')
  if (has || cur) out.push(cur)
  return out
}

/**
 * Запускает команду расшифровки: путь к файлу — последним аргументом, без shell,
 * с таймаутом. Никогда не бросает: возвращает {ok, text} или {ok:false, error}.
 * Группа процессов гасится целиком, чтобы ffmpeg/whisper не остались сиротами.
 */
export function runTranscribe({ cmd, path, timeoutMs = 300_000, env = process.env, maxChars = 20_000, track } = {}) {
  return new Promise((resolve) => {
    let argv
    try { argv = splitCommand(cmd) } catch (e) { resolve({ ok: false, error: e.message }); return }
    if (!argv.length) { resolve({ ok: false, error: 'пустая MAX_TRANSCRIBE_CMD' }); return }
    let child
    try {
      child = spawn(argv[0], [...argv.slice(1), path], {
        env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      })
    } catch (e) { resolve({ ok: false, error: `не запустилась: ${e.message}` }); return }
    track?.(child)
    const LIMIT = 4 * 1024 * 1024
    let out = Buffer.alloc(0)
    let errTail = ''
    let timedOut = false
    let done = false
    const killGroup = (sig) => {
      try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch {} }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 3000).unref?.()
    }, timeoutMs)
    child.stdout.on('data', d => { if (out.length < LIMIT) out = Buffer.concat([out, d]) })
    child.stderr.on('data', d => { errTail = (errTail + d.toString('utf8')).slice(-600) })
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r) }
    child.on('error', e => finish({ ok: false, error: `не запустилась: ${e.code ?? e.message}` }))
    child.on('close', (code, signal) => {
      if (timedOut) return finish({ ok: false, error: `таймаут ${Math.round(timeoutMs / 1000)} с` })
      if (code !== 0) {
        const tail = errTail.trim().split('\n').slice(-2).join(' / ').slice(0, 300)
        return finish({ ok: false, error: `код ${code ?? signal}${tail ? `: ${tail}` : ''}` })
      }
      const text = out.toString('utf8').trim()
      if (!text) return finish({ ok: false, error: 'пустой результат' })
      finish({ ok: true, text: text.length > maxChars ? text.slice(0, maxChars) + ' …' : text })
    })
  })
}

// ───────────────────────── входящее → уведомление ─────────────────────────

/**
 * Текст из MAX попадает в сессию внутри тэга <channel …>. Если в тексте (или в пересланном
 * сообщении) есть «</channel><channel user=…>», им можно изобразить реплику другого человека.
 * Заменяем угловую скобку у таких тэгов на похожий символ — человеку читается так же.
 */
export function neutralizeChannelTags(text) {
  return String(text).replace(/<(\/?)(channel|system|antml|function)/gi, '‹$1$2')
}

export const TEXTS = {
  pairing: 'Здравствуйте! Я пока не могу отвечать: мой владелец должен подтвердить доступ. Передайте ему этот код: {code}',
  pairingResend: 'Доступ ещё не подтверждён. Код для владельца: {code}',
  approved: 'Готово, доступ открыт. Пишите или присылайте голосовые — я на связи.',
}

/** meta: только ключи-идентификаторы и строковые значения, иначе Claude Code их выкинет. */
export function cleanMeta(meta) {
  const out = {}
  for (const [k, v] of Object.entries(meta)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue
    if (v === undefined || v === null || v === '') continue
    out[k] = String(v)
  }
  return out
}

function quoteShort(s, n = 300) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * Полная обработка одного update. Все побочные эффекты — через deps, чтобы
 * selftest мог подменить сеть и команду расшифровки.
 *
 * deps: loadAccess, saveAccess, bot(), sendText(target, text), notify({content, meta}),
 *       download({ev, idx, att, kind}) → path|null, transcribe(path) → {ok,text,error} | null,
 *       typing {start, hold, release}, remember(ev), log, now(),
 *       config {autoDownload:Set, transcribeEnabled, noticeText, noticeAfterMs, texts}
 */
export async function processInbound(update, deps) {
  const ev = normalizeUpdate(update)
  if (!ev) return { action: 'ignored' }
  const now = deps.now?.() ?? Date.now()
  const cfg = deps.config ?? {}
  const texts = { ...TEXTS, ...(cfg.texts ?? {}) }

  const access = deps.loadAccess()
  if (pruneExpired(access, now)) deps.saveAccess?.(access)

  const bot = deps.bot?.() ?? null
  const decision = gateDecision(access, ev, bot, { now, rand: deps.rand })
  if (decision.action === 'drop') {
    if (!decision.quiet && !ev.isBot && decision.reason !== 'своё сообщение') {
      deps.log?.(`${ev.chatType === 'chat' ? `чат ${ev.chatId}` : 'личка'}: ${ev.userId || '?'} — ${decision.reason}, пропускаю`)
    }
    return { action: 'drop', reason: decision.reason, ev }
  }
  if (decision.action === 'pair') {
    if (decision.changed) deps.saveAccess?.(access)
    const tpl = decision.isResend ? texts.pairingResend : texts.pairing
    try {
      await deps.sendText({ chatId: ev.chatId || undefined, userId: ev.userId }, tpl.replace('{code}', decision.code))
    } catch (e) { deps.log?.(`не смог отправить код pairing: ${e.message ?? e}`) }
    deps.log?.(`pairing: ${ev.userId} (${safeName(displayName(ev.user)) ?? ''}) — код ${decision.code}${decision.isResend ? ' (повтор)' : ''}`)
    return { action: 'pair', code: decision.code, ev }
  }

  // deliver
  deps.remember?.(ev)
  if (ev.chatId) deps.typing?.start(ev.chatId)

  const meta = {
    chat_id: ev.chatId,
    chat_type: ev.chatType,
    user_id: ev.userId,
    user: safeName(displayName(ev.user)),
    username: safeName(ev.user?.username),
    message_id: ev.mid,
    ts: ev.ts ? new Date(ev.ts).toISOString() : undefined,
  }
  const lines = []

  if (ev.kind === 'started') {
    meta.event = 'bot_started'
    if (ev.payload) meta.start_payload = safeName(ev.payload, 200)
    lines.push('[нажата кнопка «Начать»]')
  }

  const link = ev.link
  if (link?.type === 'reply') {
    if (link.message?.mid) meta.in_reply_to = String(link.message.mid)
    const who = bot?.user_id != null && String(link.sender?.user_id ?? '') === String(bot.user_id)
      ? 'сообщение бота' : `сообщение ${safeName(displayName(link.sender)) ?? ''}`.trim()
    const q = quoteShort(link.message?.text)
    lines.push(`[в ответ на ${who}${q ? `: «${q}»` : ''}]`)
  }

  if (ev.text) lines.push(ev.text)

  const atts = enumerateAttachments(ev.message)
  const listed = []
  let firstDl = null
  let noticeSent = false
  for (const { idx, att, forwarded } of atts) {
    const d = describeAttachment(att)
    if (d.kind === 'keyboard') continue
    const attId = ev.mid ? `${ev.mid}:${idx}` : ''
    if (d.downloadable && attId) {
      listed.push(`${d.kind}:${attId}`)
      if (!firstDl) firstDl = { d, attId }
    }
    const prefix = forwarded ? '(из пересланного) ' : ''

    if (d.kind === 'audio') {
      const wantFile = cfg.transcribeEnabled || cfg.autoDownload?.has('audio')
      let path = null
      if (wantFile && attId) {
        try { path = await deps.download({ ev, idx, att, kind: 'audio' }) } catch (e) { deps.log?.(`голосовое не скачалось: ${e.message ?? e}`) }
        if (path && !meta.audio_path) meta.audio_path = path
      }
      const maxTr = att.transcription ? quoteShort(att.transcription, 20_000) : ''
      if (cfg.transcribeEnabled) {
        let res = { ok: false, error: 'файл не скачался' }
        if (path) {
          let noticeTimer = null
          if (cfg.noticeText && !noticeSent && ev.chatId) {
            noticeTimer = setTimeout(() => {
              noticeSent = true
              Promise.resolve()
                .then(() => deps.sendText({ chatId: ev.chatId, userId: ev.userId }, cfg.noticeText))
                .catch(e => deps.log?.(`не смог отправить «${cfg.noticeText}»: ${e?.message ?? e}`))
            }, cfg.noticeAfterMs ?? 20_000)
          }
          if (ev.chatId) deps.typing?.hold(ev.chatId)
          try { res = (await deps.transcribe(path)) ?? res }
          catch (e) { res = { ok: false, error: String(e.message ?? e) } }
          finally {
            if (noticeTimer) clearTimeout(noticeTimer)
            if (ev.chatId) deps.typing?.release(ev.chatId)
          }
        }
        if (res.ok) {
          meta.transcribed = 'yes'
          lines.push(`${prefix}[голосовое, расшифровка]: ${res.text}`)
        } else if (maxTr) {
          meta.transcribed = 'max'
          meta.transcribe_error = safeName(res.error, 200)
          lines.push(`${prefix}[голосовое, расшифровка MAX]: ${maxTr}`)
        } else {
          meta.transcribed = 'failed'
          meta.transcribe_error = safeName(res.error, 200)
          lines.push(`${prefix}[голосовое — расшифровать не удалось]${attId ? ` (attachment_id ${attId})` : ''}`)
          deps.log?.(`расшифровка не удалась: ${res.error}`)
        }
      } else if (maxTr) {
        lines.push(`${prefix}[голосовое, расшифровка MAX]: ${maxTr}`)
      } else {
        lines.push(`${prefix}${d.label}`)
      }
      continue
    }

    if (d.kind === 'image' && cfg.autoDownload?.has('image') && attId && !meta.image_path) {
      try {
        const p = await deps.download({ ev, idx, att, kind: 'image' })
        if (p) meta.image_path = p
      } catch (e) { deps.log?.(`фото не скачалось: ${e.message ?? e}`) }
    }
    if (d.label) lines.push(`${prefix}${d.label}`)
  }

  if (link?.type === 'forward') {
    const from = safeName(displayName(link.sender)) ?? 'неизвестного'
    meta.forwarded_from = from
    const ft = link.message?.text
    lines.push(`[переслано от ${from}]${ft ? `:\n${ft}` : ''}`)
  }

  if (firstDl) {
    meta.attachment_kind = firstDl.d.kind
    meta.attachment_id = firstDl.attId
    if (firstDl.d.name) meta.attachment_name = firstDl.d.name
    if (firstDl.d.size) meta.attachment_size = firstDl.d.size
  }
  if (listed.length > 1) {
    meta.attachment_count = listed.length
    meta.attachments = listed.join(' ')
  }
  // Агенту полезно знать, что «Слушаю голосовое…» уже ушло, чтобы не повторяться.
  if (noticeSent) meta.notice_sent = 'yes'

  const content = neutralizeChannelTags(lines.join('\n').trim()) || '[пустое сообщение]'
  const cleaned = cleanMeta(meta)
  await deps.notify({ content, meta: cleaned })
  if (ev.chatId) deps.typing?.start(ev.chatId)   // продлеваем «печатает» до ответа
  return { action: 'deliver', content, meta: cleaned, ev }
}

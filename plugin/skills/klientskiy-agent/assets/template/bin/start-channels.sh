#!/usr/bin/env bash
# Клиентский агент __BIZ__: один мозг, два канала — Telegram и MAX.
# Запускается службой __SLUG__-channels. Руками: systemctl restart __SLUG__-channels
set -euo pipefail

SOCKET="__SLUG__-ccc"
SESSION="channels"
WORKDIR="/opt/__SLUG__"
TG_DIR="/root/.claude/channels/__SLUG__-tg"
MAX_DIR="/root/.claude/channels/__SLUG__-max"
UNUSED_DIR="/root/.claude/channels/__SLUG__-unused"
LOGFILE="${WORKDIR}/logs/channels.log"

export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="/root"
# Пустой токен подписки раньше проглатывался молча: служба active, сессия жива,
# а агент упирается в экран входа и молчит. Лучше честно не стартовать.
if [[ ! -s "__OAUTH_FILE__" ]]; then
  say "СТОП: нет токена подписки (__OAUTH_FILE__). Положи его и запусти снова."
  echo "Нет токена подписки: __OAUTH_FILE__" >&2
  exit 1
fi
export CLAUDE_CODE_OAUTH_TOKEN="$(cat __OAUTH_FILE__)"
mkdir -p "${WORKDIR}/logs" "${UNUSED_DIR}" "${WORKDIR}/materials"

# Откуда агенту разрешено отправлять файлы клиентам. Пустой список означал бы
# «откуда угодно»: клиент попросил бы прислать файл с токеном — и агент прислал бы.
export TG_SEND_DIRS="${WORKDIR}/materials"
export MAX_SEND_DIRS="${WORKDIR}/materials"

say() { echo "$(date -Iseconds) $*" >> "$LOGFILE"; }

# --- какие каналы поднимаем: тот, у которого есть токен ---
#
# Telegram идёт через НАШ канал plugin:tg, а не через официальный плагин: у официального нет
# политики «пускать всех», и клиент вместо ответа получил бы код для владельца. Подробности —
# docs/kanaly-i-vhody.md. Официальный плагин включён глобально, поэтому ему всегда отдаём
# пустую папку состояния: без неё он заберёт bot.pid нашего канала.
export TELEGRAM_STATE_DIR="${UNUSED_DIR}"
DEV=()
if [[ -s "${TG_DIR}/.env" ]]; then
  export TG_STATE_DIR="${TG_DIR}"
  DEV+=("plugin:tg@__MKT_NAME__")
  say "Telegram: токен есть, канал включён (наш plugin:tg, dmPolicy из ${TG_DIR}/access.json)"
else
  export TG_STATE_DIR="${UNUSED_DIR}"
  say "Telegram: токена нет (${TG_DIR}/.env), канал выключен"
fi
if [[ -s "${MAX_DIR}/.env" ]]; then
  export MAX_STATE_DIR="${MAX_DIR}"
  DEV+=("plugin:max@__MKT_NAME__")
  say "MAX: токен есть, канал включён"
else
  export MAX_STATE_DIR="${UNUSED_DIR}"
  say "MAX: токена нет (${MAX_DIR}/.env), канал выключен"
fi
if [[ ${#DEV[@]} -eq 0 ]]; then
  say "СТОП: ни одного токена — поднимать нечего"
  echo "Нет ни одного токена: положи .env в ${TG_DIR} или ${MAX_DIR}" >&2
  exit 1
fi
# Свои каналы передаём ТОЛЬКО этим флагом (он принимает несколько через пробел). Если тот же
# плагин указать ещё и в --channels, Claude Code проверит его по allowlist, напишет в лог
# «Channel notifications skipped» и молча выбросит все входящие (проверено 20.10.2026).
DEV_CHANNELS="--dangerously-load-development-channels ${DEV[*]}"

tmux -L "$SOCKET" kill-session -t "$SESSION" 2>/dev/null || true

# dontAsk: разрешено только то, что в .claude/settings.json. В acceptEdits любая команда вне
# списка вставала вопросом «Do you want to proceed?» — отвечать некому, клиент ждал ответа.
CLAUDE_BASE="--model __MODEL__ --effort high --permission-mode dontAsk ${DEV_CHANNELS}"
ENVS="TG_STATE_DIR='${TG_STATE_DIR}' MAX_STATE_DIR='${MAX_STATE_DIR}' TELEGRAM_STATE_DIR='${TELEGRAM_STATE_DIR}' TG_SEND_DIRS='${TG_SEND_DIRS}' MAX_SEND_DIRS='${MAX_SEND_DIRS}'"

tmux -L "$SOCKET" new-session -d -s "$SESSION" -x 200 -y 50 \
  "cd ${WORKDIR} && exec env ${ENVS} sh -c \"claude --continue ${CLAUDE_BASE} || exec claude ${CLAUDE_BASE}\""

# Окна «Loading development channels» и «доверяете папке?» ждут Enter при каждом старте.
# Без этого сессия висит молча — так клиентский Кит молчал с установки до 20.10.2026.
for _ in $(seq 1 40); do
  PANE=$(tmux -L "$SOCKET" capture-pane -p -t "$SESSION" 2>/dev/null || true)
  if grep -qE "I am using this for local development|trust this folder|Do you trust the files" <<<"$PANE"; then
    tmux -L "$SOCKET" send-keys -t "$SESSION" Enter
    say "подтвердила окно при запуске"
    sleep 3
  elif grep -q "Channels (experimental)" <<<"$PANE"; then
    say "сессия поднялась, каналы слушают"
    break
  fi
  sleep 1
done

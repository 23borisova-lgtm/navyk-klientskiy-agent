#!/usr/bin/env bash
# Первичная установка на чистом сервере. Запускается ОДИН раз, уже на сервере:
#   bash /opt/__SLUG__/bin/install-server.sh
# Дальше обновления идут через deploy.sh с компьютера.
#
# Что делает: проверяет окружение, регистрирует канал-плагины из папки channels/,
# создаёт папки состояния, ставит службу. Токены не трогает — их кладёт человек.
set -euo pipefail

SLUG="__SLUG__"
MKT="__MKT_NAME__"
WORKDIR="/opt/${SLUG}"
OAUTH_FILE="__OAUTH_FILE__"
ok=0; bad=0
yes() { echo "  ✅ $*"; ok=$((ok+1)); }
no()  { echo "  ❌ $*"; bad=$((bad+1)); }

export PATH="/root/.bun/bin:$PATH"

echo "1. Окружение — чего нет, ставлю сама"
if ! command -v tmux >/dev/null || ! command -v python3 >/dev/null || ! command -v rsync >/dev/null; then
  echo "   ставлю базовые пакеты…"
  apt-get update -qq && apt-get install -y -qq curl git tmux python3 rsync >/dev/null 2>&1 || true
fi
command -v tmux >/dev/null && yes "tmux есть" || no "не поставился tmux: apt install -y tmux"
command -v python3 >/dev/null && yes "python3 есть" || no "не поставился python3"

if ! command -v claude >/dev/null; then
  echo "   ставлю node и Claude Code (это 2–5 минут)…"
  command -v npm >/dev/null || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1; apt-get install -y -qq nodejs >/dev/null 2>&1; }
  npm i -g @anthropic-ai/claude-code >/dev/null 2>&1 || true
fi
command -v claude >/dev/null && yes "claude $(claude --version 2>/dev/null | head -1)" \
  || no "claude не поставился. Вручную: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs && npm i -g @anthropic-ai/claude-code"

if ! command -v bun >/dev/null; then
  echo "   ставлю bun (на нём работают каналы)…"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || true
  export PATH="/root/.bun/bin:$PATH"
  grep -q '/root/.bun/bin' /root/.bashrc 2>/dev/null || echo 'export PATH="/root/.bun/bin:$PATH"' >> /root/.bashrc
fi
command -v bun >/dev/null && yes "bun $(bun --version 2>/dev/null)" \
  || no "bun не поставился. Вручную: curl -fsSL https://bun.sh/install | bash, потом выйти и зайти заново"
command -v systemctl >/dev/null && yes "systemd есть" || no "нет systemd — служба не поднимется"

MEM=$(free -m 2>/dev/null | awk '/Mem:/{print $7}') || true
[ "${MEM:-0}" -ge 400 ] && yes "свободно памяти: ${MEM} МБ" \
  || no "мало памяти (${MEM} МБ): одна сессия агента занимает 190–300 МБ"
DISK=$(df -m / 2>/dev/null | awk 'NR==2{print $4}') || true
[ "${DISK:-0}" -ge 2000 ] && yes "свободно на диске: $((DISK/1024)) ГБ" || no "мало места на диске"

echo "2. Токен подписки Claude"
if [ -s "$OAUTH_FILE" ]; then
  yes "токен подписки на месте ($OAUTH_FILE)"
else
  no "нет файла $OAUTH_FILE"
  echo "     На своём компьютере выполни: claude setup-token"
  echo "     Полученную строку положи на сервер:"
  echo "       read -s -p 'token: ' T; printf '%s' \"\$T\" > $OAUTH_FILE; chmod 600 $OAUTH_FILE; unset T"
  echo "     Это ТВОЙ токен: чужой класть нельзя — расход пойдёт на его владельца."
fi

echo "3. Канал-плагины"
if [ -d "${WORKDIR}/channels" ]; then
  mkdir -p /opt/channels-${SLUG}
  cp -r "${WORKDIR}/channels/." "/opt/channels-${SLUG}/"
  if claude plugin marketplace list 2>/dev/null | grep -q "$MKT"; then
    claude plugin marketplace update "$MKT" >/dev/null 2>&1 && yes "маркетплейс $MKT обновлён"
  else
    claude plugin marketplace add "/opt/channels-${SLUG}" >/dev/null 2>&1 \
      && yes "маркетплейс $MKT добавлен" || no "не смогла добавить маркетплейс — сделай вручную: claude plugin marketplace add /opt/channels-${SLUG}"
  fi
  for p in tg max; do
    [ -d "/opt/channels-${SLUG}/$p" ] || continue
    # Повторный запуск — нормальная ситуация: install при уже установленном вернёт 0,
    # а disable при уже выключенном вернёт 1. Поэтому смотрим не коды, а факт в списке.
    claude plugin install "$p@$MKT" >/dev/null 2>&1 || true
    claude plugin disable "$p@$MKT" >/dev/null 2>&1 || true
    if claude plugin list 2>/dev/null | grep -q "$p@$MKT"; then
      yes "канал $p установлен и выключен глобально (агент грузит его сам)"
    else
      no "канал $p не установился — проверь вручную: claude plugin install $p@$MKT"
    fi
  done
else
  no "нет папки ${WORKDIR}/channels — скопируй проект целиком"
fi

echo "4. Папки состояния и права доступа"
for d in tg max notify crm unused; do
  mkdir -p "/root/.claude/channels/${SLUG}-${d}" && chmod 700 "/root/.claude/channels/${SLUG}-${d}"
done
# Политика доступа: по умолчанию канал пускает только владельца, и клиент получил бы
# «передайте владельцу код» вместо ответа. Для клиентского бота нужен open.
for d in tg max; do
  A="/root/.claude/channels/${SLUG}-${d}/access.json"
  if [ ! -f "$A" ]; then
    printf '{\n  "dmPolicy": "open",\n  "allowFrom": [],\n  "groups": {}\n}\n' > "$A"
    chmod 600 "$A"
  fi
done
yes "папки состояния созданы, access.json с политикой open — бот пускает клиентов"
yes "токены кладёшь ты: клиентский бот, бот оповещений (см. справочник «Каналы»)"

echo "5. Служба"
if [ -f "${WORKDIR}/systemd/${SLUG}-channels.service" ]; then
  install -m 644 "${WORKDIR}/systemd/${SLUG}-channels.service" "/etc/systemd/system/${SLUG}-channels.service"
  systemctl daemon-reload
  systemctl enable "${SLUG}-channels.service" >/dev/null 2>&1
  yes "служба ${SLUG}-channels установлена (не запущена — запустим после токенов)"
  if [ -f "${WORKDIR}/systemd/${SLUG}-cleanup.timer" ]; then
    install -m 644 "${WORKDIR}/systemd/${SLUG}-cleanup.service" "/etc/systemd/system/${SLUG}-cleanup.service"
    install -m 644 "${WORKDIR}/systemd/${SLUG}-cleanup.timer" "/etc/systemd/system/${SLUG}-cleanup.timer"
    systemctl daemon-reload
    systemctl enable --now "${SLUG}-cleanup.timer" >/dev/null 2>&1 \
      && yes "ежедневная чистка вложений клиентов включена (срок хранения 90 дней)" \
      || no "таймер чистки не включился: systemctl enable --now ${SLUG}-cleanup.timer"
  fi
else
  no "нет файла службы ${WORKDIR}/systemd/${SLUG}-channels.service"
fi

mkdir -p "${WORKDIR}/memory" "${WORKDIR}/logs"
chmod +x "${WORKDIR}"/bin/*.sh "${WORKDIR}"/bin/*.py 2>/dev/null || true

echo
echo "Итого: ✅ $ok, ❌ $bad"
if [ $bad -eq 0 ]; then
  echo "Сервер готов. Дальше: положить токен бота и запустить службу."
else
  echo "Сначала закрой красные строки — без них агент не поднимется."
  exit 1
fi

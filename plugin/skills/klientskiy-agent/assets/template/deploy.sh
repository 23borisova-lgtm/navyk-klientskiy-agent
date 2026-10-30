#!/usr/bin/env bash
# Выкатить агента на сервер с мака: bash deploy.sh [--no-restart]
# Токены на сервере не трогаются: они лежат в /root/.claude/channels/__SLUG__-*/.env
set -euo pipefail

SERVER="${SERVER:-__SERVER__}"
KEY="${KEY:-__SSH_KEY__}"
REMOTE="/opt/__SLUG__"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Незаполненная база — главная причина, по которой агент начинает выдумывать.
# Проверяем базу знаний и персону. eval.json сюда не входит: двадцать вопросов
# приёмки пишутся позже, перед тестом, и не должны блокировать первый выкат.
BASE_FILES=$(ls "$HERE"/knowledge/*.md 2>/dev/null) || true
if grep -lE "ЗАПОЛНИТЬ|\{\{[А-ЯЁA-Z_0-9]+\}\}" $BASE_FILES "$HERE/CLAUDE.md" 2>/dev/null | grep -q .; then
  echo "СТОП: в базе знаний остались незаполненные места — агент начнёт выдумывать. Заполни:"
  grep -nE "ЗАПОЛНИТЬ|\{\{[А-ЯЁA-Z_0-9]+\}\}" $BASE_FILES "$HERE/CLAUDE.md" 2>/dev/null | sed 's/^/  /'
  exit 1
fi
if grep -qE "\{\{[А-ЯЁA-Z_0-9]+\}\}" "$HERE/knowledge/eval.json" 2>/dev/null; then
  echo "Напоминание: в knowledge/eval.json ещё остались метки — вопросы приёмки не дописаны."
  echo "Выкатываю, но на людей не выпускай, пока тест не пройден."
fi

echo "→ копирую проект на $SERVER:$REMOTE"
rsync -az --delete \
  --exclude '.git' --exclude 'memory/' --exclude 'logs/' --exclude '.DS_Store' \
  -e "ssh -i $KEY" "$HERE/" "$SERVER:$REMOTE/"

echo "→ права, папки, служба"
ssh -i "$KEY" "$SERVER" bash -s <<'REMOTE_CMDS'
set -euo pipefail
chmod +x /opt/__SLUG__/bin/*.sh /opt/__SLUG__/bin/*.py
mkdir -p /opt/__SLUG__/{memory,logs}
# Каналы живут отдельной папкой — иначе правка канала не доезжает до работающего бота.
if [ -d /opt/__SLUG__/channels ]; then
  mkdir -p /opt/channels-__SLUG__
  cp -r /opt/__SLUG__/channels/. /opt/channels-__SLUG__/
  claude plugin marketplace update __MKT_NAME__ >/dev/null 2>&1 || true
fi
install -m 644 /opt/__SLUG__/systemd/__SLUG__-channels.service \
  /etc/systemd/system/__SLUG__-channels.service
systemctl daemon-reload
systemctl enable __SLUG__-channels.service >/dev/null
REMOTE_CMDS

# Первый выкат на чистый сервер: службы ещё нет, запускать нечего.
FIRST_RUN=no
ssh -i "$KEY" "$SERVER" "test -f /etc/systemd/system/__SLUG__-channels.service" 2>/dev/null || FIRST_RUN=yes
if [[ "$FIRST_RUN" == "yes" ]]; then
  echo
  echo "Это первый выкат: на сервере ещё нет службы. Запускать нечего — и это не поломка."
  echo "Дальше по порядку:"
  echo "  1) ssh -i $KEY $SERVER \"bash /opt/__SLUG__/bin/install-server.sh\""
  echo "  2) положить токены ботов (см. справочник «Каналы»)"
  echo "  3) ещё раз: bash deploy.sh — он запустит службу и прогонит проверки"
  exit 0
fi

if [[ "${1:-}" != "--no-restart" ]]; then
  echo "→ перезапускаю службу"
  # Упавший рестарт не должен прятать проверки: они и объяснят, чего не хватает.
  ssh -i "$KEY" "$SERVER" "systemctl restart __SLUG__-channels.service; sleep 12; systemctl is-active __SLUG__-channels.service" || true
  echo "→ проверки"
  ssh -i "$KEY" "$SERVER" "bash /opt/__SLUG__/bin/check.sh" || true
fi
echo "Готово. Живой ответ в мессенджере всё равно проверь руками — это единственное «работает»."

#!/usr/bin/env bash
# Проверки клиентского агента __BIZ__. Запускать на сервере: bash /opt/__SLUG__/bin/check.sh
# Ничего не меняет. Токены не печатает.
TG_DIR="/root/.claude/channels/__SLUG__-tg"
MAX_DIR="/root/.claude/channels/__SLUG__-max"
SERVICE="__SLUG__-channels"
ok=0; bad=0
yes() { echo "  ✅ $*"; ok=$((ok+1)); }
no()  { echo "  ❌ $*"; bad=$((bad+1)); }

echo "0. Токен подписки"
if [[ -s "__OAUTH_FILE__" ]]; then yes "токен подписки на месте"; else no "нет __OAUTH_FILE__ — служба поднимется, а агент будет молчать"; fi

echo "1. Токены ботов"
if [[ -s "${TG_DIR}/.env" ]]; then
  T=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "${TG_DIR}/.env" | cut -d= -f2-)
  R=$(curl -s --max-time 15 "https://api.telegram.org/bot${T}/getMe")
  if grep -q '"ok":true' <<<"$R"; then yes "Telegram: @$(sed -n 's/.*"username":"\([^"]*\)".*/\1/p' <<<"$R")"
  else no "Telegram: токен не отвечает — $(head -c 120 <<<"$R")"; fi
else echo "  — Telegram: токена нет, канал выключен"; fi
if [[ -s "${MAX_DIR}/.env" ]]; then
  M=$(grep -m1 '^MAX_BOT_TOKEN=' "${MAX_DIR}/.env" | cut -d= -f2-)
  # ВАЖНО: без корня Минцифры curl к platform-api2 возвращает пустоту и http=000,
  # и живой токен выглядит мёртвым. Проверено 28.10.2026 на помощнике мамы:
  # без --cacert «МЁРТВ», с --cacert — 200 и бот отвечает людям.
  if [[ -s "${MAX_DIR}/ca.pem" ]]; then
    yes "MAX: корень Минцифры на месте"
    R=$(curl -s --max-time 15 --cacert "${MAX_DIR}/ca.pem" -H "Authorization: ${M}" https://platform-api2.max.ru/me)
    if grep -q '"user_id"' <<<"$R"; then yes "MAX: $(sed -n 's/.*"username":"\([^"]*\)".*/\1/p' <<<"$R")"
    else no "MAX: токен не отвечает — $(head -c 120 <<<"$R")"; fi
  else
    no "MAX: нет ${MAX_DIR}/ca.pem — плагин не доверится API, и токен проверить нечем"
  fi
else echo "  — MAX: токена нет, канал выключен"; fi

echo "2. Служба"
[[ "$(systemctl is-active ${SERVICE} 2>/dev/null)" == "active" ]] && yes "${SERVICE} active" || no "${SERVICE} не active"
tmux -L __SLUG__-ccc has-session -t channels 2>/dev/null && yes "сессия в tmux жива" || no "сессии в tmux нет"

echo "3. Мост до мессенджеров (самая частая причина «агент молчит»)"
if [[ -s "${TG_DIR}/.env" ]]; then
  pgrep -af "bun run --cwd /opt/channels-__SLUG__/tg" >/dev/null && yes "процесс телеграм-канала есть" || no "процесса телеграм-канала нет → restart"
  [[ -s "${TG_DIR}/bot.pid" ]] && yes "bot.pid в ${TG_DIR}" || no "нет bot.pid в ${TG_DIR}"
  P=$(python3 -c "import json;print(json.load(open('${TG_DIR}/access.json')).get('dmPolicy','?'))" 2>/dev/null)
  [[ "$P" == "open" ]] && yes "Telegram: dmPolicy=open — клиентов пускает" || no "Telegram: dmPolicy=$P — клиент получит код вместо ответа, нужен open"
  L=$(ls -t /root/.cache/claude-cli-nodejs/-opt-__SLUG__/mcp-logs-plugin-tg-tg/* 2>/dev/null | head -1)
  if [[ -n "$L" ]]; then
    grep -q "not on the approved channels allowlist" "$L" && no "в MCP-логе TG «not on the approved channels allowlist» — входящие выбрасываются" || yes "MCP-лог TG без отказов allowlist"
  fi
fi
if [[ -s "${MAX_DIR}/.env" ]]; then
  pgrep -af "bun run --cwd /opt/channels-__SLUG__/max" >/dev/null && yes "процесс MAX-плагина есть" || no "процесса MAX-плагина нет → restart"
  [[ -s "${MAX_DIR}/bot.pid" ]] && yes "bot.pid в ${MAX_DIR}" || no "нет bot.pid в ${MAX_DIR}"
  PM=$(python3 -c "import json;print(json.load(open('${MAX_DIR}/access.json')).get('dmPolicy','?'))" 2>/dev/null)
  [[ "$PM" == "open" ]] && yes "MAX: dmPolicy=open — клиентов пускает" || no "MAX: dmPolicy=$PM — клиент получит код вместо ответа, нужен open"
  L=$(ls -t /root/.cache/claude-cli-nodejs/-opt-__SLUG__/mcp-logs-plugin-max-max/* 2>/dev/null | head -1)
  if [[ -n "$L" ]]; then
    grep -q "not on the approved channels allowlist" "$L" && no "в MCP-логе «not on the approved channels allowlist» — входящие выбрасываются" || yes "MCP-лог MAX без отказов allowlist"
  fi
fi

echo "4. Права агента"
if [[ -s /opt/__SLUG__/.claude/settings.json ]]; then
  grep -q "plugin_tg_tg__reply" /opt/__SLUG__/.claude/settings.json && yes "права на ответ в Telegram есть" || no "в .claude/settings.json нет mcp__plugin_tg_tg__reply — агент не сможет ответить"
  grep -q "notify.py" /opt/__SLUG__/.claude/settings.json && yes "права на оповещение есть" || no "в правах нет notify.py — «передам» не дойдёт"
else
  no "нет /opt/__SLUG__/.claude/settings.json — служба будет зелёной, а агент молча не ответит"
fi

echo "5. База знаний и персона"
for f in CLAUDE.md knowledge/01-кто-мы.md knowledge/03-цены.md knowledge/05-стоп-темы.md knowledge/07-воронка.md; do
  [[ -s "/opt/__SLUG__/$f" ]] && yes "$f" || no "нет $f"
done
grep -qE "\{\{[А-ЯЁA-Z_0-9]+\}\}" /opt/__SLUG__/knowledge/*.md 2>/dev/null && no "в базе знаний остались незаполненные метки — агент начнёт выдумывать"
grep -qE '^\|.*\| *да *\|' /opt/__SLUG__/knowledge/03-цены.md 2>/dev/null && yes "в 03-цены.md есть подтверждённые цены" || no "в 03-цены.md ни одной цены со «да» — агент не назовёт ни одной цифры"

echo "6. Оповещения владельцу"
# Живое сообщение владельцу шлём только по просьбе: иначе он получает «проверка»
# на каждый деплой. Без флага проверяем, что настройки на месте.
if [[ "${1:-}" == "--with-notify" ]]; then
  out=$(python3 /opt/__SLUG__/bin/notify.py --test 2>&1)
  [[ "$out" == "отправлено" ]] && yes "тестовое оповещение ушло владельцу" || no "оповещение не ушло: $out"
else
  N=/root/.claude/channels/__SLUG__-notify/.env
  if [[ -s "$N" ]] && grep -q NOTIFY_TG_TOKEN "$N" && grep -q NOTIFY_TG_CHAT "$N"; then
    yes "настройки оповещений на месте (живую проверку даёт: check.sh --with-notify)"
  else
    no "нет $N с NOTIFY_TG_TOKEN и NOTIFY_TG_CHAT — «передам владельцу» никуда не дойдёт"
  fi
fi

echo
echo "Итого: ✅ $ok, ❌ $bad"
if [[ $bad -eq 0 ]]; then
  echo "Красных нет. «Работает» — только когда ещё и живой ответ в мессенджере получен."
else
  echo "Есть красные строки — агент в таком виде работать не будет."
  exit 1
fi

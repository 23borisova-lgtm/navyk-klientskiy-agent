#!/usr/bin/env bash
# Чистка вложений клиентов старше срока хранения. Ставится таймером (раз в сутки).
#   bash /opt/__SLUG__/bin/cleanup-inbox.sh [дней]
# По умолчанию 90 дней: столько обычно держат переписку. Свой срок — ваше решение,
# но он должен быть назван в согласии на обработку данных.
set -euo pipefail
DAYS="${1:-${INBOX_KEEP_DAYS:-90}}"
SLUG="__SLUG__"
total=0
for ch in tg max; do
  D="/root/.claude/channels/${SLUG}-${ch}/inbox"
  [ -d "$D" ] || continue
  n=$(find "$D" -type f -mtime "+${DAYS}" | wc -l | tr -d ' ')
  if [ "$n" -gt 0 ]; then
    find "$D" -type f -mtime "+${DAYS}" -delete
    echo "$(date -Iseconds) удалено из ${ch}: ${n} файлов старше ${DAYS} дней"
    total=$((total+n))
  fi
done
[ "$total" -gt 0 ] || echo "$(date -Iseconds) чистить нечего: файлов старше ${DAYS} дней нет"

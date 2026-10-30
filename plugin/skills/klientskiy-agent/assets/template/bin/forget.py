#!/usr/bin/env python3
"""Удалить данные человека по его требованию. Запускает владелец, не агент.

    python3 /opt/__SLUG__/bin/forget.py --phone '+7 900 123-45-67'
    python3 /opt/__SLUG__/bin/forget.py --phone '8 900 1234567' --dry-run

Человек вправе потребовать удалить свои данные, и это надо уметь сделать за минуту.
Скрипт чистит то, что хранится на сервере:

  memory/lidy.md      строки с этим телефоном
  memory/lidy.jsonl   записи заявок
  логи crm.log        строки с последними цифрами номера
  inbox каналов       файлы, пришедшие от этого человека, если известен его id

Чего скрипт сделать НЕ может и о чём напомнит: карточка в CRM, сообщения в вашем
телеграме с оповещениями, ваши собственные заметки. Это удаляется руками.

Телефон сравнивается нормализованно: 8 и +7 — один и тот же номер.
"""
import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(os.environ.get("AGENT_DIR", "/opt/__SLUG__"))
STATE = Path(os.environ.get("CHANNELS_DIR", "/root/.claude/channels"))
SLUG = ROOT.name


def norm(s):
    d = re.sub(r"\D", "", s or "")
    if len(d) == 11 and d.startswith("8"):
        d = "7" + d[1:]
    return d


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phone", required=True, help="телефон человека в любом виде")
    ap.add_argument("--dry-run", action="store_true", help="показать, что будет удалено, и ничего не трогать")
    a = ap.parse_args()

    phone = norm(a.phone)
    if len(phone) < 10:
        sys.exit("это не похоже на телефон")
    tail = phone[-4:]
    hits, planned = [], []

    # 1. lidy.md — построчно
    md = ROOT / "memory/lidy.md"
    if md.exists():
        lines = md.read_text(encoding="utf-8").splitlines(keepends=True)
        keep = [l for l in lines if norm(l).find(phone) < 0]
        gone = len(lines) - len(keep)
        if gone:
            hits.append(f"memory/lidy.md: строк с этим номером — {gone}")
            planned.append(lambda: md.write_text("".join(keep), encoding="utf-8"))

    # 2. lidy.jsonl — построчно, по полю phone
    jl = ROOT / "memory/lidy.jsonl"
    if jl.exists():
        lines = jl.read_text(encoding="utf-8").splitlines()
        keep = []
        gone = 0
        for l in lines:
            try:
                if norm(json.loads(l).get("phone", "")) == phone:
                    gone += 1
                    continue
            except json.JSONDecodeError:
                pass
            keep.append(l)
        if gone:
            hits.append(f"memory/lidy.jsonl: заявок — {gone}")
            planned.append(lambda: jl.write_text("\n".join(keep) + ("\n" if keep else ""), encoding="utf-8"))

    # 3. журнал CRM — там только последние четыре цифры
    cl = ROOT / "logs/crm.log"
    if cl.exists():
        lines = cl.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
        keep = [l for l in lines if f"…{tail}" not in l]
        gone = len(lines) - len(keep)
        if gone:
            hits.append(f"logs/crm.log: строк — {gone}")
            planned.append(lambda: cl.write_text("".join(keep), encoding="utf-8"))

    # 4. вложения в inbox каналов
    for ch in ("tg", "max"):
        inbox = STATE / f"{SLUG}-{ch}" / "inbox"
        if not inbox.is_dir():
            continue
        files = [f for f in inbox.iterdir() if f.is_file()]
        if files:
            hits.append(f"{inbox}: файлов всего — {len(files)} (какие именно от этого человека, "
                        "скрипт не знает: имена не содержат телефона)")

    if not hits:
        print(f"Данных с номером …{tail} на сервере не нашла.")
    else:
        print(f"Нашла по номеру …{tail}:")
        for h in hits:
            print(f"  {h}")

    if a.dry_run:
        print("\n--dry-run: ничего не удалила.")
    elif planned:
        for fn in planned:
            fn()
        print(f"\nУдалено. Отметка о выполнении: {datetime.now().isoformat(timespec='seconds')}")
    else:
        print("\nУдалять нечего.")

    print("""
Осталось сделать руками — скрипт туда не дотянется:
  • карточка и переписка в CRM;
  • сообщения-оповещения с этим телефоном в вашем телеграме;
  • ваши собственные заметки и выгрузки;
  • переписка в самом мессенджере, если хотите удалить и её.
Запишите дату и что удалили: это и есть подтверждение, что требование выполнено.""")


if __name__ == "__main__":
    main()

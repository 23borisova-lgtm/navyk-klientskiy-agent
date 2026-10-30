#!/usr/bin/env python3
"""Собрать шаблон навыка из рабочего агента ~/Documents/iimpuls-klient.

    SRC_SERVER=root@1.2.3.4 SRC_SSH_KEY=~/.ssh/my_key python3 tools/build_template.py

Переносит скрипты и служебные файлы, заменяя всё, что относится к конкретной
установке, на метки. Персона и база знаний НЕ переносятся: там факты и цены
владельца, у ученицы они свои — для них в шаблоне лежат заготовки с вопросами.

Метки, которые подставляет scripts/new_agent.py:
    __SLUG__        короткое имя агента (папка /opt/<slug>, служба <slug>-channels)
    __SERVER__      root@IP сервера ученицы
    __SSH_KEY__     путь к её ssh-ключу
    __OAUTH_FILE__  файл с токеном её подписки Claude на сервере
    __MKT_NAME__    имя локального маркетплейса каналов
    __MODEL__       модель (opus для Max, sonnet для Pro)
    __BIZ__         название бизнеса ученицы
"""
import os
import pathlib
import re
import shutil
import sys

# Адрес рабочего сервера и ключ не хранятся в репозитории: задаются переменными
# окружения при запуске. Иначе они уедут в публичный репозиторий вместе с навыком.
SRC_SERVER = os.environ.get("SRC_SERVER", "")      # например root@1.2.3.4
SRC_KEY = os.environ.get("SRC_SSH_KEY", "")        # например ~/.ssh/my_key

SRC = pathlib.Path(os.environ.get("SRC_AGENT", "~/Documents/iimpuls-klient")).expanduser()
DST = pathlib.Path(__file__).resolve().parent.parent / "plugin/skills/klientskiy-agent/assets/template"

# install-server.sh и .claude/settings.json живут только в шаблоне: в рабочем агенте
# их аналоги привязаны к конкретной установке. Правим их прямо в assets/template.
FILES = [
    "bin/notify.py",
    "bin/crm_lead.py",
    "bin/check.sh",
    "bin/start-channels.sh",
    "deploy.sh",
    "systemd/iimpuls-klient-channels.service",
]

# Порядок важен: сначала длинные строки.
SUBST = [
    ("/root/.claude/.sova-year-token", "__OAUTH_FILE__"),
    *( [(SRC_SERVER, "__SERVER__"), (SRC_SERVER.split("@")[-1], "__SERVER_IP__")] if SRC_SERVER else [] ),
    *( [(SRC_KEY, "__SSH_KEY__"), (SRC_KEY.replace("~", "$HOME"), "__SSH_KEY__")] if SRC_KEY else [] ),
    ("iimpuls-klient", "__SLUG__"),
    ("iimpuls-tg", "__SLUG__-tg"),
    ("iimpuls-max", "__SLUG__-max"),
    ("iimpuls-vk", "__SLUG__-vk"),
    ("iimpuls-notify", "__SLUG__-notify"),
    ("iimpuls-crm", "__SLUG__-crm"),
    ("iimpuls-unused", "__SLUG__-unused"),
    ("claude-plugins-trikita", "__MKT_NAME__"),
    ("trikita-local", "__MKT_NAME__"),
    ("--model opus", "--model __MODEL__"),
    ("ИИмпульс", "__BIZ__"),
    ("Кате", "владельцу"),
    ("Катя", "владелец"),
    ("Кати", "владельца"),
]


def main():
    if not SRC.exists():
        sys.exit(f"нет рабочего агента: {SRC}")
    moved = []
    for rel in FILES:
        src = SRC / rel
        if not src.exists():
            print(f"  пропускаю (нет файла): {rel}")
            continue
        text = src.read_text(encoding="utf-8")
        for a, b in SUBST:
            text = text.replace(a, b)
        out_rel = rel.replace("iimpuls-klient", "__SLUG__")
        out = DST / out_rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        out.chmod(0o755 if out.suffix in (".sh", ".py") else 0o644)
        moved.append(out_rel)
        left = sorted(set(re.findall(r"иимпульс|иммпульс|трикита|katrina|trikita|iimpuls|\d+\.\d+\.\d+\.\d+", text, re.I)))
        if left:
            print(f"  ⚠ в {out_rel} осталось: {', '.join(left)}")
    print(f"перенесено файлов: {len(moved)}")
    for m in moved:
        print(f"  {m}")


if __name__ == "__main__":
    main()

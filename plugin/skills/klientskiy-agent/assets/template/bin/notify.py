#!/usr/bin/env python3
"""Оповещения владельцу из клиентского агента __BIZ__.

    notify.py --lead   '<канал>' '<кто>' '<что нужно>'
    notify.py --urgent '<канал>' '<кто>' '<что случилось>'
    notify.py --test

Настройки читаются из файла, путь в NOTIFY_ENV (по умолчанию
/root/.claude/channels/__SLUG__-notify/.env):

    NOTIFY_TG_TOKEN=<токен бота, от которого приходят оповещения>
    NOTIFY_TG_CHAT=<chat_id владельца>

Печатает «отправлено» или «не отправлено: <причина>». Код выхода 0 только если ушло.
Токен нигде не печатается.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

ENV_PATH = os.environ.get("NOTIFY_ENV", "/root/.claude/channels/__SLUG__-notify/.env")
LOG_PATH = os.environ.get("NOTIFY_LOG", "/opt/__SLUG__/logs/notify.log")
KINDS = {"--lead": "🔥 ЛИД", "--urgent": "❗ СРОЧНО", "--new": "🔔 новый диалог"}


def read_env(path):
    data = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    data[k.strip()] = v.strip().strip('"').strip("'")
    except OSError as e:
        return None, f"нет настроек {path} ({e.strerror})"
    if not data.get("NOTIFY_TG_TOKEN") or not data.get("NOTIFY_TG_CHAT"):
        return None, f"в {path} нет NOTIFY_TG_TOKEN или NOTIFY_TG_CHAT"
    return data, None


def log(line):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now().isoformat(timespec='seconds')} {line}\n")
    except OSError:
        pass


def send(token, chat, text):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    body = urllib.parse.urlencode({"chat_id": chat, "text": text,
                                   "disable_web_page_preview": "true"}).encode()
    req = urllib.request.Request(url, data=body)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.load(resp).get("ok") is True, ""
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.load(e).get("description", "")
        except Exception:
            detail = f"HTTP {e.code}"
        return False, detail
    except Exception as e:  # сеть, таймаут, TLS
        return False, type(e).__name__


def main():
    args = sys.argv[1:]
    if not args or args[0] not in KINDS and args[0] != "--test":
        sys.exit(__doc__)

    env, err = read_env(ENV_PATH)
    if err:
        print(f"не отправлено: {err}")
        log(f"FAIL {err}")
        sys.exit(1)

    if args[0] == "--test":
        text = "Проверка оповещений: помощник __BIZ__ на связи."
    else:
        if len(args) < 4:
            sys.exit("нужно: --lead|--urgent '<канал>' '<кто>' '<что>'")
        kind, channel, who, what = KINDS[args[0]], args[1], args[2], " ".join(args[3:])
        stamp = datetime.now().strftime("%d.%m %H:%M")
        text = f"{kind} · {channel} · {stamp}\n{who}\n{what}"

    ok, detail = send(env["NOTIFY_TG_TOKEN"], env["NOTIFY_TG_CHAT"], text[:3900])
    if ok:
        print("отправлено")
        log(f"OK {text.splitlines()[0]}")
    else:
        print(f"не отправлено: {detail}")
        log(f"FAIL {detail} | {text.splitlines()[0]}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

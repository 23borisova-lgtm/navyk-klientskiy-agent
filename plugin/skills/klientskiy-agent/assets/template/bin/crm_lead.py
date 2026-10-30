#!/usr/bin/env python3
"""Передать лид из агента в CRM. Только создание — агент ничего не меняет и не удаляет.

    crm_lead.py --name 'Марина' --phone '+79001234567' \
                --what 'детский центр в Пензе, хочет бота для родителей' \
                --channel telegram --source storis_28_10 [--dry-run]

Куда уходит лид — решает CRM_KIND в файле настроек (путь в CRM_ENV, по умолчанию
/root/.claude/channels/__SLUG__-crm/.env):

    CRM_KIND=alfacrm          АльфаCRM: карточка customer с is_study=0
      ALFACRM_HOST=mycenter.s20.online
      ALFACRM_EMAIL=...
      ALFACRM_API_KEY=...
      ALFACRM_BRANCH=1
      ALFACRM_LEAD_SOURCE_ID=      необязательно: id источника заявки в CRM

    CRM_KIND=webhook          любая CRM, Google-таблица через Apps Script, amoCRM, Битрикс
      CRM_WEBHOOK_URL=https://...
      CRM_WEBHOOK_SECRET=       необязательно: уходит заголовком X-Lead-Secret

    CRM_KIND=file             никуда не ходим, пишем в файл (значение по умолчанию)
      CRM_FILE=/opt/__SLUG__/memory/lidy.jsonl

Печатает «лид создан: <id|файл>» или «лид НЕ создан: <причина>». Код выхода 0 только если создан.
Повтор того же телефона в течение CRM_DEDUP_HOURS (по умолчанию 48) не создаёт второй лид.
Ключи и токены не печатаются никогда.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ENV_PATH = os.environ.get("CRM_ENV", "/root/.claude/channels/__SLUG__-crm/.env")
STATE_PATH = os.environ.get("CRM_STATE", "/root/.claude/channels/__SLUG__-crm/sent.json")
LOG_PATH = os.environ.get("CRM_LOG", "/opt/__SLUG__/logs/crm.log")
TIMEOUT = 25


def read_env(path):
    data = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    data[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    for k, v in os.environ.items():          # окружение сильнее файла
        if k.startswith(("CRM_", "ALFACRM_")):
            data[k] = v
    return data


def log(line):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now().isoformat(timespec='seconds')} {line}\n")
    except OSError:
        pass


def norm_phone(s):
    """Только цифры, 8 в начале → 7: один человек не должен стать двумя лидами."""
    d = re.sub(r"\D", "", s or "")
    if len(d) == 11 and d.startswith("8"):
        d = "7" + d[1:]
    return d


def recently_sent(phone, hours):
    if not phone:
        return False
    try:
        state = json.load(open(STATE_PATH, encoding="utf-8"))
    except Exception:
        return False
    ts = state.get(phone)
    return bool(ts) and (time.time() - ts) < hours * 3600


def remember(phone):
    if not phone:
        return
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        try:
            state = json.load(open(STATE_PATH, encoding="utf-8"))
        except Exception:
            state = {}
        cutoff = time.time() - 30 * 24 * 3600
        state = {k: v for k, v in state.items() if v > cutoff}
        state[phone] = time.time()
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        os.replace(tmp, STATE_PATH)
        os.chmod(STATE_PATH, 0o600)
    except OSError:
        pass


def post(url, payload, headers, label):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return json.loads(raw) if raw else {}, None
            except json.JSONDecodeError:
                return {}, None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200] if e.fp else ""
        return None, f"{label} ответил {e.code}: {detail or e.reason}"
    except Exception as e:
        return None, f"{label}: {type(e).__name__}"


def to_alfacrm(env, lead):
    host = env.get("ALFACRM_HOST", "").strip().rstrip("/")
    email, key = env.get("ALFACRM_EMAIL"), env.get("ALFACRM_API_KEY")
    branch = env.get("ALFACRM_BRANCH", "1")
    if not (host and email and key):
        return None, "в настройках нет ALFACRM_HOST, ALFACRM_EMAIL или ALFACRM_API_KEY"
    base = host if host.startswith("http") else f"https://{host}"
    auth, errm = post(f"{base}/v2api/auth/login", {"email": email, "api_key": key}, {}, "АльфаCRM (вход)")
    if errm:
        return None, errm
    token = (auth or {}).get("token")
    if not token:
        return None, "АльфаCRM не выдала токен: проверь email и api_key"
    body = {"name": lead["name"], "is_study": 0}
    if lead["phone"]:
        body["phone"] = [lead["phone"]]
    note = lead["note"]
    if note:
        body["note"] = note
    src = env.get("ALFACRM_LEAD_SOURCE_ID", "").strip()
    if src.isdigit():
        body["lead_source_id"] = int(src)
    res, errm = post(f"{base}/v2api/{branch}/customer/create", body,
                     {"X-ALFACRM-TOKEN": token}, "АльфаCRM (создание)")
    if errm:
        return None, errm
    cid = (res or {}).get("id") or ((res or {}).get("model") or {}).get("id")
    return f"АльфаCRM, карточка {cid or '?'}", None


def to_webhook(env, lead):
    url = env.get("CRM_WEBHOOK_URL", "").strip()
    if not url:
        return None, "в настройках нет CRM_WEBHOOK_URL"
    headers = {}
    secret = env.get("CRM_WEBHOOK_SECRET", "").strip()
    if secret:
        headers["X-Lead-Secret"] = secret
    _, errm = post(url, lead, headers, "вебхук")
    if errm:
        return None, errm
    return "вебхук принял", None


def to_file(env, lead):
    path = env.get("CRM_FILE", "/opt/__SLUG__/memory/lidy.jsonl")
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(lead, ensure_ascii=False) + "\n")
        os.chmod(path, 0o600)
    except OSError as e:
        return None, f"файл {path}: {e.strerror}"
    return path, None


SINKS = {"alfacrm": to_alfacrm, "webhook": to_webhook, "file": to_file}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="как зовут человека")
    ap.add_argument("--phone", default="", help="телефон, если дал")
    ap.add_argument("--what", default="", help="что за бизнес и чего хочет — одной-двумя строками")
    ap.add_argument("--channel", default="", help="telegram | max | vk | instagram")
    ap.add_argument("--source", default="", help="метка источника из ссылки (?start=...)")
    ap.add_argument("--dry-run", action="store_true", help="показать, что уйдёт, и ничего не создавать")
    a = ap.parse_args()

    env = read_env(ENV_PATH)
    kind = env.get("CRM_KIND", "file").strip().lower()
    if kind not in SINKS:
        print(f"лид НЕ создан: CRM_KIND={kind} не поддерживается (alfacrm, webhook, file)")
        sys.exit(1)

    phone = norm_phone(a.phone)
    note_bits = [a.what.strip()]
    if a.channel:
        note_bits.append(f"канал: {a.channel}")
    if a.source:
        note_bits.append(f"источник: {a.source}")
    note_bits.append("завёл ИИ-помощник")
    lead = {
        "name": a.name.strip()[:200],
        "phone": phone,
        "what": a.what.strip()[:1000],
        "channel": a.channel,
        "source": a.source,
        "note": ". ".join(b for b in note_bits if b)[:1000],
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    if a.dry_run:
        print(f"ушло бы в {kind}:")
        print(json.dumps(lead, ensure_ascii=False, indent=2))
        sys.exit(0)

    hours = int(env.get("CRM_DEDUP_HOURS", "48") or 48)
    if recently_sent(phone, hours):
        # Это не сбой: заявка уже есть. Агент не должен решить, что не получилось.
        print(f"лид уже заведён: этот телефон записан за последние {hours} ч, дубль не нужен")
        log(f"DUP {phone[-4:] if phone else '—'}")
        sys.exit(0)

    where, errm = SINKS[kind](env, lead)
    if errm:
        print(f"лид НЕ создан: {errm}")
        log(f"FAIL {kind} {errm}")
        sys.exit(1)
    remember(phone)
    print(f"лид создан: {where}")
    log(f"OK {kind} {where} тел …{phone[-4:] if phone else '—'}")
    sys.exit(0)


if __name__ == "__main__":
    main()

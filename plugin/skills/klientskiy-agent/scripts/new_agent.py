#!/usr/bin/env python3
"""Создать проект клиентского агента из шаблона навыка.

    python3 new_agent.py --slug lingva --biz "Лингва" --owner "Ирина" \
        --dir ~/Documents/lingva-agent --server root@1.2.3.4 --model sonnet \
        [--answers otvety.json] [--city Пенза]

--slug    короткое латинское имя: папка /opt/<slug>, служба <slug>-channels,
          папки состояния /root/.claude/channels/<slug>-tg и так далее.
--biz     название бизнеса, как его знают клиенты.
--owner   имя владельца в именительном; падежи считаются сами, можно задать
          --owner-r (кого) и --owner-d (кому).
--model   opus для подписки Max, sonnet для Pro. По умолчанию sonnet: на Pro
          Opus недоступен, и агент молча не поднимется.
--answers JSON с ответами на вопросы базы знаний: {"ГЛАВНЫЙ_ПРОДУКТ": "...", ...}.
          Что не заполнено — скрипт перечислит в конце, deploy.sh не выкатит проект,
          пока в файлах остаются метки {{…}}.

Инфраструктура (по умолчанию — сервер ученицы, который она укажет):
--server root@IP  --ssh-key ~/.ssh/id_ed25519  --oauth-file /root/.claude/.claude-token
--mkt-name local-channels
"""
import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
TEMPLATE = SKILL / "assets/template"
CHANNELS = SKILL / "assets/channels"
TEXT_EXT = {".md", ".sh", ".py", ".json", ".service", ".timer", ".txt", ".mjs", ".tmpl", ""}


def word_forms(w):
    """Падежи имени: (родительный, дательный). Женские на -а/-я, мужские на согласную."""
    if w.endswith("ия"):
        b = w[:-1]; return (b + "и", b + "и")
    if w.endswith("я"):
        b = w[:-1]; return (b + "и", b + "е")
    if w.endswith("а"):
        b = w[:-1]
        return (b + ("и" if b[-1:] in "гкхжчшщ" else "ы"), b + "е")
    if w.endswith("й"):
        b = w[:-1]; return (b + "я", b + "ю")
    if w[-1:].lower() in "бвгджзклмнпрстфхцчшщ":
        return (w + "а", w + "у")
    return (w, w)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--biz", required=True)
    ap.add_argument("--owner", required=True)
    ap.add_argument("--owner-r")
    ap.add_argument("--owner-d")
    ap.add_argument("--city", default="")
    ap.add_argument("--dir")
    ap.add_argument("--answers")
    ap.add_argument("--server", default="root@ЗАМЕНИ.IP")
    ap.add_argument("--ssh-key", default="~/.ssh/id_ed25519")
    ap.add_argument("--oauth-file", default="/root/.claude/.claude-token")
    ap.add_argument("--mkt-name", default="")   # по умолчанию channels-<slug>: один маркетплейс на проект
    ap.add_argument("--model", default="sonnet", choices=["sonnet", "opus", "haiku"])
    ap.add_argument("--agent-name", default="")
    a = ap.parse_args()

    if not a.biz.strip() or not a.owner.strip():
        sys.exit("--biz и --owner не могут быть пустыми: они попадают в персону и в карточку бота")
    if not a.mkt_name:
        a.mkt_name = f"channels-{a.slug}"
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,20}", a.slug):
        sys.exit("--slug: латиница в нижнем регистре, цифры и дефис, 2–21 символ (например, lingva)")
    out = Path(os.path.expanduser(a.dir or f"~/Documents/{a.slug}-agent"))
    if out.exists() and any(out.iterdir()):
        sys.exit(f"{out} уже существует и не пустая — выбери другую папку")
    if not TEMPLATE.exists():
        sys.exit(f"нет шаблона: {TEMPLATE}")

    r, d = word_forms(a.owner)
    answers = json.load(open(os.path.expanduser(a.answers), encoding="utf-8")) if a.answers else {}

    subst = {
        "__SLUG__": a.slug,
        "__BIZ__": a.biz,
        "__SERVER__": a.server,
        "__SERVER_IP__": a.server.split("@")[-1],
        "__SSH_KEY__": a.ssh_key,
        "__OAUTH_FILE__": a.oauth_file,
        "__MKT_NAME__": a.mkt_name,
        "__MODEL__": a.model,
        "__OWNER__": a.owner,
        "{{БИЗНЕС}}": a.biz,
        "{{ВЛАДЕЛЕЦ}}": a.owner,
        "{{ВЛАДЕЛЕЦ_Р}}": a.owner_r or r,
        "{{ВЛАДЕЛЕЦ_Д}}": a.owner_d or d,
        "{{ГОРОД}}": a.city or "{{ГОРОД}}",
        "{{ГОРОД_ФРАЗА}}": f" ({a.city})" if a.city else "",
        "{{ИМЯ_АГЕНТА}}": a.agent_name or f"Помощник {a.biz}",
        "{{ОБРАЩЕНИЕ}}": answers.get("ОБРАЩЕНИЕ", "на «вы»"),
    }
    for k, v in answers.items():
        subst.setdefault("{{%s}}" % k, str(v))

    def fill(text, as_json=False):
        for k, v in subst.items():
            # В .json подставляем экранированно: кавычка в названии бизнеса ломала файл
            # маркетплейса, каналы не ставились, и бот не принимал ни одного сообщения.
            text = text.replace(k, json.dumps(v)[1:-1] if as_json else v)
        return text

    # --- копируем шаблон ---
    out.mkdir(parents=True, exist_ok=True)
    for src in sorted(TEMPLATE.rglob("*")):
        rel = src.relative_to(TEMPLATE)
        name = fill(str(rel)).replace(".tmpl", "")
        dst = out / name
        if src.is_dir():
            dst.mkdir(parents=True, exist_ok=True)
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.suffix in TEXT_EXT:
            dst.write_text(fill(src.read_text(encoding="utf-8"), dst.suffix == ".json"), encoding="utf-8")
        else:
            shutil.copy2(src, dst)
        if dst.suffix in (".sh", ".py"):
            dst.chmod(0o755)

    # --- каналы кладём внутрь проекта: без них бот не примет ни одного сообщения ---
    ch_out = out / "channels"
    shutil.copytree(CHANNELS, ch_out, ignore=shutil.ignore_patterns("node_modules", "*.bak.*"))
    mkt = ch_out / ".claude-plugin"
    mkt.mkdir(exist_ok=True)
    src_mkt = ch_out / ".claude-plugin-marketplace.json"
    if src_mkt.exists():
        (mkt / "marketplace.json").write_text(fill(src_mkt.read_text(encoding="utf-8"), True), encoding="utf-8")
        src_mkt.unlink()
    # README каналов тоже с метками — иначе ученица скопирует команду с __MKT_NAME__
    for md in ch_out.glob("*.md"):
        md.write_text(fill(md.read_text(encoding="utf-8")), encoding="utf-8")

    for extra in ("memory", "logs"):
        (out / extra).mkdir(exist_ok=True)
    (out / "memory/README.md").write_text(
        "# Память агента\n\nЗаполняется агентом на сервере: диалоги, вопросы без ответа, лиды.\n"
        "В репозиторий не попадает — там персональные данные клиентов.\n", encoding="utf-8")
    (out / ".gitignore").write_text("logs/\nmemory/*\n!memory/README.md\n.DS_Store\n__pycache__/\n", encoding="utf-8")

    # --- json должны остаться читаемыми ---
    for j in sorted(out.rglob("*.json")):
        if "node_modules" in str(j):
            continue
        try:
            json.loads(re.sub(r"\{\{[^}]+\}\}", "X", j.read_text(encoding="utf-8")))
        except json.JSONDecodeError as e:
            sys.exit(f"сломан {j.relative_to(out)}: {e}\nСкорее всего в ответах была кавычка — уберите её и повторите")

    # --- что осталось заполнить ---
    left = {}
    for f in sorted(out.rglob("*")):
        if f.is_file() and f.suffix in {".md", ".json", ".sh", ".py"}:
            try:
                for m in re.findall(r"\{\{[А-ЯЁA-Z_0-9]+\}\}", f.read_text(encoding="utf-8")):
                    left.setdefault(m, set()).add(str(f.relative_to(out)))
            except UnicodeDecodeError:
                pass

    print(f"\nПроект создан: {out}")
    print(f"  slug: {a.slug} · бизнес: {a.biz} · модель: {a.model} · сервер: {a.server}")
    print(f"  каналы внутри проекта: {', '.join(sorted(p.name for p in ch_out.iterdir() if p.is_dir() and not p.name.startswith('.')))}")
    if left:
        print(f"\nОсталось заполнить ({len(left)} меток) — deploy.sh не выкатит, пока они есть:")
        for k in sorted(left):
            print(f"  {k:28} {', '.join(sorted(left[k])[:3])}")
    else:
        print("\nМеток не осталось.")
    print("\nДальше: 1) заполнить knowledge/ 2) завести бота и положить токен на сервер "
          "3) bash deploy.sh 4) тест из 24 вопросов и живой диалог.")


if __name__ == "__main__":
    main()

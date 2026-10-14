---
description: Движок ресерча — новый движок с брифом, стадия конвейера, аудит, статус
argument-hint: new <тема> | brief | plan | run <stage> | audit | index | status
---

Пользователь вызвал движок ресерча с аргументом: `$ARGUMENTS`

Загрузи скилл `research-engine` (Skill tool) и работай по нему. `$SKILL` ниже — каталог скилла (Base directory из его загрузки); скрипты запускаются как `node $SKILL/scripts/<скрипт>.mjs`. Аргумент читается так:

- `new <тема>` — стадия 0: бриф по `references/BRIEF.md` (прочитай его целиком). Сначала проверь, что уже есть на диске по той же теме (движки, скиллы) — от этого зависит, заводить ли новый движок и под каким слагом. Затем каркас: `node $SKILL/scripts/engine-init.mjs --root <root> --slug <slug> --request "<тема дословно, как написал пользователь>"`. Первым сообщением покажи разбор запроса (как понял, допущения, размытые слова), запусти разведку в фоне (`node $SKILL/scripts/render-tasks.mjs --root <root> --stage recon`, затем `synthesis.mjs` с напечатанными args) и задай первый круг вопросов о работе базы через AskUserQuestion. Второй круг — по `brief/RECON.md`. Заполни `brief`, `mission`, `perimeter`, `profile`, `finish` в `engine.json`, затем `node $SKILL/scripts/brief.mjs --root <root> --write`. Останов: `BRIEF.md` утверждает пользователь.
- `brief` — `node $SKILL/scripts/brief.mjs --root <root>`: готов ли бриф, какие контрольные вопросы не закрыты темами, что спросить у пользователя. Используй и тогда, когда задача базы поменялась посреди сборки.
- `plan` — стадия 1: декомпозиция, только по утверждённому брифу. Тема режется на ТЗ, пишутся `prompts/`, `synthesis-spec/` и карта «тема → свод»; темы и своды вписываются в `topics` и `syntheses` engine.json, каждая тема получает `answers` — id контрольных вопросов. Список тем и таблица «контрольный вопрос → темы» показываются пользователю до прогона.
- `run <stage>` — прогон стадии партиями по 3–4, а не всё разом. Сначала `node $SKILL/scripts/render-tasks.mjs --root <root> --stage <stage>`: он печатает args Workflow и команды `fanout.mjs` первой партии — бери их оттуда.
  - `research` — рендер кладёт задачи и ресерчера, и верификатора. Claude Code: `<root>/workflows/research.mjs` гонит на каждую тему ресерчера и следом верификатора. Codex: два прогона — `fanout.mjs --stage research --labels research__…`, затем `fanout.mjs --stage verify --labels verify__…`.
  - `verify` — только в Codex после ресерча или для повторной верификации: `research.mjs` с `args.stage: "verify"` либо `fanout.mjs --stage verify`. Отчёт не пишется заново.
  - `synth`, `merge` (если банк фактов собран частями), `critique`, `method`, `agent-doc` — Claude Code: `<root>/workflows/synthesis.mjs` с `args.stage`; Codex: `fanout.mjs --stage <stage>`. Между `method` и `agent-doc` — `index`.

  После каждой партии — `node $SKILL/scripts/status.mjs --root <root>`, затем `node $SKILL/scripts/audit.mjs --root <root>`. Следующую партию Workflow не запускай до уведомления о завершении предыдущей: пока агенты не записали файлы, `status.mjs` их тем не видит.
- `audit` — `node $SKILL/scripts/audit.mjs --root <root>`, разбор блокеров и предупреждений.
- `index` — `node $SKILL/scripts/build-index.mjs --root <root>`: карта сводов с номерами строк.
- `status` — `node $SKILL/scripts/status.mjs --root <root>`: что собрано по диску, где `engine.json` расходится с диском, что упало, сколько ещё стоит и какая команда следующая. Покажи это пользователю вместе с последними строками `state/run-log.md`. Статусы записывай (`--write`) после того, как показал расхождения.

Без аргумента — покажи статус текущего движка, если он есть в этом каталоге, иначе объясни, с чего начать.

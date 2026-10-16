# research-engine

Плагин, который собирает по любой теме верифицированную базу знаний и методику поверх неё — тем же конвейером, которым собраны движки `clarity`, `copy` и `aso`.

```
бриф → декомпозиция темы на ТЗ → отчёты с верификацией → своды → критик полноты → METHOD.md + AGENT.md
```

**Закон конвейера: ни один шаг не сжимает содержание.** Отчёт полнее ТЗ, свод — надмножество относящихся к нему отчётов, методика — навигатор поверх сводов. Ступени дайджестов нет. Единственное допустимое сокращение — склейка дословных повторов между источниками, и то с пометкой «подтверждено N отчётами».

## Чем отличается от «поищи в интернете»

| | Обычный ресерч агента | Этот движок |
|---|---|---|
| Охват | одна сессия, один проход | 5–16 ТЗ, каждое со своим агентом |
| Проверка | нет | верификатор на каждый отчёт: перепроверяет нагруженные числа по первоисточникам и **достраивает** отчёт |
| Потери | саммари на каждом шаге | закон конвейера + машинный аудит стадий |
| Задача | как понял агент | бриф: исходный запрос разобран, разведка предмета, два круга вопросов заказчику о работе базы, его материалы, 5–15 контрольных вопросов — по ним базу и принимают |
| Результат | ответ в чате | дерево файлов: отчёты, своды, банк фактов с провенансом, GAPS, методика |

## Два хоста

| | Claude Code | Codex |
|---|---|---|
| Исполнитель | `workflows/research.mjs`, `workflows/synthesis.mjs` через Workflow-тул | `scripts/fanout.mjs` поверх `codex exec --output-schema` |
| Источник правды | `state/tasks/<label>.md` на диске | тот же файл |

Файлы задач рендерятся скриптом, а не агентом, поэтому оба хоста гоняют буквально одни и те же промпты.

## Установка

Нужен Node 18+: скрипты движка запускаются через `node`.

Claude Code — в терминале (внутри сессии те же команды: `/plugin marketplace add …`, `/plugin install …`):

```
claude plugin marketplace add kyzdes/claude-skills
claude plugin install research-engine@claude-skills
```

Затем перезапусти Claude Code: скилл подхватывается новой сессией. Дальше — «собери базу знаний по теме …» или `/engine new`.

Обновить до свежей версии:

```
claude plugin marketplace update claude-skills
claude plugin update research-engine@claude-skills
```

Codex (проверено на codex-cli 0.159.3):

```
codex plugin marketplace add https://github.com/kyzdes/claude-skills.git
codex plugin add research-engine@claude-skills
```

После установки открой новую задачу Codex, чтобы он подхватил скилл. В Codex стадии гоняет `fanout.mjs`: процесс `codex exec` на задачу, маршрут моделей из `codexModels` в `engine.json` (`gpt-6-astra` на верификации, сводах, критике и методике, `gpt-6.1-sol` на остальном), верификатор следом за ресерчем, расход партии пишется сам. Запасной путь для приложения Codex — режим субагентов (`fanout.mjs --print-prompts`), см. SKILL.md, «Прогон».

## Как гонять

```
/engine new <тема>      бриф: разбор запроса, разведка, вопросы о работе базы, материалы, контрольные вопросы
/engine brief           готов ли бриф и какие контрольные вопросы не закрыты темами
/engine plan            декомпозиция: prompts/, synthesis-spec/, карта «тема → свод»
/engine run research    отчёты партиями по 3–4 темы; следом за ресерчером темы идёт её верификатор
/engine run verify      только верификация: повтор упавшего или не нарастившего отчёт верификатора
/engine run synth       своды
/engine run merge       навигатор банка фактов, если банк собран частями
/engine run critique    GAPS.md
/engine run method      METHOD.md
/engine index           INDEX.md с номерами строк (до AGENT.md и после финиша)
/engine run agent-doc   AGENT.md
/engine status          что собрано по диску и какая команда следующая
/engine audit           машинная проверка закона конвейера
```

В Codex те же стадии гоняет `node <скилл>/scripts/fanout.mjs --root <корень> --stage <стадия> --engine codex`, где `<скилл>` — `skills/research-engine` внутри установленного плагина. Верификатор темы встаёт в очередь сам, как только её ресерч завершился; `--stage verify` нужен только для повтора упавшего верификатора. Готовые команды с метками партии печатают `render-tasks.mjs` и `status.mjs`.

## Скрипты

| Скрипт | Что делает |
|---|---|
| `engine-init.mjs` | заводит дерево движка, `engine.json`, `ENGINE.md`, `BRIEF.md`, копии исполнителей и схем; на существующем движке без `--force` не трогает `engine.json`, с `--force` сливает ответы поверх, снимая бэкапы |
| `render-tasks.mjs` | рендерит промпты агентов в `state/tasks/` — единственный способ их появления; `--stage research` кладёт и задачи верификатора; печатает команды первой партии |
| `fanout.mjs` | портируемый исполнитель: процессы агентов с лимитом параллелизма, ретраями и логами; результат агента проверяет по схеме стадии |
| `brief.mjs` | готов ли бриф: работа базы, контрольные вопросы, материалы, периметр; таблица «контрольный вопрос → темы»; `--write` собирает `BRIEF.md` |
| `status.mjs` | состояние по диску: что собрано, где `engine.json` отстал, что упало, сколько ещё стоит, какая команда следующая (для Workflow и для Codex); без флагов ничего не пишет, `--write` повышает статусы (строка в журнал — только если что-то изменилось), `--record` пишет расход партии |
| `audit.mjs` | закон конвейера машинно: рост отчётов после верификации (по числам, которые сообщил верификатор), порог сжатия сводов, следы сжатия, покрытие ТЗ, битые ссылки, матрица «тема → свод», результаты агентов по схеме; `--help` перечисляет все коды |
| `build-index.mjs` | карта сводов с номерами строк и правилом окна |
| `words.mjs` | объём файла в словах тем же счётчиком, что у аудита; его команду получает хвост каждой задачи вместе с личным каталогом агента `state/scratch/<метка>/` |
| маршрут моделей | `models` и `efforts` в `engine.json`: верификатор, плейбуки, критик и методика — opus; разведка, ресерч, части банка, навигатор и `AGENT.md` — sonnet; печатается в аргументы исполнителей |
| `lib/engine.mjs` | общее ядро: чтение `engine.json`, имена файлов и меток задач, роли GAPS и банка фактов — чтобы скрипты не расходились |

## Профили масштаба

**S** — 5–6 тем, 3–4 свода. **M** — 8–10 тем, 6–9 сводов. **L** — 13–16 тем, банк фактов частями плюс навигатор (так собран `aso`: 13 отчётов на 365 тыс. слов → 15 файлов сводов).

Тяжёлые агенты гоняются партиями по 3–4 темы или задачи: девять параллельных агентов на профиле L выжигают лимит сессии за пять минут.

---

Личный маркетплейс: [kyzdes/claude-skills](https://github.com/kyzdes/claude-skills)

## Plugin update policy

When Claude's native auto-update is enabled for `claude-skills`, the host owns
updates and this plugin's fallback updater does no work. Native auto-update is
an independent user setting; hook environment flags do not disable it.

With native auto-update off, the fallback hook updates **only this plugin**,
in the background, at most once per four hours after a successful update.
Updates share an OS lock, have bounded command timeouts, and retry failed work
without starting a four-hour success cooldown. Set `KKZ_NO_AUTOUPDATE=1` to
disable the fallback; `KKZ_AUTO_UPDATE_INTERVAL_SEC` sets its cooldown.
Keys Keeper's fallback additionally requires `KEYS_KEEPER_ENABLE_MUTABLE_AUTOUPDATE=1`
and respects `KEYS_KEEPER_NO_AUTOUPDATE`. It never updates another plugin.
To prohibit every automatic update, disable native auto-update as well.
Logs contain operation names and exit codes only, under
`~/.cache/kyzdes-claude-skills/v2/<config-id>/`, isolated by Claude configuration.
Python 3.9 or newer is required for the fallback.

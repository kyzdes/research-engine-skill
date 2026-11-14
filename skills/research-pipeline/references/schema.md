# Схема базы `research`

Колонки и их описания живут в базе и в `tables.json` рядом: читай их через `db_describe`. Здесь — то, чего в описаниях колонок нет: смысл таблиц, словари, ключи и правила.

## Таблицы

| Таблица | Ключ | Что в ней |
|---|---|---|
| `tasks` | `slug` | карточка задачи; полная — заметка `<slug>/TASK` |
| `items` | `id` | объект без привязки к задаче: имя, адреса, доступ. Общий для всех ресерчей |
| `assessments` | `task, item` | оценка объекта в задаче: стадия, вердикт, полнота, откуда найден, выборка, решение пользователя |
| `sources` | `url` | что открывали: площадка, автор, даты, инструмент, доступ |
| `facts` | `item, attribute, source` | значение поля объекта из конкретного источника: где именно, на какую дату, уровень проверки |
| `searches` | `id` | журнал поисков: стратегия, запрос, инструмент, фолбэк, сколько нашёл и сколько нового |
| `links` | `from_item, rel, to_item` | связи объектов |
| `t_<slug>` | `item` | текущие значения предметных полей задачи; происхождение каждого — в `facts` |

**Главное разделение.** Объективное лежит у объекта (`items`, `facts`): его нашли однажды, и им пользуются все задачи. Субъективное — у оценки (`assessments`): один и тот же репозиторий бывает полезен в одном ресерче и мимо в другом.

## Словари

Значения — только из этих списков. Ни одно не подходит → ближайшее, пояснение в `why`, и сообщить пользователю: словарь расширяется правкой скила, а не на ходу.

| Словарь | Где | Значения |
|---|---|---|
| `task_status` | `tasks.status` | `interview`, `planned`, `discovery`, `sampling`, `running`, `reporting`, `done`, `paused` |
| `output` | `tasks.output` | `list` (список), `compare` (сравнительная таблица), `findings` (база находок с заметками), `answer` (ответ на вопрос), `method` (методика) |
| `kind` | `tasks.unit`, `items.kind` | `person`, `org`, `account` (профиль или канал на площадке), `product`, `tool`, `repo`, `course`, `community`, `post`, `video`, `article`, `paper`, `dataset`, `event`, `other` |
| `stage` | `assessments.stage` | `candidate` (в реестре), `screened` (прошёл отсев), `processed` (разобран), `done` (записан), `parked` (вне бюджета или ждёт доступа) |
| `relevance` | `assessments.relevance`, `user_label` | `unknown`, `yes`, `partial`, `no` |
| `reason` | `assessments.reason` | `off_topic`, `out_of_scope`, `promo`, `outdated`, `low_quality`, `too_shallow`, `no_access`, `unverifiable` |
| `completeness` | `assessments.completeness` | `full`, `partial` (+ `missing`), `stub` (только метаданные) |
| `access` | `items.access`, `sources.access` | `open`, `partial` (часть недоступна: карусель, превью), `login`, `paywall`, `removed`, `geo_blocked`, `error`, `unknown` |
| `level` | `facts.level`, `schema[].evidence` | `claimed`, `observed`, `corroborated`, `verified`; в схеме ещё `none` — факт не нужен |
| `source_type` | `sources.source_type` | `primary` (сам объект или владелец), `secondary` (пересказ), `aggregator` (каталог, подборка), `opinion` (отзыв, обзор), `promo` (реклама, партнёрка), `unknown` |
| `strategy` | `searches.strategy` | `search` (запрос), `snowball` (от найденного: подписки, ссылки, цитирования), `directory` (каталог, рейтинг, awesome-список), `enumerate` (перебор содержимого источника), `list` (готовый список пользователя), `manual` (добавлен руками) |
| `rel` | `links.rel` | `owns`, `authored`, `part_of`, `mentions`, `follows`, `cites`, `alternative_to` |
| `decision` | `assessments.decision` | `applied`, `rejected`, `watching`; ставит пользователь |
| `autonomy` | `tasks.autonomy` | `ask_all`, `gates`, `auto` |

### Уровни проверки

| `level` | Когда ставить | Пример |
|---|---|---|
| `claimed` | так утверждает источник | автор пишет «у меня 40 тыс. учеников» |
| `observed` | видно в самом материале | цена на слайде курса, функция показана в видео |
| `corroborated` | два **независимых** источника | цену называют страница тарифа и отзыв ученика |
| `verified` | первоисточник или проверка запуском | звёзды через `gh api`, цена на официальной странице оплаты |

Не независимы: репост, перепечатка, два аккаунта одного автора, партнёрский обзор.

## Канонические ключи

Ключ объекта и адрес источника — **только** через `scripts/canon.py`. Руками не собирать.

| Вид | Ключ |
|---|---|
| репозиторий / аккаунт GitHub | `github:<owner>/<name>` / `github:<owner>` |
| аккаунт Instagram / пост или рилс | `instagram:<handle>` / `instagram:p/<shortcode>` |
| канал YouTube / видео | `youtube:@<handle>` или `youtube:channel/<UC…>` / `youtube:v/<id>` |
| Telegram-канал / пост | `telegram:<handle>` / `telegram:<handle>/<n>` |
| X / пост | `x:<handle>` / `x:status/<id>` |
| TikTok / видео | `tiktok:@<handle>` / `tiktok:video/<id>` |
| LinkedIn | `linkedin:in/<handle>`, `linkedin:company/<handle>` |
| научная работа | `arxiv:<id>`, `doi:<doi>` |
| датасет / модель Hugging Face | `hf:datasets/<owner>/<name>` / `hf:<owner>/<name>` |
| датасет Kaggle | `kaggle:<owner>/<name>` |
| организация, продукт | `web:<домен>` (`--kind org` или `--kind product`) |
| человек | `person:<хэндл>` с его главной площадки (`--kind person` на URL аккаунта) |
| любая другая страница | `web:<домен><путь>[?значимые параметры]` |

Человек и его аккаунты — разные объекты. `person:nick_saraev` связан `owns` с `instagram:nick_saraev` и `youtube:@nicksaraev`. Главная площадка — где у него больше аудитории или где он сам себя представляет. Остальные хэндлы — в `items.aliases`.

## Дубли

**Перед созданием объекта** проверь, нет ли его уже:
1. ключ из `canon.py` есть в `items.id`;
2. либо имя или хэндл есть в `aliases`;
3. либо адрес есть в `urls`.

Запрос — `SELECT id FROM items WHERE id = ?1 OR aliases LIKE '%' || ?2 || '%' OR urls LIKE '%' || ?3 || '%'`.

- Нашёлся → новая оценка к **существующему** объекту, его `urls` и `aliases` дополнить.
- Дубль обнаружен позже:
  1. у лишнего — `merged_into = <основной>`;
  2. его оценки и факты переписать на основной ключ (новые строки с `upsert`);
  3. у старых оценок — `relevance=no`, `why="дубль <основной>"`.

  Удалять нельзя.

## Факты

- Факт пишется для поля, у которого в схеме `evidence` не `none`. Описательные поля (имя, ссылка) идут сразу в `items` или `t_<slug>`.
- `value` — строка. Число без единиц, единица — в `unit`. Дата — ISO.
- `locator` обязателен для `observed` и выше: таймкод `12:04`, `слайд 3/8`, раздел страницы или цитата до 20 слов.
- `observed_at` — на какую дату значение верно. Для звёзд, подписчиков, цен — дата проверки, а не публикации.
- Факты не перезаписываются. Новое значение из того же источника — `upsert` с новым `observed_at`; из другого источника — новая строка.
- Противоречие — нормальная ситуация: запрос `conflicts` их показывает, отчёт их разбирает.

## Таблица полей задачи `t_<slug>`

Создаётся на шаге 3 после утверждения плана:

```
db_create_table(project="Research", database="research", table="t_<slug с _ вместо ->", key=["item"],
  columns=[{name:"item", type:"text", description:"items.id"},
           …по полю на каждый элемент tasks.schema: {name, type, description: how + unit}…,
           {name:"filled_at", type:"date", description:"Когда заполнены текущие значения"}])
```

- Имя таблицы — латиница, цифры и `_`, до 63 символов.
- Новое поле посреди задачи — `db_add_columns` и запись в `tasks.schema`.
- В базе до 100 таблиц. Закрытые задачи старше года предлагай выгрузить и удалить их `t_<slug>`, но только с согласия пользователя.

## Схема полей (`tasks.schema`)

```json
[{"name": "price", "type": "real", "unit": "RUB/month", "values": null, "required": true,
  "answers": ["A3"], "evidence": "verified", "how": "страница тарифа, без скидок"},
 {"name": "format", "type": "text", "unit": null, "values": ["course", "channel", "club"], "required": true,
  "answers": ["A1"], "evidence": "observed", "how": "как продаётся: курс, канал, клуб"}]
```

- `type` — тип колонки Notes: `text`, `integer`, `real`, `boolean`, `date`, `json`, `url`.
- Поле, у которого `answers` пусты, не собирается: оно не отвечает ни на один приёмочный вопрос.

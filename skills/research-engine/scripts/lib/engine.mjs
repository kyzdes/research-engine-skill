// lib/engine.mjs — общее ядро скриптов движка: чтение engine.json, канон имён файлов и меток
// задач, роли особых сводов (GAPS, навигатор банка фактов), счёт слов, русские числительные.
// Раньше всё это жило копиями в каждом скрипте и успело разъехаться: fanout считал задачей
// стадии synth и GAPS.md, audit мерил навигатор банка как обычный свод, имя файла свода
// по умолчанию строилось тремя разными способами. Правило: если два скрипта должны
// договориться о чём-то в engine.json — это живёт здесь.
// Node 18+, ESM, без зависимостей.

import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------- файлы и ошибки

export function die(msg, code = 2) {
  console.error('Ошибка: ' + msg)
  process.exit(code)
}

export function isDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }
export function isFile(p) { try { return fs.statSync(p).isFile() } catch { return false } }
export function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
export function readJson(p) {
  const t = readText(p)
  if (t == null) return null
  try { return JSON.parse(t) } catch { return null }
}

// ---------------------------------------------------------------- текст и числа

export const countWords = (t) => (t ? (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length : 0)
export const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  if (b === 1) return one
  return many
}

export const wordsRu = (n) => fmt(n) + ' ' + plural(n, 'слово', 'слова', 'слов')

// Локальная дата, а не UTC: сборка ночью по Москве иначе получает вчерашнее число.
export function todayISO() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))

// ---------------------------------------------------------------- контракт движка

// recon — разведка предмета на стадии брифа, до вопросов заказчику и до декомпозиции.
export const STAGES = ['recon', 'research', 'verify', 'synth', 'merge', 'critique', 'method', 'agent-doc']

// Префикс метки задачи по стадии. agent-doc делит префикс с method: обе пишут файлы финиша.
export const PREFIX_BY_STAGE = {
  recon: 'recon', research: 'research', verify: 'verify', synth: 'synth',
  merge: 'merge', critique: 'critique', method: 'method', 'agent-doc': 'method',
}

export const DEFAULT_FINISH = 'method'
export const DEFAULT_WORDS = { report: 3500, synthesis: 6000 }

// Нормы профилей: [темы от, темы до, своды от, своды до]. Те же числа стоят в таблице
// профилей SKILL.md — поправил здесь, поправь и там. Своды считаются вместе с частями
// банка фактов, навигатором и GAPS.md: так их и перечисляет engine.json.
export const PROFILE_NORM = { S: [5, 6, 3, 4], M: [8, 10, 6, 9], L: [13, 16, 10, 16] }

// Имя файла свода по метке, если в engine.json нет поля file: «field-spec» → FIELD-SPEC.md.
export function defaultSynthFile(label) {
  return String(label || 'synthesis').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.md'
}

export const synthFileName = (s) => String(s.file || defaultSynthFile(s.label))

// GAPS.md стоит в syntheses как файл движка, но пишет его стадия critique, а не сводчик:
// primary ему не нужен, в стадию synth он не входит.
export const isGaps = (s) => /^GAPS\.md$/i.test(String(s.file || '')) || String(s.label) === 'gaps'
// Навигатор банка фактов, собранного частями: primary у него — метки частей, а не темы.
export const isBankNav = (s) => /^FACTS-BANK\.md$/i.test(String(s.file || '')) || String(s.label) === 'facts-bank'
export const isBankPart = (s) => /^FACTS-BANK-/i.test(String(s.file || ''))

// Приводит сырой engine.json к спискам, на которые опираются все скрипты. Не падает на
// отсутствующих необязательных полях и не теряет лишние: raw остаётся как был.
export function normalizeEngine(raw) {
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const topics = (Array.isArray(e.topics) ? e.topics : [])
    .filter(t => t && t.slug != null && String(t.slug).trim())
  const syntheses = (Array.isArray(e.syntheses) ? e.syntheses : [])
    .filter(s => s && (s.label || s.file))
    .map(s => (s.label ? s : { ...s, label: path.basename(String(s.file), '.md').toLowerCase() }))
  return { raw: e, topics, syntheses }
}

// Банк фактов частями: навигатор и его части. Части берутся из primary/parts навигатора,
// а если их там нет — по имени файла FACTS-BANK-<часть>.md.
export function bankLayout(syntheses) {
  const entry = syntheses.find(isBankNav) || null
  const declared = entry
    ? [...(Array.isArray(entry.primary) ? entry.primary : []), ...(Array.isArray(entry.parts) ? entry.parts : [])]
        .map(String).map(l => syntheses.find(s => String(s.label) === l)).filter(Boolean)
    : []
  const parts = declared.length ? declared : syntheses.filter(isBankPart)
  return { entry, parts }
}

// Своды, которые собирает стадия synth: без GAPS.md (его пишет critique) и без навигатора
// банка, если банк собран частями (навигатор собирает merge).
export function synthStageEntries(syntheses) {
  const { entry, parts } = bankLayout(syntheses)
  return syntheses.filter(s => !isGaps(s) && !(parts.length && entry && s === entry))
}

// Канонический список меток задач стадии. Его же рендерит render-tasks.mjs — исполнитель
// и рендер обязаны видеть один и тот же набор, иначе fanout ищет файл задачи, которого нет.
export function stageLabels(stage, engine) {
  const { topics, syntheses } = engine
  if (stage === 'recon') return ['recon__field']
  if (stage === 'research' || stage === 'verify') return topics.map(t => stage + '__' + t.slug)
  if (stage === 'synth') return synthStageEntries(syntheses).map(s => 'synth__' + s.label)
  if (stage === 'merge') return ['merge__facts-bank']
  if (stage === 'critique') return ['critique__gaps']
  if (stage === 'method') return ['method__method']
  if (stage === 'agent-doc') return ['method__agent']
  return []
}

// ---------------------------------------------------------------- модели по стадиям

// Какой модели отдавать задачу. Правило: суждение и проверка — сильнейшей модели (верификатор,
// сводчик плейбуков, критик, автор методики); объём с веб-поиском и перенос без сжатия —
// средней (разведка, ресерч, части банка фактов, навигатор, AGENT.md). Маленькая модель по
// умолчанию не стоит нигде: каждая стадия либо судит, либо переносит большой текст без потерь,
// а это ровно то, в чём она слабее всего. Переопределяется полями models и efforts в engine.json.
export const DEFAULT_MODELS = {
  recon: 'sonnet', research: 'sonnet', verify: 'opus', synth: 'opus', bank: 'sonnet',
  merge: 'sonnet', critique: 'opus', method: 'opus', 'agent-doc': 'sonnet',
}
export const DEFAULT_EFFORTS = {
  recon: 'medium', research: 'high', verify: 'high', synth: 'high', bank: 'medium',
  merge: 'medium', critique: 'high', method: 'high', 'agent-doc': 'medium',
}
export const ROUTE_KEYS = Object.keys(DEFAULT_MODELS)

// Части банка фактов идут отдельным ключом bank: перенос тысяч строк таблиц требует
// аккуратности, а не суждения, и на сильнейшей модели это дорого без выигрыша.
export const routeKey = (stage, synthEntry) => (stage === 'synth' && synthEntry && isBankPart(synthEntry) ? 'bank' : stage)

export function routeFor(raw, stage, synthEntry) {
  const key = routeKey(stage, synthEntry)
  const pick = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {})
  const m = pick(raw && raw.models)
  const ef = pick(raw && raw.efforts)
  return { key, model: String(m[key] || DEFAULT_MODELS[key] || ''), effort: String(ef[key] || DEFAULT_EFFORTS[key] || '') }
}

// Стадия по метке задачи: research__x → research, method__agent → agent-doc.
export function stageOfLabel(label) {
  const [prefix, rest] = String(label).split('__')
  if (prefix === 'method') return rest === 'agent' ? 'agent-doc' : 'method'
  return prefix
}

// Аргументы Workflow-исполнителя для партии: модели и усилия считаются здесь, из engine.json,
// потому что сам исполнитель файловой системы не видит. shortLabels — метки без префикса стадии.
export function workflowArgs(raw, root, stage, shortLabels) {
  const { syntheses } = normalizeEngine(raw)
  const models = {}
  const efforts = {}
  if (stage === 'research' || stage === 'verify') {
    for (const k of stage === 'research' ? ['research', 'verify'] : ['verify']) {
      const r = routeFor(raw, k)
      models[k] = r.model
      efforts[k] = r.effort
    }
    return { root, ...(stage === 'verify' ? { stage: 'verify' } : {}), labels: shortLabels, models, efforts }
  }
  for (const l of shortLabels) {
    const r = routeFor(raw, stage, syntheses.find(s => String(s.label) === l))
    models[l] = r.model
    efforts[l] = r.effort
  }
  return { root, stage, labels: shortLabels, models, efforts }
}

// ---------------------------------------------------------------- бриф

// Бриф отвечает на вопрос «какую работу делает база» до того, как тема режется на ТЗ.
// Его сердце — контрольные вопросы: на что готовая база обязана отвечать. По ним
// декомпозиция назначает темы (topics[].answers), ресерчер знает, ради чего копает,
// критик проверяет готовность, методика даёт адрес ответа. Методика брифа — references/BRIEF.md.

const BRIEF_LISTS = ['users', 'jobs', 'decisions', 'deliverables', 'assumptions', 'constraints', 'known', 'openQuestions']

export const strList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim()).filter(Boolean)

export const MISSION_STUB_RE = /^ЗАПОЛНИТЬ/i

export function normalizeBrief(raw) {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {
    request: String(b.request || '').trim(),
    restated: String(b.restated || '').trim(),
    freshness: String(b.freshness || '').trim(),
  }
  for (const k of BRIEF_LISTS) out[k] = strList(b[k])
  // Контрольный вопрос — строка или { id, question, job }. Без id получает A<n> по порядку;
  // brief.mjs --write записывает выданные id обратно, чтобы topics[].answers не съехали.
  const used = new Set()
  out.acceptance = (Array.isArray(b.acceptance) ? b.acceptance : []).map((a, i) => {
    const obj = a && typeof a === 'object' ? a : {}
    const question = String(typeof a === 'string' ? a : obj.question || obj.q || '').trim()
    let id = String(obj.id || '').trim()
    if (!id || used.has(id)) { let n = i + 1; while (used.has('A' + n)) n++; id = 'A' + n }
    used.add(id)
    return { id, question, job: String(obj.job || '').trim(), autoId: !obj.id }
  }).filter(a => a.question)
  out.inputs = (Array.isArray(b.inputs) ? b.inputs : [])
    .map(x => (typeof x === 'string' ? { ref: x } : x))
    .filter(x => x && x.ref)
    .map(x => ({ ref: String(x.ref).trim(), kind: String(x.kind || '').trim(), use: String(x.use || '').trim(), trust: String(x.trust || '').trim() }))
  const src = b.sources && typeof b.sources === 'object' && !Array.isArray(b.sources) ? b.sources : {}
  out.sources = { must: strList(src.must), avoid: strList(src.avoid) }
  return out
}

// Какие контрольные вопросы закрыты темами: topics[].answers — id вопросов, ради которых тема заведена.
export function acceptanceCoverage(brief, topics) {
  const ids = new Set(brief.acceptance.map(a => a.id))
  const map = Object.fromEntries(brief.acceptance.map(a => [a.id, []]))
  const unknown = []
  for (const t of topics) {
    for (const id of strList(t.answers)) {
      if (ids.has(id)) map[id].push(String(t.slug))
      else unknown.push({ topic: String(t.slug), id })
    }
  }
  return { map, uncovered: brief.acceptance.filter(a => !map[a.id].length).map(a => a.id), unknown }
}

// Готов ли бриф к декомпозиции. Блокер — без него темы режутся вслепую; предупреждение —
// бриф слабее, чем мог бы быть. root нужен, чтобы увидеть разведку на диске.
export function briefFindings(raw, root) {
  const e = raw && typeof raw === 'object' ? raw : {}
  const b = normalizeBrief(e.brief)
  const blockers = []
  const warnings = []
  const mission = String(e.mission || '').trim()
  const perim = e.perimeter || {}
  if (!e.brief) blockers.push('в engine.json нет брифа (поле brief) — работа базы и контрольные вопросы не заданы')
  if (!b.request && !b.restated) blockers.push('нет исходного запроса (brief.request) — не с чем сверять, туда ли ушла база')
  if (!b.jobs.length) blockers.push('не названа работа базы (brief.jobs): что по ней будут делать — без этого темы режутся по оглавлению учебника')
  if (!b.acceptance.length) blockers.push('нет контрольных вопросов (brief.acceptance) — нечем проверить, что база готова')
  else if (b.acceptance.length < 5) warnings.push('контрольных вопросов ' + b.acceptance.length + ' — норма 5–15: меньше пяти обычно значит, что работа базы описана слишком общо')
  else if (b.acceptance.length > 20) warnings.push('контрольных вопросов ' + b.acceptance.length + ' — больше двадцати: проверь, не смешаны ли две разные базы')
  if (!mission || MISSION_STUB_RE.test(mission)) blockers.push('миссия не написана (mission) — она уходит дословно в каждый промпт')
  if (!strList(perim.out).length) blockers.push('пустой perimeter.out — периметр без исключений не удерживает агентов от расползания')
  if (!strList(perim.in).length) blockers.push('пустой perimeter.in')
  if (!b.restated) warnings.push('нет переформулировки запроса (brief.restated) — заказчик не видел, как его поняли')
  if (!b.users.length) warnings.push('не названо, кто работает по базе (brief.users): человек, агент или оба — от этого зависит форма сводов')
  if (!b.inputs.length && !b.known.length) warnings.push('материалы заказчика не собраны (brief.inputs) и не записано, что он уже знает (brief.known) — спроси, что у него есть, прежде чем искать заново')
  if (!b.freshness) warnings.push('не задана свежесть (brief.freshness): на какую дату и как быстро портится предмет')
  if (b.openQuestions.length) warnings.push('открытых вопросов к заказчику: ' + b.openQuestions.length + ' — закрой их или явно прими допущением')
  if (root && ['M', 'L'].includes(String(e.profile || '').toUpperCase()) && !isFile(path.join(root, 'brief', 'RECON.md'))) {
    warnings.push('профиль ' + e.profile + ', а разведки нет (brief/RECON.md) — вопросы заказчику задаются вслепую; стадия recon')
  }
  for (const a of b.acceptance) {
    if (!a.job && b.jobs.length > 1) { warnings.push('контрольные вопросы не привязаны к работам (acceptance[].job) — не видно, какая работа без ответа'); break }
  }
  return { brief: b, blockers, warnings }
}

// ---------------------------------------------------------------- бриф в тексте промптов

const bullets = (list) => list.map(x => '- ' + x).join('\n')

export function jobsText(b, empty = 'работа базы в брифе не описана — опирайся на миссию') {
  const parts = []
  if (b.users.length) parts.push('- **Кто работает по базе:** ' + b.users.join('; '))
  if (b.jobs.length) parts.push('- **Работа, которую она обслуживает:**\n' + b.jobs.map(j => '  - ' + j).join('\n'))
  if (b.deliverables.length) parts.push('- **Что производят по базе:** ' + b.deliverables.join('; '))
  if (b.decisions.length) parts.push('- **Решения, которые по ней принимают:** ' + b.decisions.join('; '))
  return parts.length ? parts.join('\n') : '- ' + empty
}

export function acceptanceText(list, empty) {
  return list.length ? list.map(a => '- **' + a.id + '.** ' + a.question + (a.job ? ' _(работа: ' + a.job + ')_' : '')).join('\n') : '- ' + empty
}

export function inputsText(b, root) {
  if (!b.inputs.length) return '- материалов заказчика нет: всё ищется в открытых источниках'
  return b.inputs.map(x => {
    const ref = /^[a-z]+:\/\//i.test(x.ref) || path.isAbsolute(x.ref) ? x.ref : path.join(root, x.ref)
    return '- `' + ref + '`' + (x.kind ? ' — ' + x.kind : '') + (x.use ? '; как использовать: ' + x.use : '') + (x.trust ? '; доверие: ' + x.trust : '')
  }).join('\n')
}

export function sourcesText(b) {
  const parts = []
  if (b.sources.must.length) parts.push('- **Открыть обязательно:** ' + b.sources.must.join('; '))
  if (b.sources.avoid.length) parts.push('- **Не опираться на:** ' + b.sources.avoid.join('; '))
  if (b.known.length) parts.push('- **Заказчик уже знает** (не пересказывай — проверь и углуби): ' + b.known.join('; '))
  if (b.freshness) parts.push('- **Свежесть:** ' + b.freshness)
  return parts.length ? parts.join('\n') : '- особых требований к источникам в брифе нет — работай по шкале доказательности'
}

// BRIEF.md — человеческий вид брифа. Собирается из engine.json целиком, руками не правится.
export function renderBriefMd(raw, root, topics) {
  const e = raw && typeof raw === 'object' ? raw : {}
  const b = normalizeBrief(e.brief)
  const perim = e.perimeter || {}
  const none = '— не задано'
  const list = (l) => (l.length ? bullets(l) : none)
  const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'
  const cov = acceptanceCoverage(b, topics || [])
  const out = []
  out.push('# Бриф движка «' + (e.title || e.slug || '') + '» (`' + (e.slug || '') + '`)', '')
  out.push('> Какую работу делает база и по каким вопросам проверяется её готовность. Машиночитаемая копия — `brief` в `engine.json`; этот файл собирает `brief.mjs --write`, руками его не правят. Бриф утверждает заказчик до декомпозиции.', '')
  out.push('## Исходный запрос', '', b.request ? b.request.split('\n').map(l => '> ' + l).join('\n') : none, '')
  out.push('## Как мы его поняли', '', b.restated || none, '')
  out.push('## Кто работает по базе', '', list(b.users), '')
  out.push('## Работа базы', '', list(b.jobs), '')
  out.push('**Что производят по базе:**', '', list(b.deliverables), '')
  out.push('**Решения, которые по ней принимают:**', '', list(b.decisions), '')
  out.push('## Контрольные вопросы', '')
  out.push('Готовая база обязана отвечать на каждый. По ним декомпозиция назначает темы, критик полноты проверяет готовность, методика даёт адрес ответа.', '')
  if (b.acceptance.length) {
    out.push('| ID | Вопрос | Работа | Темы |', '|---|---|---|---|')
    for (const a of b.acceptance) out.push('| ' + a.id + ' | ' + cell(a.question) + ' | ' + cell(a.job) + ' | ' + (cov.map[a.id].length ? cov.map[a.id].join(', ') : '—') + ' |')
  } else out.push(none)
  out.push('')
  out.push('## Периметр', '', '**Внутри:** ' + (strList(perim.in).join('; ') || none), '', '**Вне:** ' + (strList(perim.out).join('; ') || none), '')
  out.push('## Свежесть и рамки', '', '**Свежесть:** ' + (b.freshness || none), '', '**Ограничения:**', '', list(b.constraints), '')
  out.push('## Что заказчик уже знает', '', list(b.known), '')
  out.push('## Материалы заказчика', '')
  if (b.inputs.length) {
    out.push('| Материал | Что это | Как использовать | Доверие |', '|---|---|---|---|')
    for (const x of b.inputs) out.push('| `' + cell(x.ref) + '` | ' + cell(x.kind) + ' | ' + cell(x.use) + ' | ' + cell(x.trust) + ' |')
  } else out.push(none)
  out.push('')
  out.push('## Источники', '', '**Открыть обязательно:**', '', list(b.sources.must), '', '**Не опираться на:**', '', list(b.sources.avoid), '')
  out.push('## Допущения', '', list(b.assumptions), '')
  out.push('## Открытые вопросы', '', list(b.openQuestions), '')
  out.push('## Миссия', '', 'Уходит дословно в каждый промпт конвейера.', '', String(e.mission || '').trim() || none, '')
  out.push('## Профиль и финиш', '', 'Профиль `' + (e.profile || '?') + '`, финиш `' + (e.finish || DEFAULT_FINISH) + '`, язык `' + (e.language || 'ru') + '`.', '')
  return out.join('\n')
}

// ---------------------------------------------------------------- копии исполнителей

// engine-init кладёт в корень движка копии workflows/*.mjs и schemas/*.json, чтобы путь
// исполнителя был стабильным. После обновления плагина копии отстают: старый research.mjs
// не знает args.stage = 'verify' и вместо одной верификации заново пишет отчёт с нуля.
// Копии — производные файлы скилла, руками их не правят, поэтому их освежает render-tasks.
const TOOLCHAIN = [['workflows', '.mjs'], ['schemas', '.json']]

export function toolchainDrift(root, skillDir) {
  const out = []
  for (const [dir, ext] of TOOLCHAIN) {
    let files = []
    try { files = fs.readdirSync(path.join(skillDir, dir)).filter(f => f.endsWith(ext)).sort() } catch { continue }
    for (const f of files) {
      const src = path.join(skillDir, dir, f)
      const dst = path.join(root, dir, f)
      const want = readText(src)
      if (want == null) continue
      const have = readText(dst)
      if (have == null) out.push({ src, dst, rel: path.join(dir, f), state: 'missing', text: want })
      else if (have !== want) out.push({ src, dst, rel: path.join(dir, f), state: 'stale', text: want })
    }
  }
  return out
}

export function syncToolchain(root, skillDir) {
  const drift = toolchainDrift(root, skillDir)
  for (const d of drift) {
    fs.mkdirSync(path.dirname(d.dst), { recursive: true })
    fs.writeFileSync(d.dst, d.text, 'utf8')
  }
  return drift.map(d => d.rel + (d.state === 'missing' ? ' (добавлен)' : ' (обновлён)'))
}

// ---------------------------------------------------------------- журнал прогонов

const RUN_LOG_HEADER = ['| Дата | Стадия | Хост | Задачи | Итог | Заметка |', '|---|---|---|---|---|---|']
const logCell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'

// Строка журнала встаёт в конец таблицы, а не в конец файла: под таблицей в run-log.md
// стоит подвал, и дописанная после него строка выпадает из таблицы.
// cells: [дата, стадия, хост, задачи, итог, заметка]. Бросает исключение при ошибке записи.
export function appendRunLogRow(root, cells) {
  const p = path.join(root, 'state', 'run-log.md')
  const row = '| ' + cells.map(logCell).join(' | ') + ' |'
  const text = readText(p)
  let out
  if (text == null) {
    out = '# Журнал прогонов\n\n' + RUN_LOG_HEADER.join('\n') + '\n' + row + '\n'
  } else {
    const lines = text.split('\n')
    const head = lines.findIndex(l => /^\|\s*Дата\s*\|/.test(l))
    if (head < 0) {
      out = text.replace(/\n*$/, '\n\n') + RUN_LOG_HEADER.join('\n') + '\n' + row + '\n'
    } else {
      let end = head + 1
      while (end < lines.length && /^\|/.test(lines[end])) end++
      lines.splice(end, 0, row)
      out = lines.join('\n')
    }
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, out, 'utf8')
  return p
}

// ---------------------------------------------------------------- разбор markdown

export function codeFenceMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; mask[i] = true; continue }
    mask[i] = inFence
  }
  return mask
}

// Inline-код заменяется пробелами той же длины: позиции в строке сохраняются, а паттерны
// вида `[a-z](x)` внутри обратных кавычек перестают выглядеть как markdown-ссылки.
export const maskInlineCode = (line) => line.replace(/(`+)([^`]|[^`].*?[^`])\1/g, (m) => ' '.repeat(m.length))

export function headings(text, maxDepth = 6) {
  const lines = String(text).split('\n')
  const mask = codeFenceMask(lines)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (m && m[1].length <= maxDepth) out.push({ line: i + 1, level: m[1].length, title: m[2] })
  }
  return out
}

// Раздел верификации ищется по смыслу: живой прогон показал, что агент пишет и
// «## 8. Протокол верификации от <дата>», хотя шаблон требует «## Верификация (<дата>)».
export const findVerificationHeading = (text) =>
  headings(text, 3).find(h => /^(\d+[.)]\s*)?(протокол\s+)?верификаци/i.test(h.title)) || null

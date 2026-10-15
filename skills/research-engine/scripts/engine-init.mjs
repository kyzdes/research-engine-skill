#!/usr/bin/env node
// engine-init.mjs — каркас движка ресерча: дерево каталогов из контракта, engine.json,
// ENGINE.md, prompts/README.md, state/run-log.md и копии workflows/ и schemas/ из скилла.
// Node 18+, ESM, без зависимостей. Идемпотентен: без --force ничего не перезаписывает.
// С --force поверх существующего движка — слияние, а не пересборка с нуля: бриф, миссия,
// периметр, статусы, маршрут моделей и журнал прогонов сохраняются, ответы ложатся поверх.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  die, isDir, isFile, readText, todayISO, isISODate, plural,
  defaultSynthFile, isGaps, isBankNav, PROFILE_NORM, DEFAULT_FINISH, DEFAULT_WORDS,
  strList, normalizeBrief, briefFindings, renderBriefMd, DEFAULT_MODELS, DEFAULT_EFFORTS, ROUTE_KEYS,
  TOPIC_RANK, resolveRoot, shq, takeValue, labelProblem, matrixFindings, appendRunLogRow,
  CODEX_DEFAULT_MODELS, CODEX_DEFAULT_EFFORTS,
} from './lib/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL = path.resolve(HERE, '..')            // корень скилла: .../skills/research-engine
const TEMPLATES = path.join(SKILL, 'templates')
const WORKFLOWS_SRC = path.join(SKILL, 'workflows')
const SCHEMAS_SRC = path.join(SKILL, 'schemas')

const USAGE = `engine-init.mjs — заводит каркас движка ресерча в <root>.

  node engine-init.mjs --root <path> --slug <slug> [--title "..."] [--profile S|M|L]
                       [--finish base|method] [--language ru] [--today YYYY-MM-DD]
                       [--request "<исходный запрос дословно>"]
                       [--from <answers.json>] [--force] [--dry-run]

  --root      каталог движка. Обязателен (или root в answers.json). ~ раскрывается.
  --slug      машинное имя движка: строчные латинские буквы, цифры, дефис. Обязателен для
              нового движка; у существующего берётся из его engine.json.
  --title     человеческое название темы. По умолчанию равно --slug.
  --profile   S (5-6 тем, 3-4 свода) | M (8-10 / 6-9, по умолчанию) | L (13-16, банк частями)
  --finish    base (останов после GAPS.md) | method (плюс METHOD.md и AGENT.md, по умолчанию)
  --language  язык корпуса, по умолчанию ru
  --today     дата сборки YYYY-MM-DD, по умолчанию сегодняшняя
  --request   исходный запрос заказчика дословно — первая строка брифа (brief.request).
              С него начинается стадия брифа: разведка, вопросы, контрольные вопросы базы.
  --from      answers.json с итогами интейка; флаги командной строки перекрывают его поля
  --force     применить флаги и answers.json к существующему движку. engine.json сливается:
              поля, которых нет в answers.json, остаются как были (бриф, миссия, периметр,
              статусы тем и сводов, models, efforts, runs); у тем и сводов из answers.json
              статус берётся старший из двух. ENGINE.md и prompts/README.md пересобираются
              по шаблону, но журнал решений, таблицы тем и сводов и свои разделы переносятся.
              Журнал прогонов не перезаписывается — в него встаёт строка. Всё, что меняется,
              сначала уезжает в <файл>.bak-<дата>[-N]; прежние бэкапы не затираются.
  --dry-run   напечатать план и не писать ничего
  --help      эта справка

answers.json — объект с любым подмножеством полей engine.json:
  root, slug, title, language, profile, finish, today, mission,
  perimeter { in: [...], out: [...] }, targetWords { report, synthesis },
  brief { request, restated, users, jobs, decisions, deliverables,
          acceptance:[{ id, question, job }], assumptions, constraints, known,
          inputs:[{ ref, kind, use, trust }], sources { must, avoid }, freshness, openQuestions },
  models { <стадия>: opus|sonnet|haiku|<id> }, efforts { <стадия>: low|medium|high|xhigh|max }
  codexModels { <стадия>: gpt-6-astra|gpt-6.1-sol|<id> }, codexEfforts { <стадия>: low|medium|high|xhigh }
         стадии: ${ROUTE_KEYS.join(', ')} — bank это части банка фактов,
  topics [ { slug, title, what, feeds:[label], answers:[A1], status } ],
  syntheses [ { label, file, title, primary:[slug], secondary:[slug], parts:[label], when, status } ]
  Слаги тем и метки сводов — буквы, цифры и дефис: они становятся именами файлов задач.

Что создаётся: дерево prompts/ reports/ synthesis-spec/ synthesis/ workflows/ schemas/
inputs/ brief/ state/{tasks,results,logs}, файлы engine.json, ENGINE.md, BRIEF.md,
prompts/README.md, state/run-log.md и копии исполнителей и схем из скилла.`

const PROFILES = Object.keys(PROFILE_NORM)
const FINISHES = ['base', 'method']

// ---------------------------------------------------------------- аргументы

function parseArgs(argv) {
  const out = {
    root: '', slug: '', title: '', profile: '', finish: '', language: '',
    today: '', from: '', request: '', force: false, dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0) }
    else if (a === '--force') out.force = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--') && a.includes('=')) {
      applyFlag(out, a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1), a)
    } else if (a.startsWith('--')) {
      applyFlag(out, a.slice(2), takeValue(argv, i, a), a)
      i++
    } else die('лишний аргумент ' + a + '\n\n' + USAGE)
  }
  return out
}

function applyFlag(out, key, value, raw) {
  const map = {
    root: 'root', slug: 'slug', title: 'title', profile: 'profile',
    finish: 'finish', language: 'language', today: 'today', from: 'from', request: 'request',
  }
  const field = map[key]
  if (!field) die('неизвестный аргумент ' + raw + '\n\n' + USAGE)
  out[field] = value
}

// ---------------------------------------------------------------- answers.json

function loadAnswers(file) {
  if (!file) return {}
  const abs = resolveRoot(file)
  if (!isFile(abs)) die('не найден файл ответов интейка: ' + abs)
  const text = readText(abs)
  let data
  try { data = JSON.parse(text) } catch (e) { die('answers.json не читается как JSON (' + abs + '): ' + e.message) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) die('answers.json должен быть объектом, а не ' + (Array.isArray(data) ? 'массивом' : typeof data))
  return data
}

const KNOWN_ANSWER_KEYS = new Set([
  'root', 'slug', 'title', 'language', 'profile', 'finish', 'today', 'createdAt',
  'mission', 'perimeter', 'targetWords', 'topics', 'syntheses', 'version', 'runs', 'brief',
  'models', 'efforts', 'codexModels', 'codexEfforts',
])

// ---------------------------------------------------------------- нормализация состояния

// Лишние поля темы и свода (parts, when, свои пометки) сохраняются: их читают bankLayout
// и build-index, и раньше init молча выбрасывал их.
function normTopics(raw, warns) {
  if (!raw) return []
  if (!Array.isArray(raw)) { warns.push('поле topics в answers.json не массив — темы пропущены'); return [] }
  const out = []
  const seen = new Set()
  for (const t of raw) {
    if (!t || typeof t !== 'object' || !t.slug) { warns.push('тема без поля slug пропущена: ' + JSON.stringify(t)); continue }
    const slug = String(t.slug).trim()
    if (seen.has(slug)) { warns.push('тема ' + slug + ' встречается дважды — вторая пропущена'); continue }
    seen.add(slug)
    out.push({
      ...t,
      slug,
      title: String(t.title || slug),
      what: String(t.what || ''),
      feeds: strList(t.feeds),
      // id контрольных вопросов брифа, ради которых тема заведена
      answers: strList(t.answers),
      status: ['planned', 'researched', 'verified'].includes(t.status) ? t.status : 'planned',
    })
  }
  return out
}

function normSyntheses(raw, warns) {
  if (!raw) return []
  if (!Array.isArray(raw)) { warns.push('поле syntheses в answers.json не массив — своды пропущены'); return [] }
  const out = []
  const seen = new Set()
  for (const s of raw) {
    if (!s || typeof s !== 'object' || !(s.label || s.file)) { warns.push('свод без label и file пропущен: ' + JSON.stringify(s)); continue }
    const label = String(s.label || path.basename(String(s.file), '.md').toLowerCase()).trim()
    if (seen.has(label)) { warns.push('свод ' + label + ' встречается дважды — второй пропущен'); continue }
    seen.add(label)
    const entry = {
      ...s,
      label,
      file: String(s.file || defaultSynthFile(label)),
      title: String(s.title || label),
      primary: strList(s.primary),
      secondary: strList(s.secondary),
      status: s.status === 'done' ? 'done' : 'planned',
    }
    if ('parts' in s) entry.parts = strList(s.parts)
    out.push(entry)
  }
  return out
}

// Статус при слиянии: старший из прежнего и нового — понижение спрятало бы собранный файл.
function carryStatus(list, prev, key, rank) {
  const old = new Map((Array.isArray(prev) ? prev : []).filter(x => x && typeof x === 'object').map(x => [String(x[key]), x.status]))
  for (const x of list) {
    const o = old.get(String(x[key]))
    if (o && (rank[o] || 0) > (rank[x.status] || 0)) x.status = o
  }
  return list
}

// ---------------------------------------------------------------- рендер шаблонов

function render(text, values, file) {
  if (text == null) die('шаблон ' + file + ' не читается. Проверь права на файл и что скилл установлен целиком: ' + SKILL)
  const missing = []
  const out = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, name) => {
    if (Object.prototype.hasOwnProperty.call(values, name) && values[name] !== undefined && values[name] !== null) {
      return String(values[name])
    }
    missing.push(name)
    return ''
  })
  if (missing.length) {
    const uniq = [...new Set(missing)]
    die('в шаблоне ' + file + ' нечем заполнить плейсхолдер' + (uniq.length > 1 ? 'ы' : '') + ': ' +
      uniq.map(n => '{{' + n + '}}').join(', ') +
      '\nengine-init подставляет только каркасные значения: ' + Object.keys(values).sort().map(n => '{{' + n + '}}').join(', ') +
      '\nЛибо почини шаблон, либо добавь значение в engine-init.mjs. Пустую строку вместо плейсхолдера скрипт не пишет.')
  }
  return out
}

// Разделы «## …» документа: head — всё до первого раздела.
function splitSections(text) {
  const lines = String(text).split('\n')
  const out = { head: [], sections: [] }
  let cur = null
  for (const l of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(l)
    if (m) { cur = { title: m[1], lines: [l] }; out.sections.push(cur); continue }
    if (cur) cur.lines.push(l); else out.head.push(l)
  }
  return out
}

// Пересборка документа по шаблону с переносом живых разделов: keep — разделы, которые
// ведутся руками (журнал решений, таблицы тем и сводов); разделы, которых в шаблоне нет,
// добавлены человеком и переносятся в конец как есть.
// Старые README держали сгенерированные списки отчётов и сводов внутри «Темы → что кормят»;
// теперь у них свой раздел, который пересобирается, а в сохраняемом разделе они бы застыли.
const GENERATED_TAIL = /^\*\*Отчёты:\*\*\s*$/

function mergeDoc(existing, rendered, keep) {
  const a = splitSections(existing)
  const b = splitSections(rendered)
  const old = new Map(a.sections.map(s => [s.title, s]))
  const titles = new Set(b.sections.map(s => s.title))
  const kept = (s) => {
    const cut = titles.has('Отчёты и своды') ? s.lines.findIndex(l => GENERATED_TAIL.test(l)) : -1
    return cut > 0 ? [...s.lines.slice(0, cut), ''] : s.lines
  }
  const out = [...b.head]
  for (const s of b.sections) out.push(...(keep.includes(s.title) && old.has(s.title) ? kept(old.get(s.title)) : s.lines))
  const known = new Set(b.sections.map(s => s.title))
  for (const s of a.sections) if (!known.has(s.title)) out.push(...s.lines)
  return out.join('\n')
}

// ---------------------------------------------------------------- план записи

const plan = { created: [], kept: [], overwritten: [] }

const FS_HINT = '\nПроверь права на каталог и что --root ведёт в каталог, а не в файл.'

function mkdirSafe(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) }
  catch (e) { die('не удалось создать каталог ' + dir + ': ' + e.message + FS_HINT) }
}

function planWrite(dst, content, opt) {
  const exists = isFile(dst)
  if (exists && !opt.force) { plan.kept.push(dst); return }
  if (exists && readText(dst) === content) { plan.kept.push(dst); return }
  if (exists) plan.overwritten.push(dst); else plan.created.push(dst)
  if (opt.dryRun) return
  mkdirSafe(path.dirname(dst))
  try { fs.writeFileSync(dst, content, 'utf8') }
  catch (e) { die('не удалось записать ' + dst + ': ' + e.message + FS_HINT) }
}

function planCopyDir(src, dst, ext, opt, label) {
  if (!isDir(src)) {
    console.error('Предупреждение: в скилле нет каталога ' + src + ' — ' + label + ' не скопированы. Движок без них не прогонится.')
    return
  }
  let files
  try { files = fs.readdirSync(src).filter(f => f.endsWith(ext)).sort() }
  catch (e) { die('не удалось прочитать каталог скилла ' + src + ': ' + e.message) }
  if (!files.length) console.error('Предупреждение: в ' + src + ' нет файлов ' + ext + ' — ' + label + ' не скопированы.')
  for (const f of files) {
    let text
    try { text = fs.readFileSync(path.join(src, f), 'utf8') }
    catch (e) { die('не удалось прочитать ' + path.join(src, f) + ': ' + e.message) }
    // копии исполнителей — производные файлы скилла: обновляются всегда, руками их не правят
    planWrite(path.join(dst, f), text, { ...opt, force: true })
  }
}

// Бэкап с уникальным именем: второй --force в тот же день не затирает первый бэкап.
function backupName(src, today) {
  let dst = src + '.bak-' + today
  for (let n = 2; isFile(dst); n++) dst = src + '.bak-' + today + '-' + n
  return dst
}

// ---------------------------------------------------------------- сборка

const argv = parseArgs(process.argv.slice(2))
const answers = loadAnswers(argv.from)
const warns = []

for (const k of Object.keys(answers)) {
  if (!KNOWN_ANSWER_KEYS.has(k)) warns.push('поле ' + k + ' из answers.json движку неизвестно — пропущено')
}

const rootRaw = argv.root || answers.root || ''
if (!rootRaw) die('не задан --root <path> и в answers.json нет поля root\n\n' + USAGE)
const ROOT = resolveRoot(rootRaw)
if (isFile(ROOT)) die('по пути --root лежит файл, а не каталог: ' + ROOT + '\nДвижок — это каталог со своим деревом. Укажи другой путь или убери файл.')

const enginePath = path.join(ROOT, 'engine.json')
const runLogPath = path.join(ROOT, 'state', 'run-log.md')

// Существующий движок — основа слияния всегда: так видно, изменили бы ответы что-нибудь.
// Записывается слияние только с --force; без него engine.json не трогается.
let existing = null
let unreadable = false
if (isFile(enginePath)) {
  try { existing = JSON.parse(readText(enginePath)) } catch { existing = null }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    existing = null
    unreadable = true
    if (!argv.force) die('engine.json есть, но не читается как объект движка: ' + enginePath + '\nПочини файл или пересобери движок с --force (прежний файл уедет в бэкап).', 1)
    warns.push('engine.json не читался как объект движка — пересобран с нуля, прежний в бэкапе')
  }
}
const MERGE = Boolean(existing && argv.force)
const base = existing || {}
const given = (k) => Object.prototype.hasOwnProperty.call(answers, k)

const slug = String(argv.slug || answers.slug || base.slug || (existing && existing.slug) || '').trim()
if (!slug) die('не задан --slug <slug> и в answers.json нет поля slug\n\n' + USAGE)
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) die('слаг «' + slug + '» не годится: только строчные латинские буквы, цифры и дефис, начинается с буквы или цифры')

const profile = String(argv.profile || answers.profile || base.profile || 'M').toUpperCase()
if (!PROFILES.includes(profile)) die('--profile принимает S | M | L, получено: ' + profile)

const finish = String(argv.finish || answers.finish || base.finish || DEFAULT_FINISH)
if (!FINISHES.includes(finish)) die('--finish принимает base | method, получено: ' + finish)

const today = String(argv.today || answers.today || todayISO())
if (!isISODate(today)) die('--today ждёт дату в формате YYYY-MM-DD, получено: ' + today)

const language = String(argv.language || answers.language || base.language || 'ru')
const title = String(argv.title || answers.title || base.title || slug)

const MISSION_STUB = 'ЗАПОЛНИТЬ ДО ПЕРВОГО ПРОГОНА: 3-6 предложений — что это за движок, кому и для какой работы он нужен, что агент должен уметь на выходе. Этот текст вставляется дословно в каждый промпт конвейера, поэтому пустая миссия означает, что все агенты работают вслепую.'
const mission = String(answers.mission || base.mission || '').trim() || MISSION_STUB

const perimSrc = given('perimeter') ? answers.perimeter : base.perimeter
const perimeterIn = strList(perimSrc && perimSrc.in)
const perimeterOut = strList(perimSrc && perimSrc.out)

const tw = (given('targetWords') ? answers.targetWords : base.targetWords) || {}
const targetWords = {
  report: Number.isFinite(Number(tw.report)) && Number(tw.report) > 0 ? Number(tw.report) : DEFAULT_WORDS.report,
  synthesis: Number.isFinite(Number(tw.synthesis)) && Number(tw.synthesis) > 0 ? Number(tw.synthesis) : DEFAULT_WORDS.synthesis,
}

const topics = given('topics')
  ? carryStatus(normTopics(answers.topics, warns), base.topics, 'slug', TOPIC_RANK)
  : normTopics(base.topics, warns)
const syntheses = given('syntheses')
  ? carryStatus(normSyntheses(answers.syntheses, warns), base.syntheses, 'label', { planned: 0, done: 1 })
  : normSyntheses(base.syntheses, warns)

// Бриф: исходный запрос дословно и всё, что выяснено на интейке (references/BRIEF.md).
// id контрольных вопросов фиксируются сразу, чтобы topics[].answers ссылались на стабильные
// метки; поля вопроса сверх id/question/job сохраняются.
const briefFromAnswers = given('brief')
const briefSrc = briefFromAnswers ? answers.brief : base.brief
const briefRaw = briefSrc && typeof briefSrc === 'object' && !Array.isArray(briefSrc) ? briefSrc : {}
if (briefFromAnswers && briefRaw !== answers.brief) warns.push('поле brief в answers.json не объект — бриф пропущен')
const nb = normalizeBrief({ ...briefRaw, request: argv.request || briefRaw.request })
const rawAcceptance = Array.isArray(briefRaw.acceptance) ? briefRaw.acceptance : []
const pinned = nb.acceptance.map(a => {
  const src = rawAcceptance[a.index]
  return src && typeof src === 'object' && !Array.isArray(src) ? { ...src, id: a.id, question: a.question, job: a.job } : { id: a.id, question: a.question, job: a.job }
})
// Бриф прежнего движка без новых ответов переносится как есть: нормализация теряла бы
// свои поля у материалов и источников. Меняются только запрос (--request) и выданные id.
const keepBrief = !briefFromAnswers && base.brief && typeof base.brief === 'object' && !Array.isArray(base.brief)
const rawSources = briefRaw.sources && typeof briefRaw.sources === 'object' && !Array.isArray(briefRaw.sources) ? briefRaw.sources : {}
const rawInputs = Array.isArray(briefRaw.inputs) ? briefRaw.inputs : []
const brief = keepBrief
  ? { ...base.brief, ...(argv.request ? { request: nb.request } : {}), ...(nb.acceptance.some(a => a.autoId) ? { acceptance: pinned } : {}) }
  : {
      ...briefRaw,
      request: nb.request, restated: nb.restated, users: nb.users, jobs: nb.jobs,
      decisions: nb.decisions, deliverables: nb.deliverables,
      acceptance: pinned,
      assumptions: nb.assumptions, constraints: nb.constraints, known: nb.known,
      // свои поля материала (note, sha…) и политики источников (prefer…) сохраняются
      inputs: rawInputs.map(x => (typeof x === 'string' ? { ref: x.trim() } : x)).filter(x => x && x.ref)
        .map(x => ({ ...x, ref: String(x.ref).trim() })),
      sources: { ...rawSources, must: nb.sources.must, avoid: nb.sources.avoid },
      freshness: nb.freshness, openQuestions: nb.openQuestions,
    }

// Маршрут моделей по стадиям: умолчания из lib/engine.mjs, поверх — прежний маршрут движка,
// поверх — ответы интейка. Пишется в engine.json явно, чтобы маршрут правился в одном месте.
const pickRoute = (defaults, prev, gv, name) => {
  const out = { ...defaults }
  for (const src of [prev, gv]) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue
    for (const [k, v] of Object.entries(src)) {
      if (!ROUTE_KEYS.includes(k)) { if (src === gv) warns.push(name + '.' + k + ' — такой стадии нет, допустимы: ' + ROUTE_KEYS.join(', ')); continue }
      if (v) out[k] = String(v)
    }
  }
  return out
}
const models = pickRoute(DEFAULT_MODELS, base.models, answers.models, 'models')
const efforts = pickRoute(DEFAULT_EFFORTS, base.efforts, answers.efforts, 'efforts')
// Маршрут для Codex — отдельные поля: имена моделей у хостов разные.
const codexModels = pickRoute(CODEX_DEFAULT_MODELS, base.codexModels, answers.codexModels, 'codexModels')
const codexEfforts = pickRoute(CODEX_DEFAULT_EFFORTS, base.codexEfforts, answers.codexEfforts, 'codexEfforts')

// Слаг темы и метка свода — части имён файлов задач: с плохой меткой рендер упадёт
// посреди стадии, поэтому это ошибка сразу, а не предупреждение.
const badLabels = [
  ...topics.map(t => labelProblem(t.slug) && 'тема: ' + labelProblem(t.slug)),
  ...syntheses.map(s => labelProblem(s.label) && 'свод: ' + labelProblem(s.label)),
].filter(Boolean)
if (badLabels.length) die('метки не годятся для имён файлов задач:\n  ' + badLabels.join('\n  '))

const acceptanceIds = new Set(brief.acceptance.map(a => a.id))
for (const t of topics) {
  for (const id of t.answers) {
    if (!acceptanceIds.has(id)) warns.push('тема ' + t.slug + ' отвечает на контрольный вопрос ' + id + ', которого нет в brief.acceptance')
  }
}

// Матрицу «тема → свод» проверяем здесь, а не на рендере задач: битая ссылка, найденная
// после ресерча, стоит целой партии агентов.
const topicSlugs = new Set(topics.map(t => t.slug))
const synthLabels = new Set(syntheses.map(s => s.label))
for (const m of matrixFindings({ topics, syntheses })) warns.push(m)
for (const t of topics) {
  if (!t.feeds.length && syntheses.length) warns.push('тема ' + t.slug + ' не питает ни один свод — либо назначь ей свод в feeds, либо выкинь тему')
  if (!t.what) warns.push('у темы ' + t.slug + ' пустое поле what — эта строка идёт в списки отчётов внутри промптов, агент по ней решает, что читать')
}
// GAPS.md пишет стадия critique — primary ему не нужен. Навигатор банка фактов, собранного
// частями, ссылается в primary на метки частей, а не на темы. Роли — в lib/engine.mjs.
for (const s of syntheses) {
  if (isGaps(s)) continue
  for (const p of [...s.primary, ...s.secondary]) {
    if (topicSlugs.has(p)) continue
    if (isBankNav(s) && synthLabels.has(p)) continue
    warns.push('свод ' + s.label + ' ссылается на тему ' + p + ', которой нет в topics')
  }
  if (!s.primary.length) warns.push('у свода ' + s.label + ' пустой primary — наполнять его будет нечем')
}

if (topics.length) {
  const [tMin, tMax, sMin, sMax] = PROFILE_NORM[profile]
  if (topics.length < tMin || topics.length > tMax) warns.push('профиль ' + profile + ' рассчитан на ' + tMin + '-' + tMax + ' тем, в движке их ' + topics.length + ' — поменяй профиль или состав тем')
  if (syntheses.length && (syntheses.length < sMin || syntheses.length > sMax)) warns.push('профиль ' + profile + ' рассчитан на ' + sMin + '-' + sMax + ' ' + plural(sMax, 'свод', 'свода', 'сводов') + ', в движке их ' + syntheses.length)
}

// проверка шаблонов до первой записи: половинчатый каркас хуже, чем ни одного
const tplEngine = path.join(TEMPLATES, 'ENGINE.tmpl.md')
const tplReadme = path.join(TEMPLATES, 'prompts-README.tmpl.md')
const missingTpl = [tplEngine, tplReadme].filter(p => !isFile(p))
if (missingTpl.length) {
  die('в скилле нет шаблонов:\n  ' + missingTpl.join('\n  ') +
    '\nБез них каркас движка неполон. Проверь, что скилл установлен целиком: ' + SKILL)
}

// ---------------------------------------------------------------- значения плейсхолдеров

const reportPath = (s) => path.join(ROOT, 'reports', s + '.md')
const synthPath = (f) => path.join(ROOT, 'synthesis', f)

const listOr = (lines, empty) => (lines.length ? lines.join('\n') : '- ' + empty)

const ALL_REPORTS = listOr(
  topics.map(t => '- ' + reportPath(t.slug) + ' — ' + (t.what || t.title)),
  'тем ещё нет: декомпозиция впереди, отчёты появятся после стадии research'
)
const ALL_SYNTHESIS = listOr(
  syntheses.map(s => '- ' + synthPath(s.file) + ' — ' + (s.title || s.label)),
  'сводов ещё нет: состав проектируется на стадии декомпозиции'
)

const values = {
  ROOT,
  SKILL,
  // те же пути в кавычках для команд, которые копируют в терминал: каталог с пробелом иначе ломает строку
  ROOT_SH: shq(ROOT),
  SKILL_SH: shq(SKILL),
  SLUG: slug,
  TITLE: title,
  TODAY: today,
  LANGUAGE: language,
  MISSION: mission,
  PERIMETER_IN: perimeterIn.length ? perimeterIn.join('; ') : 'ЗАПОЛНИТЬ: что входит в периметр движка',
  PERIMETER_OUT: perimeterOut.length ? perimeterOut.join('; ') : 'ЗАПОЛНИТЬ: что явно вне периметра. Периметр без списка исключений не удерживает агентов от расползания',
  PROFILE: profile,
  FINISH: finish,
  TARGET_WORDS: String(targetWords.report),
  CORPUS_SIZE: 'корпуса пока нет: 0 отчётов, 0 сводов',
  ALL_REPORTS,
  ALL_SYNTHESIS,
}

// ---------------------------------------------------------------- содержимое файлов

const engineJson = {
  ...base,
  version: 1,
  slug,
  title,
  root: ROOT,
  language,
  profile,
  finish,
  createdAt: String(base.createdAt || answers.createdAt || today),
  today,
  mission,
  perimeter: { in: perimeterIn, out: perimeterOut },
  brief,
  models,
  efforts,
  codexModels,
  codexEfforts,
  targetWords,
  topics,
  syntheses,
  runs: Array.isArray(base.runs) ? base.runs : Array.isArray(answers.runs) ? answers.runs : [],
}

const initCmd = 'engine-init.mjs --root ' + shq(ROOT) + ' --slug ' + slug
const runLog = [
  '# Журнал прогонов — «' + title + '» (`' + slug + '`)',
  '',
  'Одна строка — одна партия, пишется сразу после прогона. По журналу восстанавливается,',
  'что уже собрано, чем и когда, и где оборвалось. Задачи — метки из',
  '`state/tasks/`. Хост — `claude` (Workflow-исполнители) или `codex` (fanout.mjs).',
  '',
  '| Дата | Стадия | Хост | Задачи | Итог | Заметка |',
  '|---|---|---|---|---|---|',
  '| ' + today + ' | init | — | — | каркас создан: профиль `' + profile + '`, финиш `' + finish + '` | `' + initCmd + '` |',
  '',
  'Партия — 3-4 тяжёлых агента. Девять параллельных агентов выжгли лимит сессии',
  'за пять минут и 2,2 млн токенов — цифра снята на сборке движка `aso`.',
  '',
].join('\n')

// ---------------------------------------------------------------- запись

const opt = { force: argv.force, dryRun: argv.dryRun }

const DIRS = [
  'prompts', 'reports', 'synthesis-spec', 'synthesis',
  'workflows', 'schemas',
  'inputs', // материалы заказчика: файлы, выгрузки, прошлые наработки — перечисляются в brief.inputs
  'brief',  // разведка предмета (brief/RECON.md) и рабочие файлы стадии брифа; в корпус не входит
  path.join('state', 'tasks'), path.join('state', 'results'), path.join('state', 'logs'),
]

const dirsMade = []
for (const d of DIRS) {
  const abs = path.join(ROOT, d)
  if (!isDir(abs)) {
    dirsMade.push(abs)
    if (!opt.dryRun) mkdirSafe(abs)
  }
}

const engineMdPath = path.join(ROOT, 'ENGINE.md')
const briefMdPath = path.join(ROOT, 'BRIEF.md')
const readmePath = path.join(ROOT, 'prompts', 'README.md')

const engineMd = render(readText(tplEngine), values, tplEngine)
const readmeMd = render(readText(tplReadme), values, tplReadme)
// Живые разделы, которые ведут руками: при пересборке они переносятся из прежнего файла.
const ENGINE_KEEP = ['Темы', 'Своды', 'Журнал решений', 'Прогоны', 'Следующая команда']
const README_KEEP = ['Цель', 'Темы → что кормят']
const contentOf = (p, fresh, keep) => (opt.force && isFile(p) ? mergeDoc(readText(p), fresh, keep) : fresh)

const outputs = [
  [enginePath, JSON.stringify(engineJson, null, 2) + '\n'],
  [engineMdPath, contentOf(engineMdPath, engineMd, ENGINE_KEEP)],
  [briefMdPath, renderBriefMd(engineJson, ROOT, topics)],
  [readmePath, contentOf(readmePath, readmeMd, README_KEEP)],
]

// --force: всё, что будет переписано, сначала уезжает в бэкап с уникальным именем.
const backups = []
if (opt.force) {
  for (const [p, content] of outputs) {
    if (!isFile(p) || readText(p) === content) continue
    const dst = backupName(p, today)
    backups.push(dst)
    if (opt.dryRun) continue
    try { fs.copyFileSync(p, dst) }
    catch (e) { die('не удалось сохранить прежний ' + path.relative(ROOT, p) + ' в ' + dst + ': ' + e.message + '\nБез бэкапа перезапись не начинаем.') }
  }
}

for (const [p, content] of outputs) planWrite(p, content, opt)

// Журнал прогонов — история: его не перезаписывает даже --force, в него встаёт строка.
if (!isFile(runLogPath)) planWrite(runLogPath, runLog, opt)
else if (opt.force) {
  plan.overwritten.push(runLogPath + ' (строка init --force)')
  if (!opt.dryRun) {
    try {
      appendRunLogRow(ROOT, [today, 'init --force', '—', '—', 'каркас пересобран слиянием: профиль `' + profile + '`, финиш `' + finish + '`, тем ' + topics.length + ', сводов ' + syntheses.length,
        backups.length ? 'бэкапы: ' + backups.map(b => path.relative(ROOT, b)).join(', ') : 'изменений в файлах нет'])
    } catch (e) { console.error('Предупреждение: строка в журнал прогонов не дописалась: ' + e.message) }
  }
} else plan.kept.push(runLogPath)

planCopyDir(WORKFLOWS_SRC, path.join(ROOT, 'workflows'), '.mjs', opt, 'исполнители Claude Code')
planCopyDir(SCHEMAS_SRC, path.join(ROOT, 'schemas'), '.json', opt, 'схемы возврата')

// ---------------------------------------------------------------- отчёт

// Без --force существующий engine.json не тронут: сводка — по нему, а не по answers.json.
const shown = existing && !argv.force ? existing : engineJson
const shownTopics = Array.isArray(shown.topics) ? shown.topics.length : 0
const shownSynth = Array.isArray(shown.syntheses) ? shown.syntheses.length : 0
// Без --force ответы не применяются; громко — только если они что-то изменили бы.
// Повторный запуск с теми же ответами — норма идемпотентного скрипта, код 0.
const comparable = (o) => JSON.stringify({ ...o, today: null, root: null })
const ignoredInput = Boolean(existing && !argv.force && comparable(engineJson) !== comparable(existing))

const head = opt.dryRun ? 'ПЛАН (--dry-run, на диск ничего не записано)' : MERGE ? 'Каркас движка пересобран слиянием' : existing ? 'Движок уже заведён' : unreadable ? 'Каркас движка пересобран с нуля' : 'Каркас движка готов'
console.log(head + ': ' + ROOT)
console.log('  тема: «' + (shown.title || title) + '» (`' + (shown.slug || slug) + '`) · профиль ' + (shown.profile || profile) + ' · финиш ' + (shown.finish || finish) + ' · язык ' + (shown.language || language) + ' · дата ' + today)
console.log('  тем в engine.json: ' + shownTopics + ' · сводов: ' + shownSynth)

const show = (label, list) => {
  if (!list.length) return
  console.log('')
  console.log(label + ' (' + list.length + '):')
  for (const p of list) console.log('  ' + path.relative(ROOT, p))
}

if (dirsMade.length) {
  console.log('')
  console.log((opt.dryRun ? 'Каталоги к созданию' : 'Созданы каталоги') + ' (' + dirsMade.length + '):')
  for (const d of dirsMade) console.log('  ' + path.relative(ROOT, d) + '/')
}
show(opt.dryRun ? 'Файлы к записи' : 'Записаны файлы', plan.created)
show(opt.dryRun ? 'Файлы к перезаписи (--force)' : 'Перезаписаны (--force)', plan.overwritten)
show('Уже были на месте — не тронуты' + (argv.force ? ' (совпадают с новой версией)' : ' (перезапись только с --force)'), plan.kept)

if (backups.length) {
  console.log('')
  console.log('Прежние версии ' + (opt.dryRun ? 'будут сохранены' : 'сохранены') + ': ' + backups.map(b => path.relative(ROOT, b)).join(', ') + '.')
}
if (MERGE) {
  console.log((backups.length ? '' : '\n') + 'engine.json ' + (opt.dryRun ? 'будет слит' : 'слит') + ': поля, которых нет в ответах, остаются прежними; статусы тем и сводов не понижаются. В ENGINE.md и prompts/README.md переносятся «Цель», журнал решений, таблицы тем и сводов и свои разделы.')
}

if (warns.length) {
  console.log('')
  console.log('Предупреждения:')
  for (const w of warns) console.log('  · ' + w)
}

if (ignoredInput) {
  console.error('')
  console.error('ВНИМАНИЕ: engine.json уже есть и оставлен как был — ' + (argv.from ? 'ответы из ' + argv.from : 'флаги командной строки') + ' НЕ применены.')
  console.error('Применить их поверх с сохранением брифа, статусов и журнала: повтори с --force. Матрицу тем после брифа удобнее править прямо в engine.json и проверять brief.mjs и audit.mjs --stage prompts.')
  process.exitCode = 1
}

const node = (name) => 'node ' + shq(path.join(SKILL, 'scripts', name))
const R = shq(ROOT)
const todo = []
const bf = briefFindings(shown, ROOT)
if (bf.blockers.length) {
  const hasRequest = Boolean(bf.brief.request || bf.brief.restated)
  todo.push('стадия брифа по references/BRIEF.md: разбор запроса, ' +
    (hasRequest ? 'разведка (' + node('render-tasks.mjs') + ' --root ' + R + ' --stage recon)' : 'исходный запрос в brief.request (без него разведке не с чего начать)') +
    ', вопросы заказчику о работе базы, материалы в inputs/, контрольные вопросы. Не закрыто пунктов: ' +
    bf.blockers.length + ' — список печатает ' + node('brief.mjs') + ' --root ' + R)
  todo.push('покажи BRIEF.md пользователю — точка останова: без утверждённого брифа декомпозицию не начинаем')
}
if (!shownTopics) todo.push('разрежь тему на ТЗ: `prompts/<NN-slug>.md` по `templates/prompt.tmpl.md`, темы — в `topics` engine.json (каждой — answers: id контрольных вопросов)')
if (!shownSynth) todo.push('спроектируй своды: `synthesis-spec/<label>.md` по `templates/synthesis-spec.tmpl.md`, своды — в `syntheses` engine.json')

console.log('')
console.log('Дальше:')
let n = 0
for (const t of todo) console.log('  ' + (++n) + '. ' + t)
console.log('  ' + (++n) + '. покажи пользователю периметр и карту тем — это точка останова, дальше без подтверждения не идём')
console.log('  ' + (++n) + '. ' + node('render-tasks.mjs') + ' --root ' + R + ' --stage research — задачи ресерчеров и верификаторов; печатает args первой партии')
console.log('  ' + (++n) + '. партия 3-4 темы: Workflow ' + path.join(ROOT, 'workflows', 'research.mjs') + ' (Claude Code: ресерч и следом верификация) или в Codex два прогона — ' +
  node('fanout.mjs') + ' --root ' + R + ' --stage research --labels … --engine codex, затем --stage verify')
console.log('  ' + (++n) + '. после каждой партии: ' + node('status.mjs') + ' --root ' + R + ' (статусы по диску и следующая команда; расход — --record), затем ' + node('audit.mjs') + ' --root ' + R)

if (plan.kept.length && !opt.force && !ignoredInput) {
  console.log('')
  console.log('Файлы из списка «уже были» оставлены как есть. Обновить каркас поверх с сохранением состояния — повтори с --force.')
}

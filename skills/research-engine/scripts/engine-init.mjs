#!/usr/bin/env node
// engine-init.mjs — каркас движка ресерча: дерево каталогов из контракта, engine.json,
// ENGINE.md, prompts/README.md, state/run-log.md и копии workflows/ и schemas/ из скилла.
// Node 18+, ESM, без зависимостей. Идемпотентен: без --force ничего не перезаписывает.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL = path.resolve(HERE, '..')            // корень скилла: .../skills/research-engine
const TEMPLATES = path.join(SKILL, 'templates')
const WORKFLOWS_SRC = path.join(SKILL, 'workflows')
const SCHEMAS_SRC = path.join(SKILL, 'schemas')

const USAGE = `engine-init.mjs — заводит каркас движка ресерча в <root>.

  node engine-init.mjs --root <path> --slug <slug> [--title "..."] [--profile S|M|L]
                       [--finish base|method] [--language ru] [--today YYYY-MM-DD]
                       [--from <answers.json>] [--force] [--dry-run]

  --root      каталог движка. Обязателен (или root в answers.json).
  --slug      машинное имя движка: строчные латинские буквы, цифры, дефис. Обязателен.
  --title     человеческое название темы. По умолчанию равно --slug.
  --profile   S (5-6 тем, 3-4 свода) | M (8-10 / 6-9, по умолчанию) | L (13-16, банк частями)
  --finish    base (останов после GAPS.md) | method (плюс METHOD.md и AGENT.md, по умолчанию)
  --language  язык корпуса, по умолчанию ru
  --today     дата сборки YYYY-MM-DD, по умолчанию сегодняшняя
  --from      answers.json с итогами интейка; флаги командной строки перекрывают его поля
  --force     перезаписать существующие файлы (engine.json сначала уедет в .bak-<дата>)
  --dry-run   напечатать план и не писать ничего
  --help      эта справка

answers.json — объект с любым подмножеством полей engine.json:
  root, slug, title, language, profile, finish, today, mission,
  perimeter { in: [...], out: [...] }, targetWords { report, synthesis },
  topics [ { slug, title, what, feeds:[label], status } ],
  syntheses [ { label, file, title, primary:[slug], secondary:[slug], status } ]

Что создаётся: дерево prompts/ reports/ synthesis-spec/ synthesis/ workflows/ schemas/
state/{tasks,results,logs}, файлы engine.json, ENGINE.md, prompts/README.md,
state/run-log.md и копии исполнителей и схем из скилла.`

const PROFILES = ['S', 'M', 'L']
const FINISHES = ['base', 'method']

// ---------------------------------------------------------------- утилиты

function die(msg, code = 2) {
  console.error('Ошибка: ' + msg)
  process.exit(code)
}

function isDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }
function isFile(p) { try { return fs.statSync(p).isFile() } catch { return false } }
function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return null } }

function todayISO() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// ---------------------------------------------------------------- аргументы

function parseArgs(argv) {
  const out = {
    root: '', slug: '', title: '', profile: '', finish: '', language: '',
    today: '', from: '', force: false, dryRun: false,
  }
  const take = (name, i) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) die('у аргумента ' + name + ' нет значения')
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0) }
    else if (a === '--force') out.force = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--') && a.includes('=')) {
      const k = a.slice(2, a.indexOf('='))
      const v = a.slice(a.indexOf('=') + 1)
      applyFlag(out, k, v, a)
    } else if (a.startsWith('--')) {
      const k = a.slice(2)
      applyFlag(out, k, take(a, i), a)
      i++
    } else die('лишний аргумент ' + a + '\n\n' + USAGE)
  }
  return out
}

function applyFlag(out, key, value, raw) {
  const map = {
    root: 'root', slug: 'slug', title: 'title', profile: 'profile',
    finish: 'finish', language: 'language', today: 'today', from: 'from',
  }
  const field = map[key]
  if (!field) die('неизвестный аргумент ' + raw + '\n\n' + USAGE)
  out[field] = value
}

// ---------------------------------------------------------------- answers.json

function loadAnswers(file) {
  if (!file) return {}
  const abs = path.resolve(file)
  if (!isFile(abs)) die('не найден файл ответов интейка: ' + abs)
  const text = readText(abs)
  let data
  try { data = JSON.parse(text) } catch (e) { die('answers.json не читается как JSON (' + abs + '): ' + e.message) }
  if (!data || typeof data !== 'object' || Array.isArray(data)) die('answers.json должен быть объектом, а не ' + (Array.isArray(data) ? 'массивом' : typeof data))
  return data
}

const KNOWN_ANSWER_KEYS = new Set([
  'root', 'slug', 'title', 'language', 'profile', 'finish', 'today', 'createdAt',
  'mission', 'perimeter', 'targetWords', 'topics', 'syntheses', 'version', 'runs',
])

// ---------------------------------------------------------------- нормализация состояния

function strList(v) {
  if (!v) return []
  const arr = Array.isArray(v) ? v : [v]
  return arr.map(x => String(x).trim()).filter(Boolean)
}

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
      slug,
      title: String(t.title || slug),
      what: String(t.what || ''),
      feeds: strList(t.feeds),
      status: ['planned', 'researched', 'verified'].includes(t.status) ? t.status : 'planned',
    })
  }
  return out
}

function defaultFile(label) {
  return String(label).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.md'
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
    out.push({
      label,
      file: String(s.file || defaultFile(label)),
      title: String(s.title || label),
      primary: strList(s.primary),
      secondary: strList(s.secondary),
      status: s.status === 'done' ? 'done' : 'planned',
    })
  }
  return out
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
    planWrite(path.join(dst, f), text, opt)
  }
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
const ROOT = path.resolve(rootRaw)
if (isFile(ROOT)) die('по пути --root лежит файл, а не каталог: ' + ROOT + '\nДвижок — это каталог со своим деревом. Укажи другой путь или убери файл.')

const slug = String(argv.slug || answers.slug || '').trim()
if (!slug) die('не задан --slug <slug> и в answers.json нет поля slug\n\n' + USAGE)
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) die('слаг «' + slug + '» не годится: только строчные латинские буквы, цифры и дефис, начинается с буквы или цифры')

const profile = String(argv.profile || answers.profile || 'M').toUpperCase()
if (!PROFILES.includes(profile)) die('--profile принимает S | M | L, получено: ' + profile)

const finish = String(argv.finish || answers.finish || 'method')
if (!FINISHES.includes(finish)) die('--finish принимает base | method, получено: ' + finish)

const today = String(argv.today || answers.today || todayISO())
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) die('--today ждёт дату в формате YYYY-MM-DD, получено: ' + today)

const language = String(argv.language || answers.language || 'ru')
const title = String(argv.title || answers.title || slug)

const MISSION_STUB = 'ЗАПОЛНИТЬ ДО ПЕРВОГО ПРОГОНА: 3-6 предложений — что это за движок, кому и для какой работы он нужен, что агент должен уметь на выходе. Этот текст вставляется дословно в каждый промпт конвейера, поэтому пустая миссия означает, что все агенты работают вслепую.'
const mission = String(answers.mission || '').trim() || MISSION_STUB

const perimeterIn = strList(answers.perimeter && answers.perimeter.in)
const perimeterOut = strList(answers.perimeter && answers.perimeter.out)

const tw = answers.targetWords || {}
const targetWords = {
  report: Number.isFinite(Number(tw.report)) && Number(tw.report) > 0 ? Number(tw.report) : 3500,
  synthesis: Number.isFinite(Number(tw.synthesis)) && Number(tw.synthesis) > 0 ? Number(tw.synthesis) : 6000,
}

const topics = normTopics(answers.topics, warns)
const syntheses = normSyntheses(answers.syntheses, warns)

// Матрицу «тема → свод» проверяем здесь, а не на рендере задач: битая ссылка, найденная
// после ресерча, стоит целой партии агентов.
const topicSlugs = new Set(topics.map(t => t.slug))
const synthLabels = new Set(syntheses.map(s => s.label))
for (const t of topics) {
  for (const f of t.feeds) {
    if (!synthLabels.has(f)) warns.push('тема ' + t.slug + ' питает свод ' + f + ', которого нет в syntheses')
  }
  if (!t.feeds.length && syntheses.length) warns.push('тема ' + t.slug + ' не питает ни один свод — либо назначь ей свод в feeds, либо выкинь тему')
  if (!t.what) warns.push('у темы ' + t.slug + ' пустое поле what — эта строка идёт в списки отчётов внутри промптов, агент по ней решает, что читать')
}
// GAPS.md стоит в syntheses как файл движка, но пишет его стадия critique — primary ему не нужен.
// Навигатор банка фактов, собранного частями, ссылается в primary на метки частей, а не на темы.
const isGaps = (s) => /^GAPS\.md$/i.test(s.file) || s.label === 'gaps'
const isBankNav = (s) => /^FACTS-BANK\.md$/i.test(s.file) || s.label === 'facts-bank'
for (const s of syntheses) {
  if (isGaps(s)) continue
  for (const p of [...s.primary, ...s.secondary]) {
    if (topicSlugs.has(p)) continue
    if (isBankNav(s) && synthLabels.has(p)) continue
    warns.push('свод ' + s.label + ' ссылается на тему ' + p + ', которой нет в topics')
  }
  if (!s.primary.length) warns.push('у свода ' + s.label + ' пустой primary — наполнять его будет нечем')
}

const NORM = { S: [5, 6, 3, 4], M: [8, 10, 6, 9], L: [13, 16, 6, 12] }
if (topics.length) {
  const [tMin, tMax, sMin, sMax] = NORM[profile]
  if (topics.length < tMin || topics.length > tMax) warns.push('профиль ' + profile + ' рассчитан на ' + tMin + '-' + tMax + ' тем, в answers.json их ' + topics.length + ' — поменяй профиль или состав тем')
  const sWord = sMax >= 2 && sMax <= 4 ? ' свода' : ' сводов'
  if (syntheses.length && (syntheses.length < sMin || syntheses.length > sMax)) warns.push('профиль ' + profile + ' рассчитан на ' + sMin + '-' + sMax + sWord + ', в answers.json их ' + syntheses.length)
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
  version: 1,
  slug,
  title,
  root: ROOT,
  language,
  profile,
  finish,
  createdAt: String(answers.createdAt || today),
  today,
  mission,
  perimeter: { in: perimeterIn, out: perimeterOut },
  targetWords,
  topics,
  syntheses,
  runs: Array.isArray(answers.runs) ? answers.runs : [],
}

const runLog = [
  '# Журнал прогонов — «' + title + '» (`' + slug + '`)',
  '',
  'Одна строка — одна партия, пишется сразу после прогона. По журналу восстанавливается,',
  'что уже собрано, чем и когда, и где оборвалось. Задачи — метки из',
  '`state/tasks/`. Хост — `claude` (Workflow-исполнители) или `codex` (fanout.mjs).',
  '',
  '| Дата | Стадия | Хост | Задачи | Итог | Заметка |',
  '|---|---|---|---|---|---|',
  '| ' + today + ' | init | — | — | каркас создан: профиль `' + profile + '`, финиш `' + finish + '` | `engine-init.mjs --root ' + ROOT + ' --slug ' + slug + '` |',
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

const enginePath = path.join(ROOT, 'engine.json')
const runLogPath = path.join(ROOT, 'state', 'run-log.md')

// --force сносит состояние и журнал прогонов: и то и другое сначала уезжает в .bak-<дата>,
// иначе перезапуск init стирает единственную запись о том, что уже собрано.
const backups = []
for (const src of [enginePath, runLogPath]) {
  if (!isFile(src) || !opt.force) continue
  const dst = src + '.bak-' + today
  backups.push(dst)
  if (opt.dryRun) continue
  try { fs.copyFileSync(src, dst) }
  catch (e) { die('не удалось сохранить прежний ' + path.relative(ROOT, src) + ' в ' + dst + ': ' + e.message + '\nБез бэкапа перезапись не начинаем.') }
}

planWrite(enginePath, JSON.stringify(engineJson, null, 2) + '\n', opt)
planWrite(path.join(ROOT, 'ENGINE.md'), render(readText(tplEngine), values, tplEngine), opt)
planWrite(path.join(ROOT, 'prompts', 'README.md'), render(readText(tplReadme), values, tplReadme), opt)
planWrite(runLogPath, runLog, opt)

planCopyDir(WORKFLOWS_SRC, path.join(ROOT, 'workflows'), '.mjs', opt, 'исполнители Claude Code')
planCopyDir(SCHEMAS_SRC, path.join(ROOT, 'schemas'), '.json', opt, 'схемы возврата')

// ---------------------------------------------------------------- отчёт

const head = opt.dryRun ? 'ПЛАН (--dry-run, на диск ничего не записано)' : 'Каркас движка готов'
console.log(head + ': ' + ROOT)
console.log('  тема: «' + title + '» (`' + slug + '`) · профиль ' + profile + ' · финиш ' + finish + ' · язык ' + language + ' · дата ' + today)
console.log('  тем в engine.json: ' + topics.length + ' · сводов: ' + syntheses.length)

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
show('Уже были на месте — не тронуты (перезапись только с --force)', plan.kept)

if (backups.length) {
  console.log('')
  console.log('Внимание: engine.json и журнал прогонов пересобраны с нуля — статусы тем, состав сводов, runs и строки журнала заменены на каркасные.')
  console.log('Прежние версии целиком: ' + backups.map(b => path.relative(ROOT, b)).join(', ') + '. Нужны прежние статусы и история прогонов — перенеси их руками из бэкапа.')
}

if (warns.length) {
  console.log('')
  console.log('Предупреждения по answers.json:')
  for (const w of warns) console.log('  · ' + w)
}

const todo = []
if (mission === MISSION_STUB) todo.push('заполни `mission` в engine.json — она дословно уходит в каждый промпт')
if (!perimeterIn.length || !perimeterOut.length) todo.push('заполни `perimeter.in` и `perimeter.out` — периметр без списка исключений не удерживает агентов')
if (!topics.length) todo.push('разрежь тему на ТЗ: `prompts/<NN-slug>.md` по `templates/prompt.tmpl.md`, темы — в `topics` engine.json')
if (!syntheses.length) todo.push('спроектируй своды: `synthesis-spec/<label>.md` по `templates/synthesis-spec.tmpl.md`, своды — в `syntheses` engine.json')

console.log('')
console.log('Дальше:')
let n = 0
for (const t of todo) console.log('  ' + (++n) + '. ' + t)
console.log('  ' + (++n) + '. покажи пользователю периметр и карту тем — это точка останова, дальше без подтверждения не идём')
console.log('  ' + (++n) + '. node ' + path.join(SKILL, 'scripts', 'render-tasks.mjs') + ' --root ' + ROOT + ' --stage research')
console.log('  ' + (++n) + '. прогон партией 3-4 задачи: Workflow ' + ROOT + '/workflows/research.mjs (Claude Code) или node ' + path.join(SKILL, 'scripts', 'fanout.mjs') + ' --root ' + ROOT + ' --stage research --engine codex')
console.log('  ' + (++n) + '. после каждой партии: node ' + path.join(SKILL, 'scripts', 'audit.mjs') + ' --root ' + ROOT + ' и строка в state/run-log.md')

if (plan.kept.length && !opt.force) {
  console.log('')
  console.log('Файлы из списка «уже были» оставлены как есть. Нужно обновить каркас поверх — повтори с --force.')
}

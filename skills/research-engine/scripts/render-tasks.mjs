#!/usr/bin/env node
// render-tasks.mjs — рендер файлов задач state/tasks/<label>.md из templates/<stage>.task.md.
// Единственный способ появления промптов агентов: руками они не пишутся, иначе два хоста
// разъезжаются и повторный прогон перестаёт быть воспроизводимым.
// Node 18+, ESM, без зависимостей.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL = path.resolve(HERE, '..')
const TEMPLATES = path.join(SKILL, 'templates')

const STAGES = ['research', 'verify', 'synth', 'merge', 'critique', 'method', 'agent-doc']

const USAGE = `render-tasks.mjs — рендерит файлы задач движка из шаблонов стадии.

  node render-tasks.mjs --root <path> --stage research|verify|synth|merge|critique|method|agent-doc
                        [--labels a,b] [--force] [--dry-run]

  --root     каталог движка (в нём лежит engine.json). Обязателен.
  --stage    какую стадию рендерить. Обязателен.
  --labels   ограничить набор: через запятую, полные метки (research__01-slug)
             или короткие имена (01-slug, field-spec).
  --force    перезаписать уже отрендеренные файлы задач
  --dry-run  всё отрендерить, ничего не записать; при одной задаче напечатать текст целиком
  --help     эта справка

Метки стадий (контракт движка):
  research   research__<topic-slug>   verify   verify__<topic-slug>
  synth      synth__<label>           merge    merge__facts-bank
  critique   critique__gaps           method   method__method
  agent-doc  method__agent

Файл задачи: <root>/state/tasks/<label>.md. Результат агента: <root>/state/results/<label>.json —
его пишет сам агент последним действием, чтобы возврат жил на диске независимо от хоста.
Неподставленный плейсхолдер — ошибка с именем и файлом, а не пустая строка в промпте.`

// ---------------------------------------------------------------- утилиты

function die(msg, code = 2) {
  console.error('Ошибка: ' + msg)
  process.exit(code)
}

function isDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }
function isFile(p) { try { return fs.statSync(p).isFile() } catch { return false } }
function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const countWords = (t) => (t ? (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length : 0)
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}
const words = (w) => (w >= 10000 ? fmt(Math.round(w / 1000)) + ' тыс. слов' : fmt(w) + ' ' + plural(w, 'слово', 'слова', 'слов'))

// плейсхолдеры контракта: всё, чего нет в этом списке, — опечатка в шаблоне
const CONTRACT = new Set([
  'ROOT', 'SLUG', 'TITLE', 'TODAY', 'LANGUAGE', 'MISSION', 'PERIMETER_IN', 'PERIMETER_OUT',
  'PROFILE', 'FINISH', 'LABEL', 'TOPIC_SLUG', 'TOPIC_TITLE', 'PROMPT_PATH', 'REPORT_PATH',
  'RESULT_PATH', 'SPEC_PATH', 'OUT_PATH', 'TARGET_WORDS', 'PRIMARY_LIST', 'SECONDARY_LIST',
  'OTHER_LIST', 'ALL_REPORTS', 'ALL_SYNTHESIS', 'SYNTH_LABEL', 'CORPUS_SIZE',
])

// ---------------------------------------------------------------- аргументы

function parseArgs(argv) {
  const out = { root: '', stage: '', labels: [], force: false, dryRun: false }
  const take = (name, i) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) die('у аргумента ' + name + ' нет значения')
    return v
  }
  const set = (key, value, raw) => {
    if (key === 'root') out.root = value
    else if (key === 'stage') out.stage = value
    else if (key === 'labels') out.labels = value.split(',').map(s => s.trim()).filter(Boolean)
    else die('неизвестный аргумент ' + raw + '\n\n' + USAGE)
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0) }
    else if (a === '--force') out.force = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a.startsWith('--') && a.includes('=')) set(a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1), a)
    else if (a.startsWith('--')) { set(a.slice(2), take(a, i), a); i++ }
    else die('лишний аргумент ' + a + '\n\n' + USAGE)
  }
  if (!out.root) die('не задан --root <path>\n\n' + USAGE)
  if (!out.stage) die('не задан --stage ' + STAGES.join('|') + '\n\n' + USAGE)
  if (!STAGES.includes(out.stage)) die('--stage принимает ' + STAGES.join(' | ') + ', получено: ' + out.stage)
  out.root = path.resolve(out.root)
  if (!isDir(out.root)) die('каталог движка не найден: ' + out.root)
  return out
}

const argv = parseArgs(process.argv.slice(2))
const ROOT = argv.root
const STAGE = argv.stage

// ---------------------------------------------------------------- состояние движка

const enginePath = path.join(ROOT, 'engine.json')
const engineText = readText(enginePath)
if (engineText == null) die('нет файла engine.json в ' + ROOT + ' — движок не заведён или указан не тот --root. Заводится он так: node ' + path.join(SKILL, 'scripts', 'engine-init.mjs') + ' --root ' + ROOT + ' --slug <slug>')
let engine
try { engine = JSON.parse(engineText) } catch (e) { die('engine.json не читается как JSON: ' + e.message) }
if (!engine || typeof engine !== 'object' || Array.isArray(engine)) {
  die('engine.json должен быть объектом состояния движка, а не ' + (Array.isArray(engine) ? 'массивом' : typeof engine) +
    ' (' + enginePath + '). Пересобери каркас: node ' + path.join(SKILL, 'scripts', 'engine-init.mjs') + ' --root ' + ROOT + ' --slug <slug> --force')
}

const topics = (Array.isArray(engine.topics) ? engine.topics : []).filter(t => t && t.slug)
const syntheses = (Array.isArray(engine.syntheses) ? engine.syntheses : []).filter(s => s && (s.label || s.file))
const topicBySlug = new Map(topics.map(t => [String(t.slug), t]))

const targetWords = engine.targetWords || {}
const reportWords = Number(targetWords.report) > 0 ? Number(targetWords.report) : 3500
const synthWords = Number(targetWords.synthesis) > 0 ? Number(targetWords.synthesis) : 6000

const perim = engine.perimeter || {}
const joinList = (v, empty) => {
  const arr = Array.isArray(v) ? v.map(String).filter(Boolean) : (v ? [String(v)] : [])
  return arr.length ? arr.join('; ') : empty
}

const missionText = String(engine.mission || '').trim()
if (!missionText) die('в engine.json пустая mission. Она вставляется дословно в каждый промпт: без неё агенты работают вслепую. Заполни 3-6 предложений и повтори рендер.')
// engine-init кладёт в mission заглушку «ЗАПОЛНИТЬ...» — в промпт она уйдёт дословно и агент получит инструкцию вместо задачи
if (/^ЗАПОЛНИТЬ/i.test(missionText)) die('в engine.json вместо mission стоит заглушка engine-init («' + missionText.slice(0, 40) + '…»). Она уйдёт в каждый промпт дословно. Напиши 3-6 предложений: что за движок, кому и для какой работы, — и повтори рендер.')

// ---------------------------------------------------------------- пути и списки

const reportPath = (slug) => path.join(ROOT, 'reports', slug + '.md')
const promptPath = (slug) => path.join(ROOT, 'prompts', slug + '.md')
const specPath = (label) => path.join(ROOT, 'synthesis-spec', label + '.md')
const synthFile = (s) => path.join(ROOT, 'synthesis', String(s.file || String(s.label).toUpperCase() + '.md'))
const taskPath = (label) => path.join(ROOT, 'state', 'tasks', label + '.md')
const resultPath = (label) => path.join(ROOT, 'state', 'results', label + '.json')

const whatOf = (t) => String(t.what || t.title || t.slug)
const mark = (p) => (isFile(p) ? '' : ' (файла пока нет)')

const reportLine = (t) => '- ' + reportPath(t.slug) + ' — ' + whatOf(t) + mark(reportPath(t.slug))
const synthLine = (s) => '- ' + synthFile(s) + ' — ' + String(s.title || s.label) + mark(synthFile(s))

const listOr = (lines, empty) => (lines.length ? lines.join('\n') : '- ' + empty)

// корпус на диске: цифра для промпта берётся из файлов, а не из головы
function dirStats(dir) {
  let files = 0, w = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f === 'README.md') continue
      const t = readText(path.join(dir, f))
      if (t == null) continue
      files++; w += countWords(t)
    }
  } catch { /* каталога нет — ноль */ }
  return { files, w }
}

const rep = dirStats(path.join(ROOT, 'reports'))
const syn = dirStats(path.join(ROOT, 'synthesis'))
const CORPUS_SIZE = !rep.files && !syn.files
  ? 'на диске пока пусто — 0 отчётов, 0 сводов'
  : (rep.files ? rep.files + ' ' + plural(rep.files, 'отчёт', 'отчёта', 'отчётов') + ', ' + words(rep.w) : 'отчётов на диске нет') +
    '; ' + (syn.files ? syn.files + ' ' + plural(syn.files, 'свод', 'свода', 'сводов') + ', ' + words(syn.w) : 'сводов на диске пока нет')

const ALL_REPORTS = listOr(topics.map(reportLine), 'тем в engine.json нет: сначала декомпозиция')
const ALL_SYNTHESIS = listOr(syntheses.map(synthLine), 'сводов в engine.json нет: сначала спроектируй их состав')

// общие значения — есть на любой стадии
const COMMON = {
  ROOT,
  SLUG: String(engine.slug || path.basename(ROOT)),
  TITLE: String(engine.title || engine.slug || path.basename(ROOT)),
  TODAY: String(engine.today || engine.createdAt || ''),
  LANGUAGE: String(engine.language || 'ru'),
  MISSION: missionText,
  PERIMETER_IN: joinList(perim.in, 'периметр не задан — заполни perimeter.in в engine.json'),
  PERIMETER_OUT: joinList(perim.out, 'исключения не заданы — заполни perimeter.out в engine.json'),
  PROFILE: String(engine.profile || 'M'),
  FINISH: String(engine.finish || 'method'),
  CORPUS_SIZE,
  ALL_REPORTS,
  ALL_SYNTHESIS,
}
if (!COMMON.TODAY) die('в engine.json нет поля today (дата сборки). Промпты без даты разрешают агенту опираться на устаревшую память — поставь дату и повтори рендер.')

// ---------------------------------------------------------------- банк фактов частями

const isBankPart = (s) => /^FACTS-BANK-/i.test(String(s.file || ''))
// GAPS.md стоит в syntheses как файл движка, но пишет его стадия critique — стадии synth он не задача
const isGaps = (s) => /^GAPS\.md$/i.test(String(s.file || '')) || String(s.label) === 'gaps'
const bankEntry = syntheses.find(s => String(s.label) === 'facts-bank' || /^FACTS-BANK\.md$/i.test(String(s.file || '')))
const declaredParts = bankEntry
  ? [...(Array.isArray(bankEntry.primary) ? bankEntry.primary : []), ...(Array.isArray(bankEntry.parts) ? bankEntry.parts : [])]
      .map(String).map(l => syntheses.find(s => String(s.label) === l)).filter(Boolean)
  : []
const bankParts = declaredParts.length ? declaredParts : syntheses.filter(isBankPart)

// ---------------------------------------------------------------- сборка задач стадии

function topicTasks(prefix) {
  if (!topics.length) die('в engine.json нет тем: стадия ' + STAGE + ' рендерить нечего. Сначала декомпозиция — ТЗ в prompts/ и темы в topics.')
  return topics.map(t => ({
    label: prefix + '__' + t.slug,
    short: String(t.slug),
    values: {
      TOPIC_SLUG: String(t.slug),
      TOPIC_TITLE: String(t.title || t.slug),
      PROMPT_PATH: promptPath(t.slug),
      REPORT_PATH: reportPath(t.slug),
      TARGET_WORDS: String(reportWords),
    },
    needs: prefix === 'research'
      ? [{ p: promptPath(t.slug), what: 'ТЗ ресерча' }]
      : [{ p: promptPath(t.slug), what: 'ТЗ ресерча' }, { p: reportPath(t.slug), what: 'отчёт для верификации' }],
  }))
}

function synthTasks() {
  if (!syntheses.length) die('в engine.json нет сводов: рендерить нечего. Спроектируй состав сводов и внеси их в syntheses.')
  const list = syntheses.filter(s => !(bankParts.length && bankEntry && s === bankEntry) && !isGaps(s))
  if (!list.length) die('на стадии synth рендерить нечего: в syntheses остались только навигатор банка фактов (его собирает стадия merge) и GAPS.md (его пишет стадия critique).')
  return list.map(s => {
    const label = String(s.label)
    const primary = (Array.isArray(s.primary) ? s.primary : []).map(String)
    const secondary = (Array.isArray(s.secondary) ? s.secondary : []).map(String)
    for (const slug of [...primary, ...secondary]) {
      if (!topicBySlug.has(slug)) {
        die('свод ' + label + ' ссылается на тему ' + slug + ', которой нет в topics engine.json. Почини матрицу «тема → свод»: свод без своей темы соберётся из воздуха.')
      }
    }
    if (!primary.length) die('у свода ' + label + ' пустой primary. Свод без обязательных отчётов наполнять нечем — назначь ему темы в engine.json.')
    const inUse = new Set([...primary, ...secondary])
    return {
      label: 'synth__' + label,
      short: label,
      values: {
        SYNTH_LABEL: String(s.title || label),
        SPEC_PATH: specPath(label),
        OUT_PATH: synthFile(s),
        TARGET_WORDS: String(synthWords),
        PRIMARY_LIST: primary.map(x => reportLine(topicBySlug.get(x))).join('\n'),
        SECONDARY_LIST: listOr(secondary.map(x => reportLine(topicBySlug.get(x))), 'периферии нет: весь относящийся корпус уже в обязательных'),
        OTHER_LIST: listOr(topics.filter(t => !inUse.has(String(t.slug))).map(reportLine), 'остального корпуса нет: свод опирается на все темы движка'),
      },
      needs: [{ p: specPath(label), what: 'ТЗ на свод' }],
    }
  })
}

function singleTask(label, values, needs) {
  return [{ label, short: label.split('__')[1] || label, values, needs: needs || [] }]
}

function buildTasks() {
  if (STAGE === 'research') return topicTasks('research')
  if (STAGE === 'verify') return topicTasks('verify')
  if (STAGE === 'synth') return synthTasks()
  if (STAGE === 'merge') {
    if (!bankParts.length) {
      die('стадия merge нужна только когда банк фактов собран частями, а в engine.json нет ни одного свода с файлом FACTS-BANK-<часть>.md. ' +
        'Либо банк собирается одним сводом (тогда стадия merge не нужна), либо заведи части и повтори.')
    }
    const out = bankEntry ? synthFile(bankEntry) : path.join(ROOT, 'synthesis', 'FACTS-BANK.md')
    return singleTask('merge__facts-bank', {
      OUT_PATH: out,
      TARGET_WORDS: String(synthWords),
      PRIMARY_LIST: bankParts.map(synthLine).join('\n'),
      SECONDARY_LIST: listOr(syntheses.filter(s => !bankParts.includes(s) && s !== bankEntry).map(synthLine), 'других сводов в движке нет'),
      OTHER_LIST: listOr(topics.map(reportLine), 'отчётов в движке нет'),
    }, bankParts.map(s => ({ p: synthFile(s), what: 'часть банка' })))
  }
  if (STAGE === 'critique') {
    const gaps = syntheses.find(isGaps)
    return singleTask('critique__gaps', {
      OUT_PATH: gaps ? synthFile(gaps) : path.join(ROOT, 'synthesis', 'GAPS.md'),
      TARGET_WORDS: String(synthWords),
    })
  }
  if (STAGE === 'method') {
    return singleTask('method__method', {
      OUT_PATH: path.join(ROOT, 'METHOD.md'),
      TARGET_WORDS: String(synthWords),
    }, [{ p: path.join(ROOT, 'synthesis', 'GAPS.md'), what: 'вердикт критика полноты' }])
  }
  return singleTask('method__agent', {
    OUT_PATH: path.join(ROOT, 'AGENT.md'),
    TARGET_WORDS: String(synthWords),
  }, [{ p: path.join(ROOT, 'METHOD.md'), what: 'методика, вход в которую пишется' }])
}

let tasks = buildTasks()

if (STAGE !== 'research' && STAGE !== 'verify' && STAGE !== 'synth' && String(engine.finish || 'method') === 'base' && (STAGE === 'method' || STAGE === 'agent-doc')) {
  console.error('Предупреждение: у движка finish = base — конвейер задуман с остановом после GAPS.md. Стадия ' + STAGE + ' рендерится, но убедись, что это осознанное решение.')
}

// ---------------------------------------------------------------- фильтр --labels

if (argv.labels.length) {
  const byName = new Map()
  for (const t of tasks) { byName.set(t.label, t); byName.set(t.short, t) }
  const picked = []
  for (const name of argv.labels) {
    const t = byName.get(name)
    if (!t) {
      die('метка ' + name + ' на стадии ' + STAGE + ' неизвестна. Доступны: ' +
        tasks.map(x => x.short).join(', ') + ' (полные имена: ' + tasks.map(x => x.label).join(', ') + ')')
    }
    if (!picked.includes(t)) picked.push(t)
  }
  tasks = picked
}

// ---------------------------------------------------------------- рендер

const tplPath = path.join(TEMPLATES, STAGE + '.task.md')
const tpl = readText(tplPath)
if (tpl == null) die('нет шаблона стадии: ' + tplPath + '\nПроверь, что скилл установлен целиком: ' + SKILL)

function render(task) {
  const values = { ...COMMON, ...task.values, LABEL: task.label, RESULT_PATH: resultPath(task.label) }
  const unknown = []
  const inapplicable = []
  const text = tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, name) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return String(values[name])
    if (CONTRACT.has(name)) inapplicable.push(name); else unknown.push(name)
    return ''
  })
  if (unknown.length) {
    die('неизвестный плейсхолдер ' + [...new Set(unknown)].map(n => '{{' + n + '}}').join(', ') +
      ' в шаблоне ' + tplPath + ': в контракте движка такого нет. Допустимые: ' +
      [...CONTRACT].sort().map(n => '{{' + n + '}}').join(', '))
  }
  if (inapplicable.length) {
    die('плейсхолдер ' + [...new Set(inapplicable)].map(n => '{{' + n + '}}').join(', ') +
      ' в шаблоне ' + tplPath + ' нечем заполнить на стадии ' + STAGE + ' (задача ' + task.label + '). ' +
      'На этой стадии доступны: ' + Object.keys(values).sort().map(n => '{{' + n + '}}').join(', ') +
      '. Пустую строку в промпт скрипт не пишет: агент получил бы дыру вместо адреса файла.')
  }
  return text
}

const rows = []
const skipped = []
const warnings = []

const emptyPerim = []
if (!(Array.isArray(perim.in) ? perim.in.filter(Boolean).length : 0)) emptyPerim.push('perimeter.in')
if (!(Array.isArray(perim.out) ? perim.out.filter(Boolean).length : 0)) emptyPerim.push('perimeter.out')
if (emptyPerim.length) warnings.push('в engine.json пусто поле ' + emptyPerim.join(' и ') + ' — вместо границ темы в промпт уходит просьба их заполнить. Задай периметр и перерендери с --force')

const FS_HINT = '\nПроверь права на каталог state/tasks и что --root ведёт в каталог движка.'

if (!argv.dryRun) {
  // state/results заводим здесь же: путь результата уходит в промпт, а записывает его агент —
  // если каталога нет, агент упирается в ENOENT последним действием, когда работа уже сделана.
  for (const d of [path.join(ROOT, 'state', 'tasks'), path.join(ROOT, 'state', 'results')]) {
    try { fs.mkdirSync(d, { recursive: true }) }
    catch (e) { die('не удалось создать каталог ' + d + ': ' + e.message + FS_HINT) }
  }
}

for (const task of tasks) {
  const text = render(task)
  const dst = taskPath(task.label)
  const exists = isFile(dst)
  for (const n of task.needs) if (!isFile(n.p)) warnings.push(task.label + ': нет файла — ' + n.what + ' ' + path.relative(ROOT, n.p))
  if (exists && !argv.force) {
    skipped.push({ label: task.label, file: dst, bytes: Buffer.byteLength(readText(dst) || '', 'utf8') })
    continue
  }
  if (!argv.dryRun) {
    try { fs.writeFileSync(dst, text, 'utf8') }
    catch (e) { die('не удалось записать файл задачи ' + dst + ': ' + e.message + FS_HINT) }
  }
  rows.push({ label: task.label, file: dst, bytes: Buffer.byteLength(text, 'utf8'), action: exists ? 'перезаписан' : 'записан' })
}

// ---------------------------------------------------------------- вывод

console.log((argv.dryRun ? 'ПЛАН (--dry-run, на диск ничего не записано)' : 'Отрендерено') +
  ': стадия ' + STAGE + ' · шаблон ' + path.relative(SKILL, tplPath) + ' · ' + tasks.length + ' ' + plural(tasks.length, 'задача', 'задачи', 'задач'))
console.log('Корпус на диске: ' + CORPUS_SIZE)
console.log('')

const all = rows.concat(skipped).map(r => ({ ...r, rel: path.relative(ROOT, r.file), size: fmt(r.bytes) + ' Б' }))
const w1 = Math.max('label'.length, ...all.map(r => r.label.length))
const w2 = Math.max('файл задачи'.length, ...all.map(r => r.rel.length))
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length))
console.log(pad('label', w1) + ' | ' + pad('файл задачи', w2) + ' | размер')
console.log('-'.repeat(w1) + '-+-' + '-'.repeat(w2) + '-+-------')
for (const r of all) {
  const tail = r.action ? '' : ' · уже был, не тронут'
  console.log(pad(r.label, w1) + ' | ' + pad(r.rel, w2) + ' | ' + r.size + tail)
}

if (argv.dryRun && tasks.length === 1) {
  console.log('')
  console.log('--- ' + path.relative(ROOT, taskPath(tasks[0].label)) + ' ---')
  console.log(render(tasks[0]))
  console.log('--- конец ---')
}

if (skipped.length && !argv.force) {
  console.log('')
  console.log('Не тронуто файлов: ' + skipped.length + '. Перерендерить поверх — повтори с --force (это нужно всегда, когда правил mission, периметр или состав тем).')
}

if (warnings.length) {
  console.log('')
  console.log('Предупреждения (задача отрендерена, но агенту нечего будет читать):')
  for (const w of warnings) console.log('  · ' + w)
}

console.log('')
if (argv.dryRun) {
  console.log('Дальше: повтори без --dry-run, чтобы записать файлы задач.')
} else if (STAGE === 'research' || STAGE === 'verify') {
  console.log('Дальше: партия 3-4 задачи — Workflow ' + ROOT + '/workflows/research.mjs с labels из колонки label (без префикса стадии), либо node ' + path.join(SKILL, 'scripts', 'fanout.mjs') + ' --root ' + ROOT + ' --stage ' + STAGE + ' --engine codex --concurrency 3. После партии: audit.mjs и строка в state/run-log.md.')
} else {
  console.log('Дальше: партия 3-4 задачи — Workflow ' + ROOT + '/workflows/synthesis.mjs с stage ' + STAGE + ' и labels из колонки label, либо node ' + path.join(SKILL, 'scripts', 'fanout.mjs') + ' --root ' + ROOT + ' --stage ' + STAGE + ' --engine codex --concurrency 3. После партии: audit.mjs и строка в state/run-log.md.')
}

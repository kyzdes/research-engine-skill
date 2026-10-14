#!/usr/bin/env node
// render-tasks.mjs — рендер файлов задач state/tasks/<label>.md из templates/<stage>.task.md.
// Единственный способ появления промптов агентов: руками они не пишутся, иначе два хоста
// разъезжаются и повторный прогон перестаёт быть воспроизводимым.
// Node 18+, ESM, без зависимостей.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  die, isDir, isFile, readText, countWords, fmt, plural, todayISO, isISODate,
  STAGES, DEFAULT_FINISH, DEFAULT_WORDS, normalizeEngine, synthFileName, isGaps,
  bankLayout, synthStageEntries, syncToolchain, toolchainDrift,
  normalizeBrief, jobsText, acceptanceText, inputsText, sourcesText, strList, MISSION_STUB_RE,
  workflowArgs, syncStatuses,
} from './lib/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL = path.resolve(HERE, '..')
const TEMPLATES = path.join(SKILL, 'templates')

const USAGE = `render-tasks.mjs — рендерит файлы задач движка из шаблонов стадии.

  node render-tasks.mjs --root <path> --stage recon|research|verify|synth|merge|critique|method|agent-doc
                        [--labels a,b] [--today YYYY-MM-DD] [--force] [--dry-run]

  --root     каталог движка (в нём лежит engine.json). Обязателен.
  --stage    какую стадию рендерить. Обязателен.
  --labels   ограничить набор: через запятую, полные метки (research__01-slug)
             или короткие имена (01-slug, field-spec).
  --today    дата «Сегодня» в промптах. По умолчанию — сегодняшняя дата рендера, а не дата
             заведения движка: агент по ней решает, что устарело, и ею подписывает проверку.
  --force    перезаписать уже отрендеренные файлы задач
  --dry-run  всё отрендерить, ничего не записать; при одной задаче напечатать текст целиком
  --help     эта справка

Метки стадий (контракт движка):
  recon      recon__field  (разведка предмета на стадии брифа → brief/RECON.md)
  research   research__<topic-slug>   verify   verify__<topic-slug>
  synth      synth__<label>           merge    merge__facts-bank
  critique   critique__gaps           method   method__method
  agent-doc  method__agent

Файл задачи: <root>/state/tasks/<label>.md. Результат агента: <root>/state/results/<label>.json —
его пишет сам агент последним действием, чтобы возврат жил на диске независимо от хоста.
Неподставленный плейсхолдер — ошибка с именем и файлом, а не пустая строка в промпте.`

// ---------------------------------------------------------------- утилиты

const words = (w) => (w >= 10000 ? fmt(Math.round(w / 1000)) + ' тыс. слов' : fmt(w) + ' ' + plural(w, 'слово', 'слова', 'слов'))

// плейсхолдеры контракта: всё, чего нет в этом списке, — опечатка в шаблоне
const CONTRACT = new Set([
  'ROOT', 'SLUG', 'TITLE', 'TODAY', 'LANGUAGE', 'MISSION', 'PERIMETER_IN', 'PERIMETER_OUT',
  'PROFILE', 'FINISH', 'LABEL', 'TOPIC_SLUG', 'TOPIC_TITLE', 'PROMPT_PATH', 'REPORT_PATH',
  'RESULT_PATH', 'SPEC_PATH', 'OUT_PATH', 'TARGET_WORDS', 'PRIMARY_LIST', 'SECONDARY_LIST',
  'OTHER_LIST', 'ALL_REPORTS', 'ALL_SYNTHESIS', 'SYNTH_LABEL', 'CORPUS_SIZE',
  // бриф: какую работу делает база и по каким вопросам проверяется её готовность
  'REQUEST', 'JOBS', 'ACCEPTANCE_LIST', 'TOPIC_ACCEPTANCE', 'INPUTS_LIST', 'SOURCES_POLICY',
])

// ---------------------------------------------------------------- аргументы

function parseArgs(argv) {
  const out = { root: '', stage: '', labels: [], today: '', force: false, dryRun: false }
  const take = (name, i) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) die('у аргумента ' + name + ' нет значения')
    return v
  }
  const set = (key, value, raw) => {
    if (key === 'root') out.root = value
    else if (key === 'stage') out.stage = value
    else if (key === 'labels') out.labels = value.split(',').map(s => s.trim()).filter(Boolean)
    else if (key === 'today') out.today = value
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
  if (out.today && !isISODate(out.today)) die('--today ждёт дату в формате YYYY-MM-DD, получено: ' + out.today)
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

const { topics, syntheses } = normalizeEngine(engine)
const topicBySlug = new Map(topics.map(t => [String(t.slug), t]))

const targetWords = engine.targetWords || {}
const reportWords = Number(targetWords.report) > 0 ? Number(targetWords.report) : DEFAULT_WORDS.report
const synthWords = Number(targetWords.synthesis) > 0 ? Number(targetWords.synthesis) : DEFAULT_WORDS.synthesis

const perim = engine.perimeter || {}
const joinList = (v, empty) => {
  const arr = Array.isArray(v) ? v.map(String).filter(Boolean) : (v ? [String(v)] : [])
  return arr.length ? arr.join('; ') : empty
}

const missionText = String(engine.mission || '').trim()
const brief = normalizeBrief(engine.brief)
// Разведка идёт до вопросов заказчику, когда миссии ещё нет: её задача опирается на исходный запрос.
if (STAGE === 'recon') {
  if (!brief.request && !brief.restated) die('для разведки нужен исходный запрос: brief.request в engine.json пуст. Заведи движок с --request "<запрос дословно>" или впиши его в brief.request.')
} else {
  if (!missionText) die('в engine.json пустая mission. Она вставляется дословно в каждый промпт: без неё агенты работают вслепую. Заполни 3-6 предложений и повтори рендер.')
  // engine-init кладёт в mission заглушку «ЗАПОЛНИТЬ...» — в промпт она уйдёт дословно и агент получит инструкцию вместо задачи
  if (MISSION_STUB_RE.test(missionText)) die('в engine.json вместо mission стоит заглушка engine-init («' + missionText.slice(0, 40) + '…»). Она уйдёт в каждый промпт дословно. Напиши 3-6 предложений: что за движок, кому и для какой работы, — и повтори рендер.')
}

// ---------------------------------------------------------------- пути и списки

const reportPath = (slug) => path.join(ROOT, 'reports', slug + '.md')
const promptPath = (slug) => path.join(ROOT, 'prompts', slug + '.md')
const specPath = (label) => path.join(ROOT, 'synthesis-spec', label + '.md')
const synthFile = (s) => path.join(ROOT, 'synthesis', synthFileName(s))
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
  // «Сегодня» в промпте — дата рендера, а не дата заведения движка: агент по ней решает,
  // что устарело, и ею подписывает раздел «## Верификация». Движок, продолженный через
  // месяц, иначе получает в промптах прошлое число.
  TODAY: argv.today || todayISO(),
  LANGUAGE: String(engine.language || 'ru'),
  MISSION: missionText,
  PERIMETER_IN: joinList(perim.in, 'периметр не задан — заполни perimeter.in в engine.json'),
  PERIMETER_OUT: joinList(perim.out, 'исключения не заданы — заполни perimeter.out в engine.json'),
  PROFILE: String(engine.profile || 'M'),
  FINISH: String(engine.finish || DEFAULT_FINISH),
  CORPUS_SIZE,
  ALL_REPORTS,
  ALL_SYNTHESIS,
  // бриф (references/BRIEF.md): работа базы, контрольные вопросы, материалы заказчика, политика источников
  // Разведка идёт параллельно разговору с заказчиком: всё, что уже решено, обязано до неё доехать,
  // иначе она заново предлагает выбор, который заказчик уже сделал.
  REQUEST: [
    brief.request ? 'Дословно: «' + brief.request + '»' : '',
    brief.restated ? 'Как его поняли: ' + brief.restated : '',
    brief.constraints.length ? '**Уже решено с заказчиком — не предлагай заново:**\n' + brief.constraints.map(x => '- ' + x).join('\n') : '',
    brief.assumptions.length ? '**Допущения** (неподтверждённые помечены — их можно проверить и оспорить):\n' + brief.assumptions.map(x => '- ' + x).join('\n') : '',
  ].filter(Boolean).join('\n\n'),
  JOBS: jobsText(brief),
  ACCEPTANCE_LIST: acceptanceText(brief.acceptance, 'контрольные вопросы в брифе не заданы — готовность базы мерить нечем, отметь это как риск'),
  INPUTS_LIST: inputsText(brief, ROOT),
  SOURCES_POLICY: sourcesText(brief),
}

// контрольные вопросы, ради которых заведены темы: topics[].answers → вопросы брифа
const acceptanceById = new Map(brief.acceptance.map(a => [a.id, a]))
const acceptanceOf = (slugs) => {
  const ids = [...new Set(slugs.flatMap(sl => strList((topicBySlug.get(sl) || {}).answers)))]
  return ids.map(id => acceptanceById.get(id)).filter(Boolean)
}
const NO_TOPIC_ACCEPTANCE = 'тема не привязана к контрольным вопросам брифа (topics[].answers пуст) — работай по вопросам ТЗ и держи в голове работу базы выше'

// ---------------------------------------------------------------- банк фактов частями

const { entry: bankEntry, parts: bankParts } = bankLayout(syntheses)

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
      TOPIC_ACCEPTANCE: acceptanceText(acceptanceOf([String(t.slug)]), NO_TOPIC_ACCEPTANCE),
    },
    needs: prefix === 'research'
      ? [{ p: promptPath(t.slug), what: 'ТЗ ресерча' }]
      : [{ p: promptPath(t.slug), what: 'ТЗ ресерча' }, { p: reportPath(t.slug), what: 'отчёт для верификации' }],
  }))
}

function synthTasks() {
  if (!syntheses.length) die('в engine.json нет сводов: рендерить нечего. Спроектируй состав сводов и внеси их в syntheses.')
  // тот же набор, что видит fanout.mjs: без GAPS.md и без навигатора банка, собранного частями
  const list = synthStageEntries(syntheses)
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
        TOPIC_ACCEPTANCE: acceptanceText(acceptanceOf([...primary, ...secondary]), 'твои отчёты не привязаны к контрольным вопросам брифа — переноси по ТЗ свода'),
      },
      needs: [{ p: specPath(label), what: 'ТЗ на свод' }],
    }
  })
}

function singleTask(label, values, needs) {
  return [{ label, short: label.split('__')[1] || label, values, needs: needs || [] }]
}

function buildTasks() {
  if (STAGE === 'recon') {
    return singleTask('recon__field', {
      OUT_PATH: path.join(ROOT, 'brief', 'RECON.md'),
      TARGET_WORDS: '1500',
      // миссии на разведке ещё нет: первый круг вопросов о работе базы идёт параллельно
      JOBS: jobsText(brief, 'работа базы ещё выясняется — первый круг вопросов заказчику идёт параллельно с тобой; варианты работ предложи в разделе 6'),
    })
  }
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

if ((STAGE === 'method' || STAGE === 'agent-doc') && String(engine.finish || DEFAULT_FINISH) === 'base') {
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

let toolchain = []
let statusChanges = []
if (!argv.dryRun) {
  // Статусы сверяются с диском перед каждой стадией: Workflow-исполнители engine.json не
  // трогают, и без этого шага аудит молчит там, где должен ставить блокер.
  try { statusChanges = syncStatuses(ROOT, engine, 'render-tasks').changes }
  catch (e) { console.error('Предупреждение: статусы не сверены с диском — ' + e.message) }
  // state/results заводим здесь же: путь результата уходит в промпт, а записывает его агент —
  // если каталога нет, агент упирается в ENOENT последним действием, когда работа уже сделана.
  for (const d of [path.join(ROOT, 'state', 'tasks'), path.join(ROOT, 'state', 'results')]) {
    try { fs.mkdirSync(d, { recursive: true }) }
    catch (e) { die('не удалось создать каталог ' + d + ': ' + e.message + FS_HINT) }
  }
  // Исполнитель запускается из копии в корне движка — она обязана совпадать со скиллом.
  try { toolchain = syncToolchain(ROOT, SKILL) }
  catch (e) { die('не удалось обновить копии исполнителей и схем в ' + ROOT + ': ' + e.message + FS_HINT) }
} else {
  toolchain = toolchainDrift(ROOT, SKILL).map(d => d.rel + (d.state === 'missing' ? ' (будет добавлен)' : ' (будет обновлён)'))
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

if (statusChanges.length) {
  console.log('')
  console.log('Статусы сверены с диском и записаны в engine.json: ' + statusChanges.join(', '))
}

if (toolchain.length) {
  console.log('')
  console.log('Копии исполнителей и схем в движке ' + (argv.dryRun ? 'отстают от скилла' : 'приведены к версии скилла') + ': ' + toolchain.join(', '))
}

if (warnings.length) {
  console.log('')
  console.log('Предупреждения (задача отрендерена, но агенту нечего будет читать):')
  for (const w of warnings) console.log('  · ' + w)
}

const script = (name) => path.join(SKILL, 'scripts', name)
const afterBatch = 'После партии: node ' + script('status.mjs') + ' --root ' + ROOT +
  ' --write (статусы тем и сводов, строка в state/run-log.md), затем node ' + script('audit.mjs') + ' --root ' + ROOT + '.'
const codexRun = 'node ' + script('fanout.mjs') + ' --root ' + ROOT + ' --stage ' + STAGE + ' --engine codex --concurrency 3'
// Готовые аргументы исполнителя на первую партию: маршрут моделей и усилий из engine.json.
const shorts = tasks.map(t => t.short).slice(0, STAGE === 'research' || STAGE === 'verify' || STAGE === 'synth' ? 4 : tasks.length)
const wfArgs = JSON.stringify(workflowArgs(engine, ROOT, STAGE, shorts))

console.log('')
if (argv.dryRun) {
  console.log('Дальше: повтори без --dry-run, чтобы записать файлы задач.')
} else if (STAGE === 'recon') {
  console.log('Дальше: Workflow ' + ROOT + '/workflows/synthesis.mjs с args ' + wfArgs + ', либо ' + codexRun + '. Пока он идёт — первый круг вопросов заказчику о работе базы (references/BRIEF.md §3). Потом: прочитай brief/RECON.md, второй круг вопросов, заполни brief в engine.json и node ' + script('brief.mjs') + ' --root ' + ROOT + ' --write.')
} else if (STAGE === 'research') {
  console.log('Дальше: партия 3-4 темы — Workflow ' + ROOT + '/workflows/research.mjs, первая партия с args ' + wfArgs + ' (верификатор идёт следом сам; следующие партии — те же args с другими labels), либо ' + codexRun + '. ' + afterBatch)
} else if (STAGE === 'verify') {
  console.log('Дальше: Workflow ' + ROOT + '/workflows/research.mjs с args ' + wfArgs + ' — только верификатор, отчёт не пишется заново; либо ' + codexRun + '. ' + afterBatch)
} else {
  console.log('Дальше: партия 3-4 задачи — Workflow ' + ROOT + '/workflows/synthesis.mjs, ' + (tasks.length > shorts.length ? 'первая партия ' : '') + 'с args ' + wfArgs + ', либо ' + codexRun + '. ' + afterBatch)
}

#!/usr/bin/env node
// fanout.mjs — портируемый исполнитель стадий движка ресерча.
// Мост в Codex CLI и в любой хост без Workflow-тула: на каждую задачу поднимает
// отдельный процесс агента, держит лимит параллелизма, пишет логи и сырые возвраты.
// Node 18+, ESM, без зависимостей.
//
// Флаги хостов сверены на машине сборки 15.10.2026:
//   codex-cli 0.159.3 — codex exec: --json, --output-schema <FILE>, -o/--output-last-message <FILE>,
//     -C/--cd <DIR>, --skip-git-repo-check, -s/--sandbox <read-only|workspace-write|danger-full-access>,
//     -m/--model, -c/--config <key=value>, --color <always|never|auto>, --strict-config.
//     Веб-поиск: флага --search у codex exec нет, включается ключом конфига
//     -c web_search="live" (значения disabled | cached | indexed | live; проверено событиями
//     web_search в --json). Прежний ключ tools.web_search=true пока принимается, но он устаревший.
//     С --strict-config неизвестный ключ или значение падает громко («Error loading config.toml»),
//     поэтому --strict-config включён по умолчанию.
//     Расход: --json отдаёт событие turn.completed с usage (input_tokens включает cached_input_tokens,
//     output_tokens включает reasoning_output_tokens) — по нему партия пишет runs сама.
//   claude — -p/--print, --output-format json (в конверте — usage), --permission-mode bypassPermissions,
//     --add-dir <directories...> (variadic: забирает все следующие позиционные аргументы,
//     поэтому промпт нельзя ставить сразу после него — см. buildCommand),
//     --model, --effort <low|medium|high|xhigh|max>. Флага веб-поиска нет:
//     WebSearch/WebFetch зависят от настроек сессии, поэтому требование поднять их
//     вписано в промпт, а не в командную строку.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  STAGES, PREFIX_BY_STAGE, normalizeEngine, stageLabels, appendRunLogRow, todayISO, routeFor, stageOfLabel, flushAndExit,
  syncStatuses, shq, resolveRoot, lawFor, schemaProblems, recordRun, fmt,
} from './lib/engine.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')
const script = (name) => shq(path.join(SCRIPT_DIR, name))

// Стадии, где отчёт без интернета — брак. Остальные работают по корпусу на диске: сводчику
// и критику веб-поиск не нужен, а «бери цифры со страницы» спорит с правилом «числа — из отчётов».
const WEB_STAGES = ['recon', 'research', 'verify']
const isWebJob = (label) => WEB_STAGES.includes(label.split('__')[0])

// Стадия → схема возврата (§5 контракта). Ключ — префикс label до двойного подчёркивания.
const SCHEMA_BY_PREFIX = {
  recon: 'file.json',
  research: 'research.json',
  verify: 'verify.json',
  synth: 'file.json',
  merge: 'file.json',
  critique: 'gaps.json',
  method: 'file.json',
}

const HELP = `fanout.mjs — исполнитель стадии движка ресерча вне Claude Code.

Читает engine.json и файлы задач state/tasks/<label>.md, на каждую задачу поднимает
процесс агента, пишет state/logs/<label>.log и state/results/<label>.raw.json,
печатает таблицу итогов. Код возврата 1, если хоть одна задача упала.

Использование:
  node fanout.mjs --root <path> (--stage <stage> | --labels a,b,c) [опции]

Обязательное:
  --root <path>            корень движка (каталог с engine.json)
  --stage <stage>          ${STAGES.join(' | ')}
  --labels a,b,c           явный список задач: полные labels (research__01-slug)
                           или короткие имена, если задан --stage

Опции:
  --engine codex|claude    чем поднимать агента (по умолчанию codex)
  --concurrency <n>        сколько агентов одновременно (по умолчанию 3)
  --model <m>              модель агента на все задачи, сильнее маршрута. Без флага модель
                           берётся по стадии из engine.json: на claude — models (верификатор,
                           своды, критик, методика — opus; разведка, ресерч, части банка,
                           навигатор, AGENT.md — sonnet), на codex — codexModels (то же
                           правило: gpt-6-astra и gpt-6.1-sol)
  --effort <level>         усилие рассуждения, сильнее маршрута; без флага — efforts или
                           codexEfforts из engine.json. claude: --effort
                           (low|medium|high|xhigh|max); codex: -c model_reasoning_effort
                           (low|medium|high|xhigh)
  --no-verify              на стадии research не запускать верификатора следом. По умолчанию
                           после успешного ресерча темы её верификатор встаёт в ту же очередь —
                           как в Workflow-исполнителе research.mjs
  --no-record              не записывать расход партии в engine.json (runs). По умолчанию
                           токены берутся из ответа хоста и пишутся сами
  --retries <n>            повторов после первого провала (по умолчанию 1)
  --timeout-sec <n>        таймаут на процесс (по умолчанию 5400)
  --web-search on|off      веб-поиск агенту на стадиях recon, research и verify (по умолчанию
                           on); своды, критик и методика работают по корпусу без интернета
  --sandbox <mode>         песочница codex: read-only | workspace-write |
                           danger-full-access (по умолчанию danger-full-access:
                           агент пишет отчёты и результаты на диск)
  --no-strict-config       не передавать codex --strict-config. Нужно, только если
                           твой ~/.codex/config.toml содержит поля, незнакомые этой
                           сборке codex. Цена: ошибка в ключе tools.web_search
                           пройдёт молча и агент останется без интернета.
  --permission-mode <m>    режим разрешений claude (по умолчанию bypassPermissions)
  --skip-done              пропустить задачи, у которых уже есть state/results/<label>.json
  --allow-missing-result   не считать провалом отсутствие state/results/<label>.json
  --dry-run                напечатать команды целиком и ничего не запускать
  --print-prompts          напечатать промпты задач и выйти — для режима субагентов Codex
                           (spawn_agent): тот же контракт, что у процесса, без запуска
  --help                   эта справка

Почему параллелизм 3 по умолчанию: девять тяжёлых агентов разом выжигают лимит
сессии за считанные минуты (замер на сборке aso-engine: 2,2 млн токенов за пять
минут). Партии по 3-4 — правило, а не осторожность.

Сбои хоста: исчерпанный лимит аккаунта («usage limit», «session limit») останавливает
запуск новых задач — повтор бессмыслен до сброса, в конце печатается команда продолжения.
Сетевые сбои и перегрузка (ENOTFOUND, ECONNRESET, 429, 5xx, «overloaded») повторяются
с паузой 30 с, 2 мин, 5 мин сверх --retries.

Примеры:
  node fanout.mjs --root ~/Desktop/Projects/skills/x-engine --stage research --dry-run
  node fanout.mjs --root ~/Desktop/Projects/skills/x-engine --stage research --concurrency 3
  node fanout.mjs --root ~/Desktop/Projects/skills/x-engine --labels synth__field-spec,synth__verdicts
`

// ---------------------------------------------------------------- аргументы

function fail(msg, code = 2) {
  console.error('Ошибка: ' + msg)
  process.exit(code)
}

function parseArgs(argv) {
  const o = {
    root: '',
    stage: '',
    labels: [],
    engine: 'codex',
    concurrency: 3,
    model: '',
    effort: '',
    retries: 1,
    timeoutSec: 5400,
    webSearch: true,
    sandbox: 'danger-full-access',
    strictConfig: true,
    permissionMode: 'bypassPermissions',
    skipDone: false,
    allowMissingResult: false,
    dryRun: false,
    verify: true,
    record: true,
    printPrompts: false,
  }
  const need = (i, name) => {
    const v = argv[i + 1]
    if (v === undefined || (v.startsWith('--') && v.length > 2)) fail('у флага ' + name + ' нет значения')
    return v
  }
  // --flag=value раскладывается в два аргумента: так флаги пишут и остальные скрипты движка
  argv = argv.flatMap(a => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]))
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--help': case '-h': console.log(HELP); process.exit(0); break
      case '--root': o.root = need(i, a); i++; break
      case '--stage': o.stage = need(i, a); i++; break
      case '--labels': o.labels = need(i, a).split(',').map(s => s.trim()).filter(Boolean); i++; break
      case '--engine': o.engine = need(i, a); i++; break
      case '--concurrency': o.concurrency = Number(need(i, a)); i++; break
      case '--model': o.model = need(i, a); i++; break
      case '--effort': o.effort = need(i, a); i++; break
      case '--retries': o.retries = Number(need(i, a)); i++; break
      case '--timeout-sec': o.timeoutSec = Number(need(i, a)); i++; break
      case '--web-search': {
        const v = need(i, a)
        // Молча проглотить опечатку тут нельзя: цена ошибки — стадия ресерча по памяти модели.
        if (v !== 'on' && v !== 'off') fail('--web-search принимает on или off, получено: ' + v)
        o.webSearch = v === 'on'
        i++
        break
      }
      case '--sandbox': o.sandbox = need(i, a); i++; break
      case '--no-strict-config': o.strictConfig = false; break
      case '--permission-mode': o.permissionMode = need(i, a); i++; break
      case '--skip-done': o.skipDone = true; break
      case '--allow-missing-result': o.allowMissingResult = true; break
      case '--dry-run': o.dryRun = true; break
      case '--no-verify': o.verify = false; break
      case '--no-record': o.record = false; break
      case '--print-prompts': o.printPrompts = true; break
      default: fail('неизвестный флаг ' + a + '. Справка: --help')
    }
  }
  if (!o.root) fail('нужен --root <path> — каталог движка с engine.json')
  if (!o.stage && !o.labels.length) fail('нужен --stage <stage> или --labels a,b,c')
  if (o.stage && !STAGES.includes(o.stage)) fail('стадия ' + o.stage + ' неизвестна. Доступные: ' + STAGES.join(', '))
  if (!['codex', 'claude'].includes(o.engine)) fail('--engine принимает codex или claude, получено: ' + o.engine)
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(o.sandbox)) {
    fail('--sandbox принимает read-only, workspace-write или danger-full-access, получено: ' + o.sandbox)
  }
  if (!Number.isFinite(o.concurrency) || o.concurrency < 1 || o.concurrency > 16) fail('--concurrency вне диапазона 1..16')
  if (!Number.isFinite(o.retries) || o.retries < 0 || o.retries > 5) fail('--retries вне диапазона 0..5')
  if (!Number.isFinite(o.timeoutSec) || o.timeoutSec < 30) fail('--timeout-sec меньше 30 секунд — так задача не успеет ничего')
  o.root = resolveRoot(o.root)
  return o
}

// ---------------------------------------------------------------- движок

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) }
  catch (e) { fail('не читается ' + p + ': ' + e.message) }
}

function loadEngine(root) {
  const p = path.join(root, 'engine.json')
  if (!fs.existsSync(p)) fail('нет ' + p + '. Движок создаётся engine-init.mjs')
  const e = readJson(p)
  if (!e || typeof e !== 'object' || Array.isArray(e)) {
    fail(p + ' — не объект. Внутри должен лежать один JSON-объект движка: slug, topics, syntheses')
  }
  // §3: скрипт переживает отсутствие необязательных полей и не падает на лишних.
  const { topics, syntheses } = normalizeEngine(e)
  return {
    raw: e,
    slug: typeof e.slug === 'string' ? e.slug : '',
    title: typeof e.title === 'string' ? e.title : '',
    topics,
    syntheses,
  }
}

function normalizeLabels(opts, engine) {
  if (!opts.labels.length) {
    // §4: тот же набор меток, что рендерит render-tasks.mjs — без GAPS.md и навигатора банка
    // на стадии synth, иначе прогон падает на «нет файлов задач».
    const list = stageLabels(opts.stage, engine)
    if (!list.length) {
      fail('в engine.json нет ни одной задачи для стадии ' + opts.stage +
        '. Для research и verify нужен непустой topics, для synth — syntheses')
    }
    return list
  }
  const full = opts.labels.map(l => {
    if (l.includes('__')) return l
    if (!opts.stage) fail('короткое имя задачи ' + l + ' без --stage. Дай полный label вида research__' + l)
    return PREFIX_BY_STAGE[opts.stage] + '__' + l
  })
  // Дубль в --labels поднял бы два процесса на один файл задачи: общий лог, общий raw,
  // двойной расход лимита. Схлопываем, сохраняя порядок.
  const seen = new Set()
  const unique = full.filter(l => (seen.has(l) ? false : seen.add(l)))
  if (unique.length !== full.length) console.log('Повторы в --labels убраны: ' + (full.length - unique.length))
  return unique
}

// required = false: схема нужна только для проверки результата (claude) — без неё проверка
// пропускается, а не роняет прогон. Codex без схемы не запускается: она уходит в --output-schema.
function schemaFor(label, root, required = true) {
  const prefix = label.split('__')[0]
  const name = SCHEMA_BY_PREFIX[prefix]
  if (!name) {
    fail('не знаю схему для задачи ' + label + '. Префикс должен быть одним из: ' + Object.keys(SCHEMA_BY_PREFIX).join(', '))
  }
  const inEngine = path.join(root, 'schemas', name)
  if (fs.existsSync(inEngine)) return inEngine
  const inSkill = path.join(SKILL_DIR, 'schemas', name)
  if (fs.existsSync(inSkill)) return inSkill
  if (!required) return ''
  fail('нет схемы ' + name + ' ни в ' + path.join(root, 'schemas') + ', ни в ' + path.join(SKILL_DIR, 'schemas') +
    '. Схемы копирует в движок engine-init.mjs')
}

// ---------------------------------------------------------------- промпт

// Обвязка короткая намеренно: содержание задачи лежит в файле на диске и может весить
// десятки тысяч знаков — в аргументе командной строки ему не место (ARG_MAX, кавычки,
// потерянные переводы строк). Агент читает файл сам.
function taskPrompt(root, label, opts) {
  const lines = [
    'Ты выполняешь одну задачу движка ресерча. Вся задача целиком описана в файле:',
    path.join(root, 'state', 'tasks', label + '.md'),
    '',
    'Прочитай этот файл целиком, от первой строки до последней, и выполни его буквально. Файл задачи — контракт, а не вдохновение: пропущенный пункт считается браком. Не пересказывай задачу в ответе и не переспрашивай — выполняй.',
    '',
    lawFor(stageOfLabel(label)),
    '',
    'Последним действием запиши результат одним JSON-объектом по схеме из задачи в файл:',
    path.join(root, 'state', 'results', label + '.json'),
    'и верни тот же объект своим финальным ответом. Результат на диске обязателен: без него задача считается проваленной, даже если сам документ написан.',
    '',
    'Рабочий корень движка: ' + root + '. Пути в задаче абсолютные — используй их как есть, ничего не выдумывай.',
    '',
    'Если файла задачи нет на диске, ничего не делай и не пиши его сам: ответь одной строкой «нет файла задачи» — исполнитель засчитает это как провал и подскажет, что отрендерить.',
  ]
  if (!isWebJob(label)) {
    lines.push('', 'Веб-поиск на этой стадии не нужен: работай по корпусу движка на диске. Факт, которого в корпусе нет, не добирай из памяти — отметь как пробел.')
    return lines.join('\n')
  }
  if (opts.webSearch && opts.engine === 'claude') {
    lines.push('', 'Тебе нужен веб-поиск. Если инструменты не загружены, загрузи их одним вызовом ToolSearch с запросом select:WebSearch,WebFetch. Цифры бери со страницы через WebFetch, а не из сниппета выдачи и не по памяти.')
  }
  if (opts.webSearch && opts.engine === 'codex') {
    lines.push('', 'Веб-поиск тебе включён. Цифры и правила бери с открытой страницы первоисточника, а не по памяти модели: память устарела. У каждого числа оставляй дату проверки и URL.')
  }
  if (!opts.webSearch) {
    lines.push('', 'Веб-поиск отключён запуском. Работай только по материалам на диске. Всё, чего в них нет, помечай как непроверенное, а не достраивай по памяти.')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- команды

// Маршрут задачи: флаг командной строки сильнее engine.json. У каждого хоста свой маршрут:
// models/efforts для claude, codexModels/codexEfforts для codex (имена моделей у них разные).
function routeOfJob(label, opts, engine) {
  const stage = stageOfLabel(label)
  const entry = stage === 'synth' ? engine.syntheses.find(s => 'synth__' + s.label === label) : null
  const r = routeFor(engine.raw, stage, entry, opts.engine)
  return { model: opts.model || r.model, effort: opts.effort || r.effort }
}

function buildCommand(label, opts, root, route) {
  const rawPath = path.join(root, 'state', 'results', label + '.raw.json')
  const logPath = path.join(root, 'state', 'logs', label + '.log')
  const prompt = taskPrompt(root, label, opts)

  if (opts.engine === 'codex') {
    const schema = schemaFor(label, root)
    const args = [
      'exec',
      '--json',
      '--output-schema', schema,
      '-o', rawPath,
      '--sandbox', opts.sandbox,
      '--skip-git-repo-check',
      '-C', root,
      '--color', 'never',
    ]
    // Веб-поиск у codex exec задаётся ключом конфига, флага --search у exec нет.
    // --strict-config превращает опечатку в ключе в громкую ошибку вместо тихого «без интернета».
    if (opts.strictConfig) args.push('--strict-config')
    args.push('-c', 'web_search="' + (opts.webSearch && isWebJob(label) ? 'live' : 'disabled') + '"')
    if (route.model) args.push('-m', route.model)
    if (route.effort) args.push('-c', 'model_reasoning_effort="' + route.effort + '"')
    args.push(prompt)
    return { cmd: 'codex', args, rawPath, logPath, schema, captureStdout: true }
  }

  // claude: без --output-schema (§6) — структурированный результат агент кладёт на диск сам.
  // Порядок флагов не косметика: --add-dir у claude объявлен как <directories...>,
  // то есть забирает все идущие следом позиционные аргументы. Если поставить его
  // последним, промпт уедет во второй каталог, и claude упадёт с
  // «Input must be provided either through stdin or as a prompt argument».
  // Проверено 22.08.2026. Поэтому после --add-dir всегда стоит флаг со своим значением,
  // а промпт идёт последним позиционным.
  const args = ['-p', '--permission-mode', opts.permissionMode, '--add-dir', root, '--output-format', 'json']
  if (route.model) args.push('--model', route.model)
  if (route.effort) args.push('--effort', route.effort)
  args.push(prompt)
  return { cmd: 'claude', args, rawPath, logPath, schema: '', captureStdout: true }
}

function renderCommand(job) {
  return [job.cmd, ...job.args].map(shq).join(' ')
}

// ---------------------------------------------------------------- процессы

const running = new Set()

// Одинаковая для всех задач поломка конфига: гнать по ней остальные задачи бессмысленно.
let fatal = ''

const CONFIG_ERROR_MARKS = ['unknown configuration field', 'Error loading config.toml', 'error loading config']

function killTree(child, signal) {
  try { process.kill(-child.pid, signal) }
  catch (e) { try { child.kill(signal) } catch (e2) { /* процесс уже мёртв */ } }
}

// mtime файла результата в миллисекундах; 0, если файла нет.
function resultStamp(p) {
  try { return fs.statSync(p).mtimeMs } catch (e) { return 0 }
}

// Сбои хоста. Лимит аккаунта до сброса не лечится повтором — новые задачи не запускаем.
// Сеть и перегрузка лечатся паузой. Классифицируется только текст ошибки (stderr, события
// error у codex, конверт is_error у claude), а не содержимое ответа: ресерчер про Apple Ads
// законно пишет «rate limit» в отчёте.
const LIMIT_RE = /usage limit|session limit|hit your [a-z ]*limit|quota (?:exceeded|exhausted)|insufficient_quota|out of credits|credit balance is too low/i
const TRANSIENT_RE = /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|stream disconnected|network error|can'?t reach the api|fetch failed|too many requests|rate.?limit|overloaded|temporarily unavailable|\b(?:429|500|502|503|504|529)\b/i
const BACKOFF_MS = String(process.env.RE_FANOUT_BACKOFF_MS || '30000,120000,300000').split(',').map(Number).filter(n => n >= 0)
const classify = (text) => (!text ? '' : LIMIT_RE.test(text) ? 'limit' : TRANSIENT_RE.test(text) ? 'transient' : '')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function runAttempt(job, opts, attempt) {
  return new Promise(resolve => {
    const started = Date.now()
    const resultPath = job.rawPath.replace(/\.raw\.json$/, '.json')
    // Результат прошлого прогона остаётся на диске. Запоминаем отметку времени:
    // иначе провалившаяся задача сойдёт за успешную по чужому файлу.
    const stampBefore = resultStamp(resultPath)

    let fd
    try {
      fs.mkdirSync(path.dirname(job.logPath), { recursive: true })
      fs.mkdirSync(path.dirname(job.rawPath), { recursive: true })
      // Старый сырой возврат убираем, чтобы не принять его за свежий.
      try { fs.rmSync(job.rawPath, { force: true }) } catch (e) { /* нечего убирать */ }
      fd = fs.openSync(job.logPath, attempt === 1 ? 'w' : 'a')
    } catch (e) {
      return resolve({ ok: false, code: null, reason: 'не готовится state/: ' + e.message, sec: 0, tokens: 0 })
    }
    const write = s => { try { fs.writeSync(fd, s) } catch (e) { /* лог не критичен */ } }
    write('\n===== попытка ' + attempt + ' · ' + new Date().toISOString() + ' =====\n' + renderCommand(job) + '\n\n')

    let child
    try {
      child = spawn(job.cmd, job.args, {
        cwd: job.cwd,
        detached: true, // своя группа процессов: убиваем всё дерево, а не одного родителя
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (e) {
      try { fs.closeSync(fd) } catch (e2) { /* уже закрыт */ }
      return resolve({ ok: false, code: null, reason: 'не запустился: ' + e.message, sec: 0, tokens: 0 })
    }

    running.add(child)
    let stdout = ''        // claude: один JSON-конверт целиком
    let lineBuf = ''       // codex: JSONL событий, разбирается построчно и не копится
    let errText = ''       // только текст ошибок — по нему классифицируется сбой
    let tokens = 0
    let timedOut = false
    let configError = ''

    const sniff = text => {
      if (configError) return
      for (const mark of CONFIG_ERROR_MARKS) {
        if (text.includes(mark)) { configError = text.split('\n').find(l => l.includes(mark)).trim(); return }
      }
    }
    const codexEvent = (line) => {
      if (!line.trim()) return
      let e
      try { e = JSON.parse(line) } catch (err) { return }
      if (e.type === 'turn.completed' && e.usage) tokens += (Number(e.usage.input_tokens) || 0) + (Number(e.usage.output_tokens) || 0)
      if (e.type === 'error' || e.type === 'turn.failed') errText = (errText + '\n' + JSON.stringify(e.error || e.message || e)).slice(-16000)
    }

    child.stdout.on('data', d => {
      const s = d.toString(); write(s); sniff(s)
      if (job.cmd === 'codex') {
        lineBuf += s
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop()
        for (const l of lines) codexEvent(l)
      } else if (job.captureStdout) stdout += s
    })
    child.stderr.on('data', d => { const s = d.toString(); write(s); sniff(s); errText = (errText + s).slice(-16000) })

    const timer = setTimeout(() => {
      timedOut = true
      write('\n[fanout] таймаут ' + opts.timeoutSec + ' с — шлём SIGTERM группе процессов\n')
      killTree(child, 'SIGTERM')
      setTimeout(() => {
        write('[fanout] процесс не ушёл по SIGTERM — SIGKILL\n')
        killTree(child, 'SIGKILL')
      }, 10000).unref()
    }, opts.timeoutSec * 1000)

    let settled = false
    const finish = payload => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      running.delete(child)
      payload.tokens = tokens
      write('\n[fanout] ' + (payload.ok ? 'успех' : 'провал: ' + payload.reason) + ' · ' + payload.sec + ' с' + (tokens ? ' · ' + tokens + ' токенов' : '') + '\n')
      try { fs.closeSync(fd) } catch (e) { /* уже закрыт */ }
      resolve(payload)
    }

    child.on('error', err => {
      const reason = err.code === 'ENOENT'
        ? 'в PATH нет команды ' + job.cmd + ' — поставь этот CLI или запусти с --engine ' + (job.cmd === 'codex' ? 'claude' : 'codex')
        : 'не запустился: ' + err.message
      // Отсутствующий CLI ломает все задачи одинаково: повторять и запускать
      // следующие бессмысленно.
      if (err.code === 'ENOENT') fatal = reason
      finish({ ok: false, code: null, reason, sec: Math.round((Date.now() - started) / 1000), fatal: err.code === 'ENOENT' })
    })

    child.on('close', (code, signal) => {
      const sec = Math.round((Date.now() - started) / 1000)
      if (lineBuf) codexEvent(lineBuf)
      let claudeError = false
      if (job.cmd === 'claude' && job.captureStdout) {
        const env = writeClaudeRaw(job, stdout)
        claudeError = env.isError
        tokens += env.tokens
        if (env.isError) errText = (errText + '\n' + env.errorText).slice(-16000)
      }
      if (configError && code !== 0) {
        fatal = 'хост не принял конфиг: ' + configError +
          '\n  Это ломает все задачи одинаково. Либо почини ключ, либо запусти с --no-strict-config' +
          ' (тогда веб-поиск может не включиться — на стадиях research и verify это брак).'
        return finish({ ok: false, code, reason: 'конфиг хоста отвергнут: ' + configError, sec, fatal: true })
      }
      if (timedOut) return finish({ ok: false, code, reason: 'таймаут ' + opts.timeoutSec + ' с', sec })
      const kind = (code !== 0 || claudeError) ? classify(errText) : ''
      const tailLine = errText.trim().split('\n').filter(Boolean).pop() || ''
      if (code !== 0) return finish({ ok: false, code, kind, reason: 'код возврата ' + code + (signal ? ' · сигнал ' + signal : '') + (kind ? ' · ' + (kind === 'limit' ? 'лимит хоста' : 'сбой сети или перегрузка') + ': ' + tailLine.slice(0, 160) : ''), sec })
      // claude умеет завершиться нулём и при этом отдать is_error: true
      if (claudeError) return finish({ ok: false, code, kind, reason: 'хост вернул is_error: true' + (tailLine ? ' · ' + tailLine.slice(0, 160) : ''), sec })
      if (!opts.allowMissingResult) {
        const stampAfter = resultStamp(resultPath)
        if (!stampAfter) {
          return finish({ ok: false, code, reason: 'агент не записал ' + path.basename(resultPath), sec })
        }
        if (stampAfter <= stampBefore) {
          return finish({ ok: false, code, reason: path.basename(resultPath) + ' не переписан — на диске файл прошлого прогона', sec })
        }
        // Схема проверяется и на claude: у него нет --output-schema, а audit и status читают
        // именно этот файл. Лишний или пропущенный ключ — провал, как и обещают шаблоны.
        if (job.schemaJson) {
          let data = null
          try { data = JSON.parse(fs.readFileSync(resultPath, 'utf8')) } catch (e) { data = null }
          const probs = data ? schemaProblems(data, job.schemaJson) : ['не читается как JSON']
          if (probs.length) return finish({ ok: false, code, reason: path.basename(resultPath) + ' не по схеме: ' + probs.slice(0, 4).join('; '), sec })
        }
      }
      finish({ ok: true, code, reason: '', sec })
    })
  })
}

// У claude нет флага «положи финальный ответ в файл» — кладём сами из stdout,
// чтобы сырой возврат лежал на диске одинаково на обоих хостах. Из конверта же берётся
// расход: input + output + чтение и запись кэша.
function writeClaudeRaw(job, stdout) {
  const out = { isError: false, tokens: 0, errorText: '' }
  if (!stdout.trim()) return out
  let payload = stdout
  try {
    const env = JSON.parse(stdout)
    out.isError = Boolean(env && env.is_error === true)
    const u = (env && env.usage) || {}
    out.tokens = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((a, k) => a + (Number(u[k]) || 0), 0)
    if (out.isError) out.errorText = String(env.result || env.error || '') + (env.api_error_status ? ' ' + env.api_error_status : '')
    if (env && typeof env.result === 'string') {
      try { payload = JSON.stringify(JSON.parse(env.result), null, 2) }
      catch (e) { payload = JSON.stringify(env, null, 2) }
    } else {
      payload = JSON.stringify(env, null, 2)
    }
  } catch (e) { /* не JSON — кладём как есть */ }
  try { fs.writeFileSync(job.rawPath, payload) } catch (e) { /* диск занят — логи всё равно есть */ }
  return out
}

async function runJob(job, opts) {
  let last = null
  let tokens = 0
  let transient = 0
  for (let attempt = 1; ; attempt++) {
    last = await runAttempt(job, opts, attempt)
    tokens += last.tokens || 0
    last.attempts = attempt
    if (last.ok || last.fatal) break
    if (last.kind === 'limit') {
      if (!fatal) fatal = 'лимит хоста исчерпан (' + job.label + ': ' + last.reason + '). Новые задачи не запускаются: повтор до сброса лимита бессмыслен'
      break
    }
    // Сеть и перегрузка: пауза и повтор сверх --retries, пока не кончатся паузы.
    if (last.kind === 'transient' && transient < BACKOFF_MS.length && !fatal) {
      const wait = BACKOFF_MS[transient++]
      console.log('  ' + job.label + ': ' + last.reason + ' — пауза ' + Math.round(wait / 1000) + ' с и повтор')
      await sleep(wait)
      continue
    }
    if (attempt - transient > opts.retries || fatal) break
    console.log('  ' + job.label + ': ' + last.reason + ' — повтор ' + (attempt - transient) + ' из ' + opts.retries)
  }
  last.tokens = tokens
  return last
}

// Очередь живая: после успешного ресерча темы её верификатор встаёт в конец той же
// очереди (onDone). Параллелизм общий, порядок «ресерч → верификация» внутри темы соблюдён.
async function pool(queue, opts, onDone) {
  const results = new Map()
  let next = 0
  let active = 0
  const worker = async () => {
    for (;;) {
      if (fatal) return
      if (next >= queue.length) {
        if (!active) return
        await sleep(100)
        continue
      }
      const job = queue[next++]
      active++
      console.log('→ ' + job.label + (job.chained ? ' (следом за ресерчем)' : '') + ' · ' + (job.route.model || 'модель хоста') + ' · запуск ' + next + ' из ' + queue.length)
      const r = await runJob(job, opts)
      results.set(job.label, r)
      console.log((r.ok ? '✔ ' : '✘ ') + job.label + ' · ' + r.sec + ' с' + (r.tokens ? ' · ' + fmt(r.tokens) + ' токенов' : '') + (r.ok ? '' : ' · ' + r.reason))
      if (r.ok && onDone) onDone(job, queue)
      active--
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, worker))
  return results
}

// ---------------------------------------------------------------- таблица

function pad(s, n) {
  s = String(s)
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function table(jobs, results) {
  const rows = jobs.map(j => {
    const r = results.get(j.label) || { ok: false, sec: 0, attempts: 0, reason: 'не запускалась' }
    const resultPath = j.rawPath.replace(/\.raw\.json$/, '.json')
    return {
      label: j.label,
      status: r.ok ? 'ок' : 'провал',
      sec: (r.sec || 0) + ' с',
      attempts: String(r.attempts || 0),
      tokens: r.tokens ? fmt(r.tokens) : '—',
      result: fs.existsSync(resultPath) ? 'есть' : 'нет',
      why: r.ok ? '' : r.reason,
    }
  })
  const w = {
    label: Math.max(6, ...rows.map(r => r.label.length)),
    status: 6,
    sec: Math.max(5, ...rows.map(r => r.sec.length)),
    attempts: 7,
    tokens: Math.max(7, ...rows.map(r => r.tokens.length)),
    result: 9,
  }
  console.log('')
  console.log(pad('задача', w.label) + '  ' + pad('итог', w.status) + '  ' + pad('время', w.sec) + '  ' +
    pad('попыток', w.attempts) + '  ' + pad('токенов', w.tokens) + '  ' + pad('результат', w.result) + '  причина')
  console.log('-'.repeat(w.label + w.status + w.sec + w.attempts + w.tokens + w.result + 20))
  for (const r of rows) {
    console.log(pad(r.label, w.label) + '  ' + pad(r.status, w.status) + '  ' + pad(r.sec, w.sec) + '  ' +
      pad(r.attempts, w.attempts) + '  ' + pad(r.tokens, w.tokens) + '  ' + pad(r.result, w.result) + '  ' + r.why)
  }
}

// Ключ записи расхода: верификатор, поставленный следом за ресерчем, считается в партии
// research — так же пишутся партии Workflow (ресерчер и верификатор вместе).
const runStageOf = (job) => (job.chained ? 'research' : stageOfLabel(job.label))

function appendRunLog(root, opts, jobs, results, sec) {
  const ok = jobs.filter(j => (results.get(j.label) || {}).ok).map(j => j.label)
  const failed = jobs.map(j => j.label).filter(l => !ok.includes(l))
  const tokens = jobs.reduce((a, j) => a + ((results.get(j.label) || {}).tokens || 0), 0)
  const routes = [...new Set(jobs.map(j => (j.route.model || 'хоста') + '/' + (j.route.effort || 'хоста')))].join(', ')
  const note = 'fanout · параллельно ' + opts.concurrency + ' · модель/усилие ' + routes + ' · веб-поиск ' + (opts.webSearch ? 'вкл' : 'выкл') +
    ' · ' + Math.round(sec / 60) + ' мин' + (failed.length ? ' · упали или не запускались: ' + failed.join(', ') : '')
  // В колонке «Задачи» — только успешные: журнал читают как «что собрано».
  try {
    appendRunLogRow(root, [
      todayISO(), opts.stage || [...new Set(jobs.map(runStageOf))].join('+'), opts.engine, ok.join(', ') || '—',
      ok.length + '/' + jobs.length + ' успешно' + (tokens ? ', ' + fmt(tokens) + ' токенов' : ''), note,
    ])
  } catch (e) {
    console.error('Не удалось дописать ' + path.join(root, 'state', 'run-log.md') + ': ' + e.message)
  }
}

// Расход партии в engine.json (runs) — по записи на стадию: по ним status.mjs уточняет
// оценку оставшейся цены. Пишутся только задачи, которые реально запускались.
function recordUsage(root, opts, jobs, results, sec) {
  const groups = new Map()
  for (const j of jobs) {
    const r = results.get(j.label)
    if (!r) continue
    const k = runStageOf(j)
    const g = groups.get(k) || { agents: 0, tokens: 0, labels: [] }
    g.agents++
    g.tokens += r.tokens || 0
    if (r.ok) g.labels.push(j.label)
    groups.set(k, g)
  }
  const out = []
  for (const [stage, g] of groups) {
    try {
      out.push(recordRun(root, {
        stage, host: opts.engine, labels: g.labels, agents: g.agents, tokens: g.tokens,
        minutes: Math.max(1, Math.round(sec / 60)), note: 'fanout, расход из ответа хоста' + (g.tokens ? '' : ' (хост не отдал токены)'),
      }))
    } catch (e) { console.error('Расход партии не записан в engine.json: ' + e.message) }
  }
  return out
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2))
const engine = loadEngine(opts.root)
let labels = normalizeLabels(opts, engine)
const taskFile = (l) => path.join(opts.root, 'state', 'tasks', l + '.md')
const resultFile = (l) => path.join(opts.root, 'state', 'results', l + '.json')

// Файлы задач — единственный источник правды. Нет файла — нечего исполнять.
const missing = labels.filter(l => !fs.existsSync(taskFile(l)))
if (missing.length) {
  const byStage = {}
  for (const l of missing) { const st = stageOfLabel(l); (byStage[st] = byStage[st] || []).push(l.split('__').slice(1).join('__')) }
  fail('нет файлов задач для: ' + missing.join(', ') +
    '\n  Сначала отрендерь их: ' + Object.entries(byStage).map(([st, ls]) =>
      'node ' + script('render-tasks.mjs') + ' --root ' + shq(opts.root) + ' --stage ' + st + ' --labels ' + ls.join(',')).join('; '))
}

// Цепочка «ресерч → верификация»: верификатор темы встаёт в очередь после её ресерча.
// Явный verify__x рядом с research__x убирается — иначе он стартовал бы раньше отчёта.
const chain = opts.verify
const slugOfResearch = (l) => (l.startsWith('research__') ? l.slice('research__'.length) : null)
if (chain) {
  const researched = new Set(labels.map(slugOfResearch).filter(Boolean))
  const dropped = labels.filter(l => l.startsWith('verify__') && researched.has(l.slice('verify__'.length)))
  if (dropped.length) {
    labels = labels.filter(l => !dropped.includes(l))
    console.log('Верификаторы ' + dropped.join(', ') + ' пойдут следом за своим ресерчем, а не параллельно с ним')
  }
}

const pendingVerify = [] // верификаторы тем, чей ресерч уже готов (--skip-done)
if (opts.skipDone) {
  const before = labels.length
  const done = labels.filter(l => fs.existsSync(resultFile(l)))
  labels = labels.filter(l => !done.includes(l))
  if (chain) {
    for (const l of done) {
      const slug = slugOfResearch(l)
      if (slug && !fs.existsSync(resultFile('verify__' + slug)) && fs.existsSync(taskFile('verify__' + slug))) pendingVerify.push('verify__' + slug)
    }
  }
  if (before !== labels.length) console.log('Пропущено готовых задач: ' + (before - labels.length) + ' (--skip-done)' + (pendingVerify.length ? '; верификация ещё нужна: ' + pendingVerify.join(', ') : ''))
  labels = [...labels, ...pendingVerify.filter(l => !labels.includes(l))]
  if (!labels.length) {
    console.log('Все задачи стадии уже сделаны. Дальше: node ' + script('status.mjs') + ' --root ' + shq(opts.root) +
      ' — следующая команда, затем node ' + script('audit.mjs') + ' --root ' + shq(opts.root))
    await flushAndExit(0)
  }
}

function makeJob(l, chained = false) {
  const route = routeOfJob(l, opts, engine)
  const j = buildCommand(l, opts, opts.root, route)
  j.label = l
  j.cwd = opts.root
  j.route = route
  j.chained = chained
  const schemaPath = j.schema || schemaFor(l, opts.root, false)
  j.schemaJson = null
  if (schemaPath) { try { j.schemaJson = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) } catch (e) { j.schemaJson = null } }
  if (!j.schemaJson) console.error('Предупреждение: нет схемы возврата для ' + l + ' — результат проверяется только на наличие, не по схеме')
  return j
}

const jobs = labels.map(l => makeJob(l))
// Цепочка: какие верификаторы встанут следом и для каких тем их задачи не отрендерены.
const chainFor = (job) => {
  const slug = chain && slugOfResearch(job.label)
  if (!slug) return null
  const v = 'verify__' + slug
  return fs.existsSync(taskFile(v)) ? v : null
}
const noVerifyTask = chain ? jobs.map(j => slugOfResearch(j.label)).filter(Boolean).filter(slug => !fs.existsSync(taskFile('verify__' + slug))) : []
if (noVerifyTask.length) {
  console.error('Предупреждение: нет задач верификатора для ' + noVerifyTask.join(', ') + ' — после ресерча верификация не пойдёт. Отрендерь: node ' +
    script('render-tasks.mjs') + ' --root ' + shq(opts.root) + ' --stage research --labels ' + noVerifyTask.join(','))
}

console.log('Движок: ' + (engine.title || engine.slug || opts.root))
console.log('Стадия: ' + (opts.stage || 'по списку labels') + ' · задач ' + jobs.length +
  (chain && jobs.some(j => chainFor(j)) ? ' + верификаторы следом (' + jobs.filter(j => chainFor(j)).length + ')' : '') +
  ' · хост ' + opts.engine + ' · параллельно ' + opts.concurrency + ' · таймаут ' + opts.timeoutSec + ' с · повторов ' + opts.retries)

// Честный рассказ про веб-поиск: recon, research и verify без него бессмысленны, остальным он не нужен.
const webCount = jobs.filter(j => isWebJob(j.label)).length
const webScope = !webCount ? 'не нужен ни одной задаче партии — стадии работают по корпусу на диске'
  : webCount === jobs.length ? 'нужен всем задачам партии' : 'нужен ' + webCount + ' из ' + jobs.length + ' задач (recon, research, verify)'
if (opts.engine === 'codex') {
  console.log('Веб-поиск: ' + webScope + '; -c web_search="' + (opts.webSearch && webCount ? 'live' : 'disabled') + '"' + (webCount && webCount < jobs.length ? ' только у них' : '') +
    (opts.strictConfig ? ' (с --strict-config: незнакомый ключ или значение падают громко)' : ' (без --strict-config: незнакомый ключ будет проглочен молча)'))
} else {
  console.log('Веб-поиск: ' + webScope + '. У claude флага нет: WebSearch и WebFetch зависят от настроек сессии, ' +
    'требование поднять их вписано в промпт. Если в логе задачи поиска нет — включи их в settings.json хоста.')
}
// Считаем по самим задачам, а не по --stage: с --labels research__x стадия пустая,
// а интернет задаче нужен ровно так же.
const webJobs = jobs.filter(j => isWebJob(j.label))
if (!opts.webSearch && webJobs.length) {
  console.error('Внимание: --web-search off, а среди задач есть recon/research/verify (' +
    webJobs.map(j => j.label).join(', ') +
    '). Без веб-поиска отчёт и разведка пишутся по памяти модели — это брак, а не экономия.')
}

// Режим субагентов Codex: тот же контракт, что у процесса, — промпт на задачу.
if (opts.printPrompts) {
  console.log('\n--print-prompts: промпты для субагентов (spawn_agent), по одному агенту на задачу. Верификатор темы — только после того, как её ресерчер вернул результат.\n')
  const list = [...jobs, ...jobs.map(chainFor).filter(Boolean).map(l => makeJob(l, true))]
  for (const j of list) {
    console.log('=== ' + j.label + (j.chained ? ' · после ресерча темы' : '') + ' ===')
    console.log(taskPrompt(opts.root, j.label, opts))
    console.log('')
  }
  await flushAndExit(0)
}

if (opts.dryRun) {
  console.log('\n--dry-run: команды печатаются целиком, ничего не запускается.\n')
  const list = [...jobs, ...jobs.map(chainFor).filter(Boolean).map(l => makeJob(l, true))]
  for (const j of list) {
    console.log('# ' + j.label + (j.chained ? ' — встанет в очередь после успешного ресерча темы' : ''))
    console.log('#   задача: ' + taskFile(j.label))
    console.log('#   лог:    ' + j.logPath)
    console.log('#   raw:    ' + j.rawPath)
    if (j.schema) console.log('#   схема:  ' + j.schema)
    console.log('#   cwd:    ' + j.cwd)
    console.log('#   модель: ' + (j.route.model || 'по умолчанию хоста') + ' · усилие: ' + (j.route.effort || 'по умолчанию хоста'))
    console.log(renderCommand(j))
    console.log('')
  }
  await flushAndExit(0)
}

let interrupted = false
const onSignal = () => {
  if (interrupted) return
  interrupted = true
  fatal = 'прерывание с клавиатуры'
  console.error('\nПрерывание: убиваем ' + running.size + ' процессов агентов.')
  for (const c of running) killTree(c, 'SIGTERM')
  setTimeout(() => { for (const c of running) killTree(c, 'SIGKILL'); process.exit(130) }, 5000).unref()
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

const queue = [...jobs]
const t0 = Date.now()
const results = await pool(queue, opts, (job, q) => {
  const v = chainFor(job)
  if (v && !q.some(x => x.label === v)) q.push(makeJob(v, true))
})
const totalSec = Math.round((Date.now() - t0) / 1000)

// Верификаторы, которые не встали в очередь из-за упавшего ресерча, в итогах видны как «не запускалась».
for (const j of jobs) {
  const v = chainFor(j)
  if (v && !queue.some(x => x.label === v)) queue.push(makeJob(v, true))
}

table(queue, results)
appendRunLog(opts.root, opts, queue, results, totalSec)
const recorded = opts.record ? recordUsage(opts.root, opts, queue, results, totalSec) : []
const totalTokens = queue.reduce((a, j) => a + ((results.get(j.label) || {}).tokens || 0), 0)

// Статусы тем и сводов — по тому, что агенты записали на диск.
try {
  const fresh = JSON.parse(fs.readFileSync(path.join(opts.root, 'engine.json'), 'utf8'))
  const { changes } = syncStatuses(opts.root, fresh, 'fanout')
  if (changes.length) console.log('\nСтатусы сверены с диском: ' + changes.join(', '))
} catch (e) {
  console.error('Статусы не сверены с диском: ' + e.message + '. Сверь вручную: node ' + script('status.mjs') + ' --root ' + shq(opts.root) + ' --write')
}

const failed = queue.filter(j => !(results.get(j.label) || {}).ok).map(j => j.label)
console.log('')
console.log('Итого: ' + (queue.length - failed.length) + '/' + queue.length + ' за ' + Math.round(totalSec / 60) + ' мин' +
  (totalTokens ? ', ' + fmt(totalTokens) + ' токенов' : '') + '.' +
  (recorded.length ? ' Расход записан в engine.json (runs): ' + recorded.map(r => r.stage + ' — ' + r.agents + ' агентов').join('; ') + '.' : ''))
if (fatal && !interrupted) {
  console.error('\nПрогон остановлен: ' + fatal)
}
if (failed.length) {
  console.log('Упали или не запускались: ' + failed.join(', '))
  // повтор с теми же флагами: без них --engine claude --model haiku превращался в прогон на codex.
  // Упавший верификатор повторяется сам по себе, без ресерча: отчёт уже на диске.
  const keep = []
  const src = process.argv.slice(2).flatMap(a => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]))
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '--stage' || src[i] === '--labels') { i++; continue }
    if (src[i] === '--skip-done' || src[i] === '--dry-run') continue
    keep.push(src[i])
  }
  console.log('Смотри логи в ' + path.join(opts.root, 'state', 'logs') + ', затем перезапусти только упавшие' +
    (/лимит/.test(fatal) ? ' — после сброса лимита' : '') + ':')
  console.log('  node ' + script('fanout.mjs') + ' ' + keep.map(shq).join(' ') + ' --labels ' + failed.join(','))
  await flushAndExit(1)
}
const R = shq(opts.root)
if (!chain && queue.some(j => j.label.startsWith('research__'))) {
  const slugs = queue.filter(j => j.label.startsWith('research__')).map(j => j.label.slice('research__'.length))
  console.log('Дальше — верификация этих тем (партия шла с --no-verify): node ' + script('fanout.mjs') + ' --root ' + R +
    ' --stage verify --labels ' + slugs.map(x => 'verify__' + x).join(',') + ' --engine ' + opts.engine + '.')
}
console.log('Дальше: node ' + script('status.mjs') + ' --root ' + R + ' — статусы по диску и следующая команда;')
console.log('  затем node ' + script('audit.mjs') + ' --root ' + R + ' — проверка закона конвейера по этой стадии.')

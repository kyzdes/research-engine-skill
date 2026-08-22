#!/usr/bin/env node
// fanout.mjs — портируемый исполнитель стадий движка ресерча.
// Мост в Codex CLI и в любой хост без Workflow-тула: на каждую задачу поднимает
// отдельный процесс агента, держит лимит параллелизма, пишет логи и сырые возвраты.
// Node 18+, ESM, без зависимостей.
//
// Флаги хостов сверены на машине сборки 22.08.2026:
//   codex-cli 0.146.0 — codex exec: --json, --output-schema <FILE>, -o/--output-last-message <FILE>,
//     -C/--cd <DIR>, --skip-git-repo-check, -s/--sandbox <read-only|workspace-write|danger-full-access>,
//     -m/--model, -c/--config <key=value>, --color <always|never|auto>, --strict-config.
//     Веб-поиск: у codex exec НЕТ флага --search (он есть только у интерактивного codex),
//     включается ключом конфига  -c tools.web_search=true .
//     Проверено: с --strict-config неизвестный ключ падает с «unknown configuration field»,
//     а tools.web_search проходит; БЕЗ --strict-config опечатка в ключе глотается молча
//     и агент уходит в ресерч без интернета. Поэтому --strict-config включён по умолчанию.
//   claude — -p/--print, --output-format json, --permission-mode bypassPermissions,
//     --add-dir <directories...> (variadic: забирает все следующие позиционные аргументы,
//     поэтому промпт нельзя ставить сразу после него — см. buildCommand),
//     --model, --effort <low|medium|high|xhigh|max>. Флага веб-поиска нет:
//     WebSearch/WebFetch зависят от настроек сессии, поэтому требование поднять их
//     вписано в промпт, а не в командную строку.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')

const STAGES = ['research', 'verify', 'synth', 'merge', 'critique', 'method', 'agent-doc']

// Стадии, где отчёт без интернета — брак.
const WEB_STAGES = ['research', 'verify']

// Стадия → схема возврата (§5 контракта). Ключ — префикс label до двойного подчёркивания.
const SCHEMA_BY_PREFIX = {
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
  --model <m>              модель агента (по умолчанию — настройка хоста)
  --effort <level>         усилие рассуждения; для claude это --effort
                           (low|medium|high|xhigh|max), для codex это
                           -c model_reasoning_effort="<level>"
  --retries <n>            повторов после первого провала (по умолчанию 1)
  --timeout-sec <n>        таймаут на процесс (по умолчанию 5400)
  --web-search on|off      веб-поиск агенту (по умолчанию on)
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
  --help                   эта справка

Почему параллелизм 3 по умолчанию: девять тяжёлых агентов разом выжигают лимит
сессии за считанные минуты (замер на сборке aso-engine: 2,2 млн токенов за пять
минут). Партии по 3-4 — правило, а не осторожность.

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
  }
  const need = (i, name) => {
    if (i + 1 >= argv.length) fail('у флага ' + name + ' нет значения')
    return argv[i + 1]
  }
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
  o.root = path.resolve(o.root.replace(/^~(?=\/|$)/, process.env.HOME || '~'))
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
  return {
    slug: typeof e.slug === 'string' ? e.slug : '',
    title: typeof e.title === 'string' ? e.title : '',
    topics: Array.isArray(e.topics) ? e.topics.filter(t => t && typeof t.slug === 'string') : [],
    syntheses: Array.isArray(e.syntheses) ? e.syntheses.filter(s => s && typeof s.label === 'string') : [],
  }
}

// §4: имена задач. Стадия → список labels.
function labelsForStage(stage, engine) {
  if (stage === 'research') return engine.topics.map(t => 'research__' + t.slug)
  if (stage === 'verify') return engine.topics.map(t => 'verify__' + t.slug)
  if (stage === 'synth') return engine.syntheses.map(s => 'synth__' + s.label)
  if (stage === 'merge') return ['merge__facts-bank']
  if (stage === 'critique') return ['critique__gaps']
  if (stage === 'method') return ['method__method']
  if (stage === 'agent-doc') return ['method__agent']
  return []
}

const PREFIX_BY_STAGE = {
  research: 'research', verify: 'verify', synth: 'synth',
  merge: 'merge', critique: 'critique', method: 'method', 'agent-doc': 'method',
}

function normalizeLabels(opts, engine) {
  if (!opts.labels.length) {
    const list = labelsForStage(opts.stage, engine)
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

function schemaFor(label, root) {
  const prefix = label.split('__')[0]
  const name = SCHEMA_BY_PREFIX[prefix]
  if (!name) {
    fail('не знаю схему для задачи ' + label + '. Префикс должен быть одним из: ' + Object.keys(SCHEMA_BY_PREFIX).join(', '))
  }
  const inEngine = path.join(root, 'schemas', name)
  if (fs.existsSync(inEngine)) return inEngine
  const inSkill = path.join(SKILL_DIR, 'schemas', name)
  if (fs.existsSync(inSkill)) return inSkill
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
    'Закон конвейера: ни один шаг не сжимает содержание. Всё, что ты выбросишь ради краткости, потеряно навсегда — на следующем шаге восстанавливать будет неоткуда. Полнота важнее элегантности: лучше лишняя таблица с цифрами, чем аккуратное саммари.',
    '',
    'Последним действием запиши результат одним JSON-объектом по схеме из задачи в файл:',
    path.join(root, 'state', 'results', label + '.json'),
    'и верни тот же объект своим финальным ответом. Результат на диске обязателен: без него задача считается проваленной, даже если сам документ написан.',
    '',
    'Рабочий корень движка: ' + root + '. Пути в задаче абсолютные — используй их как есть, ничего не выдумывай.',
  ]
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

function buildCommand(label, opts, root) {
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
    args.push('-c', 'tools.web_search=' + (opts.webSearch ? 'true' : 'false'))
    if (opts.model) args.push('-m', opts.model)
    if (opts.effort) args.push('-c', 'model_reasoning_effort="' + opts.effort + '"')
    args.push(prompt)
    return { cmd: 'codex', args, rawPath, logPath, schema, captureStdout: false }
  }

  // claude: без --output-schema (§6) — структурированный результат агент кладёт на диск сам.
  // Порядок флагов не косметика: --add-dir у claude объявлен как <directories...>,
  // то есть забирает все идущие следом позиционные аргументы. Если поставить его
  // последним, промпт уедет во второй каталог, и claude упадёт с
  // «Input must be provided either through stdin or as a prompt argument».
  // Проверено 22.08.2026. Поэтому после --add-dir всегда стоит флаг со своим значением,
  // а промпт идёт последним позиционным.
  const args = ['-p', '--permission-mode', opts.permissionMode, '--add-dir', root, '--output-format', 'json']
  if (opts.model) args.push('--model', opts.model)
  if (opts.effort) args.push('--effort', opts.effort)
  args.push(prompt)
  return { cmd: 'claude', args, rawPath, logPath, schema: '', captureStdout: true }
}

function shq(s) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(String(s)) ? String(s) : "'" + String(s).replace(/'/g, "'\\''") + "'"
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
      return resolve({ ok: false, code: null, reason: 'не готовится state/: ' + e.message, sec: 0 })
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
      return resolve({ ok: false, code: null, reason: 'не запустился: ' + e.message, sec: 0 })
    }

    running.add(child)
    let stdout = ''
    let timedOut = false
    let configError = ''

    const sniff = text => {
      if (configError) return
      for (const mark of CONFIG_ERROR_MARKS) {
        if (text.includes(mark)) { configError = text.split('\n').find(l => l.includes(mark)).trim(); return }
      }
    }

    child.stdout.on('data', d => { const s = d.toString(); write(s); sniff(s); if (job.captureStdout) stdout += s })
    child.stderr.on('data', d => { const s = d.toString(); write(s); sniff(s) })

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
      write('\n[fanout] ' + (payload.ok ? 'успех' : 'провал: ' + payload.reason) + ' · ' + payload.sec + ' с\n')
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
      const claudeError = job.captureStdout ? writeClaudeRaw(job, stdout) : false
      if (configError && code !== 0) {
        fatal = 'codex не принял конфиг: ' + configError +
          '\n  Это ломает все задачи одинаково. Либо почини ключ, либо запусти с --no-strict-config' +
          ' (тогда веб-поиск может не включиться — на стадиях research и verify это брак).'
        return finish({ ok: false, code, reason: 'конфиг хоста отвергнут: ' + configError, sec, fatal: true })
      }
      if (timedOut) return finish({ ok: false, code, reason: 'таймаут ' + opts.timeoutSec + ' с', sec })
      if (code !== 0) return finish({ ok: false, code, reason: 'код возврата ' + code + (signal ? ' · сигнал ' + signal : ''), sec })
      // claude умеет завершиться нулём и при этом отдать is_error: true
      if (claudeError) return finish({ ok: false, code, reason: 'хост вернул is_error: true', sec })
      if (!opts.allowMissingResult) {
        const stampAfter = resultStamp(resultPath)
        if (!stampAfter) {
          return finish({ ok: false, code, reason: 'агент не записал ' + path.basename(resultPath), sec })
        }
        if (stampAfter <= stampBefore) {
          return finish({ ok: false, code, reason: path.basename(resultPath) + ' не переписан — на диске файл прошлого прогона', sec })
        }
      }
      finish({ ok: true, code, reason: '', sec })
    })
  })
}

// У claude нет флага «положи финальный ответ в файл» — кладём сами из stdout,
// чтобы сырой возврат лежал на диске одинаково на обоих хостах.
function writeClaudeRaw(job, stdout) {
  if (!stdout.trim()) return false
  let payload = stdout
  let isError = false
  try {
    const env = JSON.parse(stdout)
    isError = env && env.is_error === true
    if (env && typeof env.result === 'string') {
      try { payload = JSON.stringify(JSON.parse(env.result), null, 2) }
      catch (e) { payload = JSON.stringify(env, null, 2) }
    } else {
      payload = JSON.stringify(env, null, 2)
    }
  } catch (e) { /* не JSON — кладём как есть */ }
  try { fs.writeFileSync(job.rawPath, payload) } catch (e) { /* диск занят — логи всё равно есть */ }
  return isError
}

async function runJob(job, opts) {
  let last = null
  for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
    last = await runAttempt(job, opts, attempt)
    last.attempts = attempt
    if (last.ok || last.fatal) return last
    if (attempt <= opts.retries) {
      console.log('  ' + job.label + ': ' + last.reason + ' — повтор ' + attempt + ' из ' + opts.retries)
    }
  }
  return last
}

async function pool(jobs, opts) {
  const results = new Map()
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      if (fatal) return
      const job = jobs[next++]
      console.log('→ ' + job.label + ' (запуск ' + next + ' из ' + jobs.length + ')')
      const r = await runJob(job, opts)
      results.set(job.label, r)
      console.log((r.ok ? '✔ ' : '✘ ') + job.label + ' · ' + r.sec + ' с' + (r.ok ? '' : ' · ' + r.reason))
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, worker))
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
      result: fs.existsSync(resultPath) ? 'есть' : 'нет',
      raw: fs.existsSync(j.rawPath) ? String(fs.statSync(j.rawPath).size) + ' Б' : '—',
      why: r.ok ? '' : r.reason,
    }
  })
  const w = {
    label: Math.max(6, ...rows.map(r => r.label.length)),
    status: 6,
    sec: Math.max(5, ...rows.map(r => r.sec.length)),
    attempts: 7,
    result: 9,
    raw: Math.max(8, ...rows.map(r => r.raw.length)),
  }
  console.log('')
  console.log(pad('задача', w.label) + '  ' + pad('итог', w.status) + '  ' + pad('время', w.sec) + '  ' +
    pad('попыток', w.attempts) + '  ' + pad('результат', w.result) + '  ' + pad('raw', w.raw) + '  причина')
  console.log('-'.repeat(w.label + w.status + w.sec + w.attempts + w.result + w.raw + 20))
  for (const r of rows) {
    console.log(pad(r.label, w.label) + '  ' + pad(r.status, w.status) + '  ' + pad(r.sec, w.sec) + '  ' +
      pad(r.attempts, w.attempts) + '  ' + pad(r.result, w.result) + '  ' + pad(r.raw, w.raw) + '  ' + r.why)
  }
}

function appendRunLog(root, opts, jobs, results, sec) {
  const okCount = jobs.filter(j => (results.get(j.label) || {}).ok).length
  const line = '- ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC · fanout · стадия ' +
    (opts.stage || 'по списку labels') + ' · хост ' + opts.engine + ' · задач ' + jobs.length +
    ' · успешно ' + okCount + ' · провалено ' + (jobs.length - okCount) +
    ' · параллельно ' + opts.concurrency + ' · модель ' + (opts.model || 'по умолчанию хоста') +
    ' · усилие ' + (opts.effort || 'по умолчанию хоста') +
    ' · веб-поиск ' + (opts.webSearch ? 'вкл' : 'выкл') + ' · ' + Math.round(sec / 60) + ' мин\n'
  const p = path.join(root, 'state', 'run-log.md')
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, fs.existsSync(p) ? line : '# Журнал прогонов\n\n' + line)
  } catch (e) {
    console.error('Не удалось дописать ' + p + ': ' + e.message)
  }
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2))
const engine = loadEngine(opts.root)
let labels = normalizeLabels(opts, engine)

// Файлы задач — единственный источник правды. Нет файла — нечего исполнять.
const missing = labels.filter(l => !fs.existsSync(path.join(opts.root, 'state', 'tasks', l + '.md')))
if (missing.length) {
  fail('нет файлов задач для: ' + missing.join(', ') +
    '\n  Сначала отрендерь их: node render-tasks.mjs --root ' + opts.root +
    (opts.stage ? ' --stage ' + opts.stage : ''))
}

if (opts.skipDone) {
  const before = labels.length
  labels = labels.filter(l => !fs.existsSync(path.join(opts.root, 'state', 'results', l + '.json')))
  if (before !== labels.length) console.log('Пропущено готовых задач: ' + (before - labels.length) + ' (--skip-done)')
  if (!labels.length) {
    console.log('Все задачи стадии уже сделаны. Дальше: node audit.mjs --root ' + opts.root)
    process.exit(0)
  }
}

const jobs = labels.map(l => {
  const j = buildCommand(l, opts, opts.root)
  j.label = l
  j.cwd = opts.root
  return j
})

console.log('Движок: ' + (engine.title || engine.slug || opts.root))
console.log('Стадия: ' + (opts.stage || 'по списку labels') + ' · задач ' + jobs.length + ' · хост ' + opts.engine +
  ' · параллельно ' + opts.concurrency + ' · таймаут ' + opts.timeoutSec + ' с · повторов ' + opts.retries)

// Честный рассказ про веб-поиск: стадии research и verify без него бессмысленны.
if (opts.engine === 'codex') {
  console.log('Веб-поиск: -c tools.web_search=' + (opts.webSearch ? 'true' : 'false') +
    (opts.strictConfig ? ' (с --strict-config: незнакомый ключ падает громко)' : ' (без --strict-config: незнакомый ключ будет проглочен молча)'))
} else {
  console.log('Веб-поиск: у claude флага нет. WebSearch и WebFetch зависят от настроек сессии; ' +
    'требование поднять их вписано в промпт. Если в логе задачи поиска нет — включи их в settings.json хоста.')
}
// Считаем по самим задачам, а не по --stage: с --labels research__x стадия пустая,
// а интернет задаче нужен ровно так же.
const webJobs = jobs.filter(j => WEB_STAGES.includes(j.label.split('__')[0]))
if (!opts.webSearch && webJobs.length) {
  console.error('Внимание: --web-search off, а среди задач есть research/verify (' +
    webJobs.map(j => j.label).join(', ') +
    '). Без веб-поиска отчёт пишется по памяти модели — это брак, а не экономия.')
}

if (opts.dryRun) {
  console.log('\n--dry-run: команды печатаются целиком, ничего не запускается.\n')
  for (const j of jobs) {
    console.log('# ' + j.label)
    console.log('#   задача: ' + path.join(opts.root, 'state', 'tasks', j.label + '.md'))
    console.log('#   лог:    ' + j.logPath)
    console.log('#   raw:    ' + j.rawPath)
    if (j.schema) console.log('#   схема:  ' + j.schema)
    console.log('#   cwd:    ' + j.cwd)
    console.log(renderCommand(j))
    console.log('')
  }
  process.exit(0)
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

const t0 = Date.now()
const results = await pool(jobs, opts)
const totalSec = Math.round((Date.now() - t0) / 1000)

table(jobs, results)
appendRunLog(opts.root, opts, jobs, results, totalSec)

const failed = jobs.filter(j => !(results.get(j.label) || {}).ok).map(j => j.label)
console.log('')
console.log('Итого: ' + (jobs.length - failed.length) + '/' + jobs.length + ' за ' + Math.round(totalSec / 60) + ' мин.')
if (fatal && !interrupted) {
  console.error('\nПрогон остановлен: ' + fatal)
}
if (failed.length) {
  console.log('Упали: ' + failed.join(', '))
  console.log('Смотри логи в ' + path.join(opts.root, 'state', 'logs') + ', затем перезапусти только упавшие:')
  console.log('  node fanout.mjs --root ' + opts.root + ' --labels ' + failed.join(','))
  process.exit(1)
}
console.log('Дальше: node audit.mjs --root ' + opts.root + ' — проверка закона конвейера по этой стадии.')

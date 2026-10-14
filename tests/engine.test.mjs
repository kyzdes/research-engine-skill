// Регрессии скриптов движка: настоящие скрипты на временном движке, без сети и без агентов.
// Запуск: node --test tests/engine.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = path.join(REPO, 'skills', 'research-engine')
const SCRIPTS = path.join(SKILL, 'scripts')

const LIB = await import(path.join(SCRIPTS, 'lib', 'engine.mjs'))
const { todayISO } = LIB

function run(name, args, env) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, name), ...args], { encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const TOPICS = ['01-alpha', '02-beta', '03-gamma', '04-delta', '05-epsilon']

// Движок профиля S с банком фактов частями, навигатором и GAPS.md — ровно та раскладка,
// на которой fanout раньше требовал файлы задач synth__gaps и synth__facts-bank.
function makeEngine(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 're-engine-'))
  const root = path.join(dir, 'x-engine')
  const answers = {
    root, slug: 'x', title: 'X', profile: 'S', finish: 'method', today: '2026-01-01',
    mission: 'Тестовый движок: проверяет скрипты конвейера без агентов.',
    perimeter: { in: ['всё про X'], out: ['всё про Y'] },
    topics: TOPICS.map((slug, i) => ({ slug, title: slug, what: 'тема ' + i, feeds: [i < 3 ? 'field-spec' : 'verdicts'], answers: (opts.answers || {})[slug] || [] })),
    syntheses: [
      { label: 'field-spec', primary: ['01-alpha', '02-beta', '03-gamma'] },
      { label: 'verdicts', primary: ['04-delta', '05-epsilon'] },
      { label: 'facts-bank-a', file: 'FACTS-BANK-a.md', primary: ['01-alpha', '02-beta'] },
      { label: 'facts-bank-b', file: 'FACTS-BANK-b.md', primary: ['03-gamma', '04-delta', '05-epsilon'] },
      { label: 'facts-bank', file: 'FACTS-BANK.md', primary: ['facts-bank-a', 'facts-bank-b'] },
      { label: 'gaps', file: 'GAPS.md' },
    ],
    ...(opts.brief ? { brief: opts.brief } : {}),
  }
  const answersPath = path.join(dir, 'answers.json')
  fs.writeFileSync(answersPath, JSON.stringify(answers))
  const init = run('engine-init.mjs', ['--from', answersPath])
  assert.equal(init.code, 0, init.err)
  for (const t of TOPICS) {
    fs.writeFileSync(path.join(root, 'prompts', t + '.md'), '# ' + t + '\n\n## Вопросы ресерча\n\n1. Как устроен ' + t + ' внутри системы?\n')
  }
  for (const s of ['field-spec', 'verdicts', 'facts-bank-a', 'facts-bank-b']) {
    fs.writeFileSync(path.join(root, 'synthesis-spec', s + '.md'), '# ' + s + '\n')
  }
  return root
}

const readEngine = (root) => JSON.parse(fs.readFileSync(path.join(root, 'engine.json'), 'utf8'))
const tasks = (root) => fs.readdirSync(path.join(root, 'state', 'tasks')).sort()
// Отчёт агента-ресерчера: файл отчёта и результат research__<slug>.json, как пишет агент.
function writeReport(root, slug, body) {
  fs.writeFileSync(path.join(root, 'reports', slug + '.md'), body)
  fs.mkdirSync(path.join(root, 'state', 'results'), { recursive: true })
  fs.writeFileSync(path.join(root, 'state', 'results', 'research__' + slug + '.json'), JSON.stringify({ topic: slug }))
}

test('synth: render-tasks и fanout видят один набор задач, GAPS и навигатор банка — не задачи synth', () => {
  const root = makeEngine()
  const r = run('render-tasks.mjs', ['--root', root, '--stage', 'synth'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(tasks(root), ['synth__facts-bank-a.md', 'synth__facts-bank-b.md', 'synth__field-spec.md', 'synth__verdicts.md'])
  const f = run('fanout.mjs', ['--root', root, '--stage', 'synth', '--dry-run'])
  assert.equal(f.code, 0, 'fanout --stage synth упал: ' + f.err)
  assert.doesNotMatch(f.out, /synth__gaps|synth__facts-bank\b(?!-)/)
  for (const l of ['synth__field-spec', 'synth__verdicts', 'synth__facts-bank-a', 'synth__facts-bank-b']) assert.match(f.out, new RegExp('# ' + l))
})

test('«Сегодня» в промпте — дата рендера, а не дата заведения движка; --today её подменяет', () => {
  const root = makeEngine()
  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'research']).code, 0)
  const text = fs.readFileSync(path.join(root, 'state', 'tasks', 'research__01-alpha.md'), 'utf8')
  assert.match(text, new RegExp('Сегодня \\*\\*' + todayISO() + '\\*\\*'))
  assert.doesNotMatch(text, /Сегодня \*\*2026-01-01\*\*/)
  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'research', '--force', '--today', '2027-03-04']).code, 0)
  assert.match(fs.readFileSync(path.join(root, 'state', 'tasks', 'research__01-alpha.md'), 'utf8'), /Сегодня \*\*2027-03-04\*\*/)
})

test('render-tasks возвращает устаревшую копию исполнителя к версии скилла', () => {
  const root = makeEngine()
  const copy = path.join(root, 'workflows', 'research.mjs')
  fs.writeFileSync(copy, '// старая версия\n')
  const r = run('render-tasks.mjs', ['--root', root, '--stage', 'research'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /workflows\/research\.mjs \(обновлён\)/)
  assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(SKILL, 'workflows', 'research.mjs'), 'utf8'))
})

test('status: статусы по диску, только повышение, строка журнала внутри таблицы', () => {
  const root = makeEngine()
  writeReport(root, '01-alpha', '# 01\n\nтекст отчёта\n\n## Верификация (2026-01-02)\n\nпроверено\n')
  writeReport(root, '02-beta', '# 02\n\nтекст отчёта без верификации\n')
  const e = readEngine(root)
  e.topics.find(t => t.slug === '05-epsilon').status = 'verified' // статус опережает диск: отчёта нет
  fs.writeFileSync(path.join(root, 'engine.json'), JSON.stringify(e, null, 2))

  const dry = JSON.parse(run('status.mjs', ['--root', root, '--json']).out)
  const by = Object.fromEntries(dry.topics.map(t => [t.slug, t]))
  assert.equal(by['01-alpha'].derived, 'verified')
  assert.equal(by['02-beta'].derived, 'researched')
  assert.equal(by['03-gamma'].derived, 'planned')
  assert.ok(dry.problems.some(p => p.startsWith('05-epsilon')), 'расхождение «статус есть, отчёта нет» не замечено')
  assert.equal(dry.next.stage, 'research')
  // 05-epsilon числится verified, но отчёта нет — по диску её ещё ресерчить
  assert.deepEqual(dry.next.labels, ['03-gamma', '04-delta', '05-epsilon'])
  assert.equal(readEngine(root).topics[0].status, 'planned', 'без --write engine.json трогать нельзя')

  const w = run('status.mjs', ['--root', root, '--write'])
  assert.equal(w.code, 0, w.err)
  const after = Object.fromEntries(readEngine(root).topics.map(t => [t.slug, t.status]))
  assert.equal(after['01-alpha'], 'verified')
  assert.equal(after['02-beta'], 'researched')
  assert.equal(after['05-epsilon'], 'verified', 'status понизил статус — потерянный отчёт спрятан от аудита')

  const log = fs.readFileSync(path.join(root, 'state', 'run-log.md'), 'utf8').split('\n')
  const row = log.findIndex(l => l.startsWith('| ' + todayISO() + ' | status |'))
  assert.ok(row > 0, 'строка status не дописана')
  assert.match(log[row - 1], /^\|/, 'строка status оторвана от таблицы')
})

test('status ведёт верификацию отдельным шагом, без повторного ресерча', () => {
  const root = makeEngine()
  for (const t of TOPICS) writeReport(root, t, '# ' + t + '\n\nотчёт\n')
  const s = JSON.parse(run('status.mjs', ['--root', root, '--json']).out)
  assert.equal(s.next.stage, 'verify')
  assert.match(s.next.text, /"stage":"verify"/)
})

test('audit: ссылка внутри inline-кода не блокер, битая ссылка — блокер; GAPS и навигатор банка без ложных предупреждений', () => {
  const root = makeEngine()
  fs.writeFileSync(path.join(root, 'reports', '01-alpha.md'),
    '# 01\n\nПаттерн `rg "[a-z](foo)"` ищет вызовы.\n\nСм. [исходник](missing-file.md).\n')
  const r = run('audit.mjs', ['--root', root, '--json'])
  const audit = JSON.parse(r.out)
  const links = audit.findings.filter(f => f.code === 'broken-link')
  assert.equal(links.length, 1, JSON.stringify(links))
  assert.match(links[0].message, /missing-file\.md/)
  const noise = audit.findings.filter(f =>
    (f.code === 'synthesis-without-primary' || f.code === 'no-synthesis-spec') && /gaps|GAPS|facts-bank(?!-)/.test(f.message + f.file))
  assert.deepEqual(noise, [], 'особые файлы движка дали ложные предупреждения')
})

test('схемы внутри Workflow-исполнителей совпадают с schemas/*.json', () => {
  const grab = (file, name) => {
    const code = fs.readFileSync(path.join(SKILL, 'workflows', file), 'utf8')
    const at = code.indexOf(name + ' = OVERRIDE')
    assert.ok(at >= 0, name + ' не найдена в ' + file)
    const start = code.indexOf('{', at)
    let depth = 0, end = start
    for (; end < code.length; end++) {
      if (code[end] === '{') depth++
      if (code[end] === '}' && --depth === 0) break
    }
    return Function('return (' + code.slice(start, end + 1) + ')')()
  }
  const disk = (f) => JSON.parse(fs.readFileSync(path.join(SKILL, 'schemas', f), 'utf8'))
  assert.deepEqual(grab('research.mjs', 'RESEARCH_SCHEMA'), disk('research.json'))
  assert.deepEqual(grab('research.mjs', 'VERIFY_SCHEMA'), disk('verify.json'))
  assert.deepEqual(grab('synthesis.mjs', 'FILE_SCHEMA'), disk('file.json'))
  assert.deepEqual(grab('synthesis.mjs', 'GAPS_SCHEMA'), disk('gaps.json'))
})

// Workflow-скрипт — тело async-функции с глобалами agent/pipeline/parallel/phase/log/args.
async function runWorkflow(file, args, override) {
  const src = fs.readFileSync(path.join(SKILL, 'workflows', file), 'utf8').replace(/^export const meta/m, 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push(opts)
    if (override) { const r = await override(opts); if (r !== undefined) return r }
    if (opts.label.startsWith('research__')) return { reportPath: '/r.md', headline: 'h', sourceCount: 1, approxWords: 10 }
    if (opts.label.startsWith('verify__')) return { wordsBefore: 10, wordsAfter: 20, coverageVerdict: 'full', stillMissing: [], corrections: [] }
    return { path: '/f.md', summary: 's', sections: [], factsCarried: 0, approxWords: 1, openIssues: [] }
  }
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (it, i) => {
    let acc = it
    for (const st of stages) acc = await st(acc, it, i)
    return acc
  }))
  const parallel = async (thunks) => Promise.all(thunks.map(t => t().catch(() => null)))
  const fn = new AsyncFunction('args', 'agent', 'pipeline', 'parallel', 'phase', 'log', src)
  const result = await fn(args, agent, pipeline, parallel, () => {}, () => {})
  return { result, calls }
}

test('research.mjs: stage verify гоняет только верификатор и пробрасывает model', async () => {
  const { result, calls } = await runWorkflow('research.mjs', { root: '/tmp/x-engine', labels: ['verify__01-alpha', '02-beta'], stage: 'verify', model: 'm-1' })
  assert.deepEqual(calls.map(c => c.label), ['verify__01-alpha', 'verify__02-beta'])
  assert.ok(calls.every(c => c.model === 'm-1'))
  assert.deepEqual(result.failed, [])
  assert.equal(result.reports.length, 2)
  assert.match(result.next, /status\.mjs --root \/tmp\/x-engine --record verify/)
})

test('research.mjs: по умолчанию ресерч и следом верификатор, без model — модель сессии', async () => {
  const { result, calls } = await runWorkflow('research.mjs', { root: '/tmp/x-engine', labels: ['01-alpha'] })
  assert.deepEqual(calls.map(c => c.label), ['research__01-alpha', 'verify__01-alpha'])
  assert.ok(calls.every(c => !('model' in c)))
  assert.equal(result.reports[0].words, 20)
})

test('synthesis.mjs: model пробрасывается, next ведёт через status.mjs', async () => {
  const { result, calls } = await runWorkflow('synthesis.mjs', { root: '/tmp/x-engine', stage: 'synth', labels: ['field-spec'], model: 'm-2' })
  assert.deepEqual(calls.map(c => [c.label, c.model]), [['synth__field-spec', 'm-2']])
  assert.match(result.next, /status\.mjs --root \/tmp\/x-engine \(/)
})

// ---------------------------------------------------------------- бриф

test('бриф: init с одним запросом — блокеры и код 1; разведка рендерится без миссии, ресерч — нет', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 're-brief-'))
  const root = path.join(dir, 'b-engine')
  assert.equal(run('engine-init.mjs', ['--root', root, '--slug', 'b', '--profile', 'M', '--request', 'собери базу по холодным письмам для B2B']).code, 0)
  assert.ok(fs.existsSync(path.join(root, 'BRIEF.md')) && fs.existsSync(path.join(root, 'inputs')) && fs.existsSync(path.join(root, 'brief')))
  assert.equal(readEngine(root).brief.request, 'собери базу по холодным письмам для B2B')

  const b = run('brief.mjs', ['--root', root, '--json'])
  assert.equal(b.code, 1)
  const out = JSON.parse(b.out)
  assert.equal(out.ok, false)
  for (const re of [/brief\.jobs/, /brief\.acceptance/, /mission/, /perimeter\.out/]) assert.ok(out.blockers.some(x => re.test(x)), 'нет блокера ' + re)
  assert.ok(out.warnings.some(w => /RECON\.md/.test(w)), 'профиль M без разведки не замечен')

  const r = run('render-tasks.mjs', ['--root', root, '--stage', 'recon'])
  assert.equal(r.code, 0, r.err)
  const task = fs.readFileSync(path.join(root, 'state', 'tasks', 'recon__field.md'), 'utf8')
  assert.match(task, /Дословно: «собери базу по холодным письмам для B2B»/)
  assert.match(task, /работа базы ещё выясняется/)
  assert.match(task, new RegExp(path.join(root, 'brief', 'RECON.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.notEqual(run('render-tasks.mjs', ['--root', root, '--stage', 'research']).code, 0, 'ресерч без миссии отрендерился')

  const st = JSON.parse(run('status.mjs', ['--root', root, '--json']).out)
  assert.equal(st.next.stage, 'brief')
})

const FULL_BRIEF = {
  request: 'собери базу по X',
  restated: 'База по X для агента, который пишет Y.',
  users: ['AI-агент', 'владелец процесса'],
  jobs: ['пишу Y и получаю Z'],
  deliverables: ['документ Y'],
  acceptance: ['Какой лимит у поля Q на дату D?', { id: 'A7', question: 'Сколько касаний делать до отказа?', job: 'пишу Y и получаю Z' }, 'Что ломается без настройки N?'],
  inputs: [{ ref: 'inputs/crm.csv', kind: 'данные', use: 'сверить с открытыми источниками', trust: 'внутренние, 2026-09' }],
  sources: { must: ['example.org/spec'], avoid: ['blog.example.com'] },
  known: ['основы X'],
  freshness: 'на октябрь 2026, обновление раз в квартал',
}

test('бриф доходит до задач: работа, контрольные вопросы темы, материалы, политика источников', () => {
  const root = makeEngine({ brief: FULL_BRIEF, answers: { '01-alpha': ['A1'], '02-beta': ['A7'] } })
  assert.deepEqual(readEngine(root).brief.acceptance.map(a => a.id), ['A1', 'A7', 'A3'])
  assert.match(fs.readFileSync(path.join(root, 'BRIEF.md'), 'utf8'), /\| A7 \| Сколько касаний делать до отказа\? \|/)

  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'research']).code, 0)
  const t1 = fs.readFileSync(path.join(root, 'state', 'tasks', 'research__01-alpha.md'), 'utf8')
  assert.match(t1, /\*\*A1\.\*\* Какой лимит у поля Q на дату D\?/)
  assert.doesNotMatch(t1, /\*\*A7\.\*\*/, 'чужой контрольный вопрос попал в задачу темы')
  assert.match(t1, /пишу Y и получаю Z/)
  assert.ok(t1.includes(path.join(root, 'inputs', 'crm.csv')), 'материал заказчика не дошёл до ресерчера абсолютным путём')
  assert.match(t1, /example\.org\/spec/)
  assert.match(t1, /на октябрь 2026/)
  const t3 = fs.readFileSync(path.join(root, 'state', 'tasks', 'research__03-gamma.md'), 'utf8')
  assert.match(t3, /тема не привязана к контрольным вопросам/)

  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'critique']).code, 0)
  const c = fs.readFileSync(path.join(root, 'state', 'tasks', 'critique__gaps.md'), 'utf8')
  for (const id of ['A1', 'A7', 'A3']) assert.match(c, new RegExp('\\*\\*' + id + '\\.\\*\\*'))

  const b = JSON.parse(run('brief.mjs', ['--root', root, '--json']).out)
  assert.equal(b.ok, true, JSON.stringify(b.blockers))
  assert.deepEqual(b.acceptance.find(a => a.id === 'A7').topics, ['02-beta'])
  assert.ok(b.warnings.some(w => /A3 не закрыт/.test(w)))

  const audit = JSON.parse(run('audit.mjs', ['--root', root, '--json', '--stage', 'prompts']).out)
  const unc = audit.findings.filter(x => x.code === 'acceptance-uncovered')
  assert.equal(unc.length, 1)
  assert.match(unc[0].message, /A3/)
})

test('brief.mjs --write закрепляет id контрольных вопросов и собирает BRIEF.md', () => {
  const root = makeEngine({ brief: FULL_BRIEF })
  const e = readEngine(root)
  e.brief.acceptance = ['Вопрос один?', 'Вопрос два?']
  fs.writeFileSync(path.join(root, 'engine.json'), JSON.stringify(e, null, 2))
  fs.rmSync(path.join(root, 'BRIEF.md'))
  const w = run('brief.mjs', ['--root', root, '--write'])
  assert.equal(w.code, 0, w.out + w.err)
  assert.deepEqual(readEngine(root).brief.acceptance, [
    { id: 'A1', question: 'Вопрос один?' }, { id: 'A2', question: 'Вопрос два?' }])
  assert.match(fs.readFileSync(path.join(root, 'BRIEF.md'), 'utf8'), /\| A2 \| Вопрос два\? \|/)
})

test('synthesis.mjs: стадия recon — один разведчик, next ведёт к brief.mjs, без status.mjs', async () => {
  const { result, calls } = await runWorkflow('synthesis.mjs', { root: '/tmp/x-engine', stage: 'recon', labels: ['recon'] })
  assert.deepEqual(calls.map(c => c.label), ['recon__field'])
  assert.match(result.next, /brief\.mjs --root \/tmp\/x-engine --write/)
  assert.doesNotMatch(result.next, /status\.mjs/)
})

test('разведка видит решённое с заказчиком и допущения брифа', () => {
  const root = makeEngine({ brief: { ...FULL_BRIEF, constraints: ['база с нуля, не дельта'], assumptions: ['рынки US и RU — не подтверждено'] } })
  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'recon']).code, 0)
  const t = fs.readFileSync(path.join(root, 'state', 'tasks', 'recon__field.md'), 'utf8')
  assert.match(t, /Уже решено с заказчиком[^\n]*\n- база с нуля, не дельта/)
  assert.match(t, /- рынки US и RU — не подтверждено/)
})

// ---------------------------------------------------------------- маршрут моделей

test('маршрут моделей: умолчания в engine.json, части банка дешевле плейбуков, переопределение', async () => {
  const lib = await import(path.join(SCRIPTS, 'lib', 'engine.mjs'))
  const root = makeEngine()
  const e = readEngine(root)
  assert.equal(e.models.verify, 'opus')
  assert.equal(e.models.research, 'sonnet')
  assert.equal(e.efforts.research, 'high')
  const bankPart = e.syntheses.find(s => s.label === 'facts-bank-a')
  const playbook = e.syntheses.find(s => s.label === 'field-spec')
  assert.equal(lib.routeFor(e, 'synth', bankPart).model, 'sonnet')
  assert.equal(lib.routeFor(e, 'synth', playbook).model, 'opus')
  assert.equal(lib.routeFor({ models: { research: 'haiku' } }, 'research').model, 'haiku')
  assert.deepEqual(lib.workflowArgs(e, root, 'synth', ['field-spec', 'facts-bank-a']).models, { 'field-spec': 'opus', 'facts-bank-a': 'sonnet' })
  assert.deepEqual(lib.workflowArgs(e, root, 'research', ['01-alpha']).models, { research: 'sonnet', verify: 'opus' })
})

test('render-tasks и status печатают аргументы исполнителя с маршрутом моделей', () => {
  const root = makeEngine()
  const r = run('render-tasks.mjs', ['--root', root, '--stage', 'research'])
  assert.match(r.out, /"models":\{"research":"sonnet","verify":"opus"\}/)
  const st = JSON.parse(run('status.mjs', ['--root', root, '--json']).out)
  assert.match(st.next.text, /"models":\{"research":"sonnet","verify":"opus"\}/)
})

test('fanout на claude берёт модель по стадии, флаг сильнее; на codex маршрут не подставляется', () => {
  const root = makeEngine()
  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'synth']).code, 0)
  const c = run('fanout.mjs', ['--root', root, '--stage', 'synth', '--engine', 'claude', '--dry-run']).out
  const block = (label) => c.split('# ' + label + '\n')[1].split('\n\n')[0]
  assert.match(block('synth__field-spec'), /--model opus --effort high/)
  assert.match(block('synth__facts-bank-a'), /--model sonnet --effort medium/)
  const forced = run('fanout.mjs', ['--root', root, '--stage', 'synth', '--engine', 'claude', '--model', 'haiku', '--dry-run']).out
  assert.doesNotMatch(forced, /--model (opus|sonnet)/)
  const codex = run('fanout.mjs', ['--root', root, '--stage', 'synth', '--engine', 'codex', '--dry-run']).out
  assert.doesNotMatch(codex, / -m (opus|sonnet)/)
})

test('исполнители раздают модели по ролям и задачам', async () => {
  const r = await runWorkflow('research.mjs', { root: '/tmp/x-engine', labels: ['01-alpha'], models: { research: 'sonnet', verify: 'opus' }, efforts: { research: 'high', verify: 'xhigh' } })
  assert.deepEqual(r.calls.map(c => [c.label, c.model, c.effort]), [['research__01-alpha', 'sonnet', 'high'], ['verify__01-alpha', 'opus', 'xhigh']])
  const s = await runWorkflow('synthesis.mjs', { root: '/tmp/x-engine', stage: 'synth', labels: ['field-spec', 'facts-bank-a'], models: { 'field-spec': 'opus', 'facts-bank-a': 'sonnet' } })
  assert.deepEqual(s.calls.map(c => [c.label, c.model]), [['synth__field-spec', 'opus'], ['synth__facts-bank-a', 'sonnet']])
  assert.deepEqual(s.result.models, { 'field-spec': 'opus', 'facts-bank-a': 'sonnet' })
})

test('audit: многоточие в дословной цитате, URL и коде — не след сжатия; «и т.д.» в тексте — след', () => {
  const root = makeEngine()
  fs.writeFileSync(path.join(root, 'reports', '01-alpha.md'), [
    '# 01', '',
    'Apple пишет: «Ratings and reviews … can influence how your app ranks».',
    'Адрес: https://example.com/api/v2/... и код `a...b`.',
    'Поля: name, subtitle и т.д.', '',
  ].join('\n'))
  const audit = JSON.parse(run('audit.mjs', ['--root', root, '--stage', 'research', '--json']).out)
  const comp = audit.findings.filter(f => f.code === 'compression' && f.file.endsWith('01-alpha.md'))
  assert.equal(comp.length, 1, JSON.stringify(comp))
  assert.match(comp[0].message, /и т\.д\./)
})

test('audit: маркер сжатия ищется целым словом, числовой диапазон с многоточием — не сжатие', () => {
  const root = makeEngine()
  fs.writeFileSync(path.join(root, 'reports', '01-alpha.md'), [
    '# 01', '',
    'Что в таблице не пропущено намеренно: платные инструменты вынесены отдельно.',
    'Неделя 2025-01-05…2025-01-11 и диапазон 3...5 дней.',
    'Детали опущено.', '',
  ].join('\n'))
  const audit = JSON.parse(run('audit.mjs', ['--root', root, '--stage', 'research', '--json']).out)
  const comp = audit.findings.filter(f => f.code === 'compression' && f.file.endsWith('01-alpha.md'))
  assert.deepEqual(comp.map(f => f.line), [5])
})

test('audit: даты, идентификаторы, источник в колонке таблицы, голый домен и расчёт — не «число без источника»; настоящее число — да', () => {
  const root = makeEngine()
  fs.writeFileSync(path.join(root, 'reports', '01-alpha.md'), [
    '# 01', '',
    '**Дата сборки:** 14.10.2026, данные на 11–13.08.2026.',
    'Препринт arXiv 2602.23234 и iOS 27.1, пункт 2.3.1(a), раздел 12.1.',
    '',
    '| показатель | значение | источник | дата |',
    '|---|---|---|---|',
    '| Trial→paid | 43,5 % | RevenueCat | то же |',
    '',
    '12. iTunes Search API: лимит 200 · Apple · 14.10.2026 · performance-partners.apple.com/search-api.',
    'LTV = $9,99 × 0,85 × 2,22 = $18,87.',
    '', '', '', '', // окно поиска источника — ±3 строки; настоящее число стоит за его пределами
    'Конверсия страницы выросла на 37,5 % после смены иконки.',
    '',
  ].join('\n'))
  const audit = JSON.parse(run('audit.mjs', ['--root', root, '--stage', 'research', '--json', '--all']).out)
  const nums = audit.findings.filter(f => f.code === 'number-without-source' && f.file.endsWith('01-alpha.md'))
  assert.deepEqual(nums.map(f => f.line), [16], JSON.stringify(nums.map(f => f.message)))
})

test('машинный вывод не обрезается в пайпе: --json на тысячах находок — целый JSON', () => {
  const root = makeEngine()
  const body = ['# 01', ''].concat(Array.from({ length: 3000 }, (_, i) => 'Строка ' + i + ': рост на 12,' + (i % 10) + ' % без источника.'))
  fs.writeFileSync(path.join(root, 'reports', '01-alpha.md'), body.join('\n'))
  const r = run('audit.mjs', ['--root', root, '--stage', 'research', '--json', '--all'])
  assert.ok(r.out.length > 200000, 'вывод подозрительно короткий: ' + r.out.length)
  const audit = JSON.parse(r.out)
  assert.ok(audit.findings.filter(f => f.code === 'number-without-source').length >= 3000)
})

test('status: отчёт без результата агента — «в работе», статус не повышается и в партию не ставится', () => {
  const root = makeEngine()
  fs.writeFileSync(path.join(root, 'reports', '01-alpha.md'), '# 01\n\nнедописанный отчёт\n')
  const s = JSON.parse(run('status.mjs', ['--root', root, '--json', '--write']).out)
  const t = s.topics.find(x => x.slug === '01-alpha')
  assert.equal(t.inProgress, true)
  assert.equal(t.derived, 'planned')
  assert.ok(!s.next.labels.includes('01-alpha'), 'тема в работе попала в следующую партию')
  assert.match(s.next.text, /в работе/)
  assert.equal(readEngine(root).topics[0].status, 'planned')
})

test('render-tasks сам сверяет статусы с диском перед стадией', () => {
  const root = makeEngine()
  writeReport(root, '01-alpha', '# 01\n\nтекст\n\n## Верификация (2026-01-02)\n\nок\n')
  const r = run('render-tasks.mjs', ['--root', root, '--stage', 'research'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /Статусы сверены с диском[^\n]*01-alpha planned→verified/)
  assert.equal(readEngine(root).topics.find(t => t.slug === '01-alpha').status, 'verified')
})

test('status --record пишет партию в runs и уточняет оценку цены по своим прогонам', () => {
  const root = makeEngine()
  const before = JSON.parse(run('status.mjs', ['--root', root, '--json']).out).cost
  assert.ok(before.agents > 0 && before.tokens > 0)
  const research = before.rows.find(r => r.key === 'research')
  assert.match(research.basis, /замер/)
  const w = run('status.mjs', ['--root', root, '--record', 'research', '--agents', '8', '--tokens', '8000000', '--minutes', '70', '--labels', '01-alpha,02-beta'])
  assert.equal(w.code, 0, w.err)
  const e = readEngine(root)
  assert.equal(e.runs.at(-1).tokens, 8000000)
  const after = JSON.parse(run('status.mjs', ['--root', root, '--json']).out).cost
  const r2 = after.rows.find(r => r.key === 'research')
  assert.equal(r2.perAgent, 1000000)
  assert.match(r2.basis, /свои прогоны/)
  assert.match(fs.readFileSync(path.join(root, 'state', 'run-log.md'), 'utf8'), /\| research \| claude \| 01-alpha, 02-beta \| 8 агентов, 8 000 000 токенов, 70 мин \|/)
})

test('research.mjs: упавший верификатор — провал верификации, а не ресерча; пустой ответ агента — провал', async () => {
  const thrown = await runWorkflow('research.mjs', { root: '/tmp/x-engine', labels: ['01-alpha'] },
    async (o) => { if (o.label.startsWith('verify__')) throw new Error('budget') })
  assert.deepEqual(thrown.result.failed, [])
  assert.deepEqual(thrown.result.verifyFailed, ['01-alpha'])
  assert.match(thrown.result.next, /render-tasks\.mjs --root \/tmp\/x-engine --stage verify --labels 01-alpha/)
  const empty = await runWorkflow('research.mjs', { root: '/tmp/x-engine', labels: ['01-alpha'] },
    async (o) => (o.label.startsWith('research__') ? { reportPath: '', headline: '' } : undefined))
  assert.deepEqual(empty.result.failed, ['01-alpha'])
  assert.deepEqual(empty.calls.map(c => c.label), ['research__01-alpha'], 'после пустого ресерча верификатор запускаться не должен')
})

test('research.mjs: verify__ без stage — только верификация; смешанные метки — ошибка; метки строкой', async () => {
  const v = await runWorkflow('research.mjs', { root: '/tmp/x-engine', labels: ['verify__01-alpha'] })
  assert.deepEqual(v.calls.map(c => c.label), ['verify__01-alpha'])
  await assert.rejects(runWorkflow('research.mjs', { root: '/tmp/x-engine', labels: ['research__01-alpha', 'verify__02-beta'] }), /смешаны/)
  const str = await runWorkflow('research.mjs', { root: '/tmp/x-engine', labels: '01-alpha, 02-beta', verify: false })
  assert.deepEqual(str.calls.map(c => c.label), ['research__01-alpha', 'research__02-beta'])
  assert.deepEqual(str.result.unverified, ['01-alpha', '02-beta'])
  assert.match(str.result.next, /--stage verify --labels 01-alpha,02-beta/)
})

test('research.mjs: явные model и effort сильнее маршрута', async () => {
  const r = await runWorkflow('research.mjs', { root: '/tmp/x-engine', labels: ['01-alpha'], models: { research: 'sonnet', verify: 'opus' }, model: 'haiku', effort: 'low' })
  assert.ok(r.calls.every(c => c.model === 'haiku' && c.effort === 'low'), JSON.stringify(r.calls))
})

// ---------------------------------------------------------------- находки ревью скриптов

const audit = (root, stage = 'all') => JSON.parse(run('audit.mjs', ['--root', root, '--stage', stage, '--json']).out)
const codes = (a, level) => a.findings.filter(x => !level || x.level === level).map(x => x.code)
const verified = (root, slug) => {
  writeReport(root, slug, '# ' + slug + '\n\nтекст отчёта\n\n## Верификация (2026-01-02)\n\nпроверено\n')
  fs.writeFileSync(path.join(root, 'state', 'results', 'verify__' + slug + '.json'), JSON.stringify({ wordsBefore: 1, wordsAfter: 5 }))
}

test('render-tasks: первая партия и команда Codex — только непрогнанные темы, по меткам; верификация в Codex отдельным прогоном', () => {
  const root = makeEngine()
  for (const t of ['01-alpha', '02-beta', '03-gamma', '04-delta']) verified(root, t)
  const r = run('render-tasks.mjs', ['--root', root, '--stage', 'research'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /"labels":\["05-epsilon"\]/)
  assert.match(r.out, /--stage research --labels research__05-epsilon --engine codex/)
  assert.match(r.out, /--stage verify --labels verify__05-epsilon --engine codex/)
  assert.doesNotMatch(r.out.slice(r.out.indexOf('Дальше:')), /01-alpha/)
  assert.ok(tasks(root).includes('verify__05-epsilon.md'))
})

test('audit: упавший прогон в журнале и общий префикс меток не дают блокеров «нет отчёта»', () => {
  const root = makeEngine()
  LIB.appendRunLogRow(root, ['2026-01-01', 'research', 'codex', '—', '0/5 успешно', 'упали: research__01-alpha, verify__02-beta'])
  const a = audit(root, 'research')
  assert.ok(!codes(a, 'blocker').includes('no-report'), JSON.stringify(a.findings))
  assert.ok(!codes(a, 'blocker').includes('no-verification'))
})

test('audit: пустой отчёт прогнанной темы и GAPS done без файла — блокеры', () => {
  const root = makeEngine()
  writeReport(root, '01-alpha', '')
  const e = readEngine(root)
  e.syntheses.find(x => x.label === 'gaps').status = 'done'
  fs.writeFileSync(path.join(root, 'engine.json'), JSON.stringify(e))
  const a = audit(root)
  const b = a.findings.filter(x => x.level === 'blocker')
  assert.ok(b.some(x => x.code === 'no-report' && /01-alpha/.test(x.file)), JSON.stringify(b))
  assert.ok(b.some(x => x.code === 'no-synthesis-file' && /GAPS/.test(x.file)), JSON.stringify(b))
})

test('audit: ссылки с любой схемой и протокол-относительные — не битые', () => {
  const root = makeEngine()
  writeReport(root, '01-alpha', '# a\n\n[ftp](ftp://x.org/a) [doi](doi:10.1000/182) [f](file:///etc/hosts) [cdn](//cdn.x.org/a.js) [bad](./nope.md)\n')
  const a = audit(root, 'research')
  const broken = a.findings.filter(x => x.code === 'broken-link').map(x => x.message)
  assert.deepEqual(broken, ['битая внутренняя ссылка: ./nope.md'])
})

test('верификация засчитывается только с подписью верификатора: подраздел ресерчера её не заменяет', () => {
  const root = makeEngine()
  writeReport(root, '01-alpha', '# a\n\n### Верификация источников: как отбирали\n\nтекст\n')
  writeReport(root, '02-beta', '# b\n\n## Верификация источников\n\nтекст\n')
  verified(root, '03-gamma')
  const st = JSON.parse(run('status.mjs', ['--root', root, '--json']).out)
  const der = Object.fromEntries(st.topics.map(t => [t.slug, t.derived]))
  assert.equal(der['01-alpha'], 'researched')
  assert.equal(der['02-beta'], 'researched')
  assert.equal(der['03-gamma'], 'verified')
})

test('бриф: явный id не отдаётся вопросу без id; brief.mjs --write сохраняет лишние поля вопроса', () => {
  const nb = LIB.normalizeBrief({ acceptance: ['Первый?', { id: 'A1', question: 'Второй', priority: 'high' }] })
  assert.deepEqual(nb.acceptance.map(a => [a.id, a.question]), [['A2', 'Первый?'], ['A1', 'Второй']])
  const root = makeEngine({ brief: FULL_BRIEF })
  const e = readEngine(root)
  e.brief.acceptance = [{ question: 'Вопрос?', priority: 'high', source: 'заказчик' }, 'Ещё?']
  fs.writeFileSync(path.join(root, 'engine.json'), JSON.stringify(e))
  assert.equal(run('brief.mjs', ['--root', root, '--write']).code, 0)
  assert.deepEqual(readEngine(root).brief.acceptance, [{ question: 'Вопрос?', priority: 'high', source: 'заказчик', id: 'A1' }, { id: 'A2', question: 'Ещё?' }])
})

test('engine-init --force: слияние сохраняет бриф, статусы, журнал и разделы ENGINE.md; бэкапы не затираются', () => {
  const root = makeEngine({ brief: FULL_BRIEF })
  verified(root, '01-alpha')
  assert.equal(run('status.mjs', ['--root', root, '--write']).code, 0)
  const em = path.join(root, 'ENGINE.md')
  fs.writeFileSync(em, fs.readFileSync(em, 'utf8').replace('## Журнал решений\n', '## Журнал решений\n\nРЕШЕНИЕ-МАРКЕР\n') + '\n## Свой раздел\n\nСВОЙ-МАРКЕР\n')
  const ans = path.join(path.dirname(root), 'answers2.json')
  fs.writeFileSync(ans, JSON.stringify({ topics: TOPICS.map(t => ({ slug: t, title: t, what: 'новое ' + t, feeds: ['field-spec'] })) }))
  for (let i = 0; i < 2; i++) {
    const r = run('engine-init.mjs', ['--root', root, '--from', ans, '--force'])
    assert.equal(r.code, 0, r.out + r.err)
  }
  const e = readEngine(root)
  assert.equal(e.brief.request, FULL_BRIEF.request)
  assert.equal(e.mission, 'Тестовый движок: проверяет скрипты конвейера без агентов.')
  assert.equal(e.topics.find(t => t.slug === '01-alpha').status, 'verified')
  assert.equal(e.topics.find(t => t.slug === '02-beta').what, 'новое 02-beta')
  const md = fs.readFileSync(em, 'utf8')
  assert.match(md, /РЕШЕНИЕ-МАРКЕР/)
  assert.match(md, /СВОЙ-МАРКЕР/)
  const log = fs.readFileSync(path.join(root, 'state', 'run-log.md'), 'utf8')
  assert.match(log, /\| status \|/)
  assert.match(log, /init --force/)
  const baks = fs.readdirSync(root).filter(x => x.startsWith('engine.json.bak-'))
  assert.equal(baks.length, 1, baks.join(', ')) // второй --force ничего не поменял — нового бэкапа нет
  const r3 = run('engine-init.mjs', ['--root', root, '--title', 'Новое имя', '--force'])
  assert.equal(r3.code, 0)
  assert.equal(fs.readdirSync(root).filter(x => x.startsWith('engine.json.bak-')).length, 2)
})

test('engine-init без --force поверх движка: ответы не применены — громко и с кодом 1', () => {
  const root = makeEngine()
  const ans = path.join(path.dirname(root), 'a3.json')
  fs.writeFileSync(ans, JSON.stringify({ topics: [] }))
  const r = run('engine-init.mjs', ['--root', root, '--from', ans])
  assert.equal(r.code, 1)
  assert.match(r.err, /НЕ применены/)
  assert.match(r.out, /тем в engine.json: 5/)
})

test('engine-init сохраняет parts и when у сводов; метки с / и запятой — ошибка; кириллическая метка — своё имя файла', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 're-parts-'))
  const ans = path.join(dir, 'a.json')
  const base = { root: path.join(dir, 'p-engine'), slug: 'p', mission: 'm', perimeter: { in: ['a'], out: ['b'] }, topics: [{ slug: '01-a', what: 'a', feeds: ['рынок'] }] }
  fs.writeFileSync(ans, JSON.stringify({ ...base, syntheses: [
    { label: 'рынок', primary: ['01-a'], when: 'Когда спорят о рынке.' },
    { label: 'bank-prices', file: 'BANK-PRICES.md', primary: ['01-a'] },
    { label: 'facts-bank', file: 'FACTS-BANK.md', parts: ['bank-prices'] },
  ] }))
  const r = run('engine-init.mjs', ['--from', ans])
  assert.equal(r.code, 0, r.err)
  const e = readEngine(path.join(dir, 'p-engine'))
  assert.equal(e.syntheses[0].file, 'РЫНОК.md')
  assert.equal(e.syntheses[0].when, 'Когда спорят о рынке.')
  assert.deepEqual(e.syntheses[2].parts, ['bank-prices'])
  assert.equal(LIB.routeFor(e, 'synth', e.syntheses[1]).key, 'bank')
  fs.writeFileSync(ans, JSON.stringify({ ...base, root: path.join(dir, 'q-engine'), topics: [{ slug: 'rynok/ceny' }] }))
  const bad = run('engine-init.mjs', ['--from', ans])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /rynok\/ceny/)
})

test('матрица «тема → свод»: feeds без primary и дубль файла — предупреждения аудита', () => {
  const root = makeEngine()
  const e = readEngine(root)
  e.topics.find(t => t.slug === '04-delta').feeds = ['field-spec']
  e.syntheses.push({ label: 'dup', file: 'VERDICTS.md', primary: ['04-delta'] })
  fs.writeFileSync(path.join(root, 'engine.json'), JSON.stringify(e))
  const m = audit(root, 'prompts').findings.filter(x => x.code === 'matrix').map(x => x.message).join('\n')
  assert.match(m, /тема 04-delta указывает в feeds свод field-spec/)
  assert.match(m, /пишут один файл synthesis\/VERDICTS\.md/)
})

test('пути с пробелом в печатаемых командах взяты в кавычки; ~ в --root раскрывается', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 're-home-'))
  const r = run('engine-init.mjs', ['--root', '~/my engine', '--slug', 'sp', '--request', 'тест'], { HOME: home })
  assert.equal(r.code, 0, r.err)
  const root = path.join(home, 'my engine')
  assert.ok(fs.existsSync(path.join(root, 'engine.json')))
  const st = run('status.mjs', ['--root', root])
  assert.match(st.out, new RegExp("--root '" + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'"))
  assert.doesNotMatch(r.out, /--stage recon[^\n]*--root [^']/)
})

test('флаг без значения не съедает следующий флаг', () => {
  const r = run('status.mjs', ['--root', '--write'])
  assert.equal(r.code, 2)
  assert.match(r.err, /нет значения/)
})

test('журнал прогонов: параллельные записи не теряют строк', async () => {
  const root = makeEngine()
  const { spawn } = await import('node:child_process')
  const code = 'const L = await import(process.argv[1]); L.appendRunLogRow(process.argv[2], ["d", "s", "h", "t" + process.argv[3], "i", "n"])'
  await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise(res => {
    spawn(process.execPath, ['--input-type=module', '-e', code, path.join(SCRIPTS, 'lib', 'engine.mjs'), root, String(i)], { stdio: 'ignore' }).on('close', res)
  })))
  const log = fs.readFileSync(path.join(root, 'state', 'run-log.md'), 'utf8')
  for (let i = 0; i < 20; i++) assert.match(log, new RegExp('\\| t' + i + ' \\|'))
})

// Поддельный claude: пишет в state/results/<label>.json то, что лежит в FAKE_RESULT, и выходит с FAKE_CODE.
function fakeClaude() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 're-bin-'))
  const p = path.join(bin, 'claude')
  fs.writeFileSync(p, '#!' + process.execPath + '\nconst fs = require("fs"); const a = process.argv[process.argv.length - 1];\n' +
    'const m = a.match(/(\\/[^\\s]*state\\/results\\/[^\\s]+\\.json)/); if (m && process.env.FAKE_RESULT) fs.writeFileSync(m[1], process.env.FAKE_RESULT);\n' +
    'process.stdout.write(JSON.stringify({ result: "{}" })); process.exit(Number(process.env.FAKE_CODE || 0))\n')
  fs.chmodSync(p, 0o755)
  return bin
}

test('fanout: повтор упавших — с исходными флагами; в журнале задач — только успешные; результат не по схеме — провал', () => {
  const root = makeEngine()
  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'synth']).code, 0)
  const bin = fakeClaude()
  const env = { PATH: bin + path.delimiter + process.env.PATH, FAKE_CODE: '1' }
  const r = run('fanout.mjs', ['--root', root, '--labels', 'synth__field-spec', '--engine', 'claude', '--model', 'haiku', '--web-search', 'off', '--retries', '0'], env)
  assert.equal(r.code, 1)
  assert.match(r.out, /fanout\.mjs --root \S+ --engine claude --model haiku --web-search off --retries 0 --labels synth__field-spec/)
  const rows = fs.readFileSync(path.join(root, 'state', 'run-log.md'), 'utf8').split('\n').filter(l => /\| claude \|/.test(l))
  assert.match(rows[rows.length - 1], /\| claude \| — \| 0\/1 успешно/)
  const bad = run('fanout.mjs', ['--root', root, '--labels', 'synth__field-spec', '--engine', 'claude', '--retries', '0'],
    { PATH: env.PATH, FAKE_RESULT: JSON.stringify({ path: '/x', extra: 1 }) })
  assert.equal(bad.code, 1)
  assert.match(bad.out, /не по схеме: нет ключа summary/)
  const good = run('fanout.mjs', ['--root', root, '--labels', 'synth__field-spec', '--engine', 'claude', '--retries', '0'],
    { PATH: env.PATH, FAKE_RESULT: JSON.stringify({ path: '/x', summary: 's', sections: [], factsCarried: 0, approxWords: 1, openIssues: [] }) })
  assert.equal(good.code, 0, good.out + good.err)
})

test('fanout: веб-поиск только на recon/research/verify; закон навигатора — на method; подсказка рендера — со стадией из метки', () => {
  const root = makeEngine()
  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'synth']).code, 0)
  const d = run('fanout.mjs', ['--root', root, '--labels', 'synth__field-spec', '--dry-run'])
  assert.match(d.out, /tools\.web_search=false/)
  assert.doesNotMatch(d.out, /Веб-поиск тебе включён/)
  assert.match(d.out, /Веб-поиск на этой стадии не нужен/)
  const miss = run('fanout.mjs', ['--root', root, '--labels', 'verify__01-alpha,method__method'])
  assert.equal(miss.code, 2)
  assert.match(miss.err, /--stage verify --labels 01-alpha/)
  assert.match(miss.err, /--stage method --labels method/)
  assert.equal(LIB.lawFor('method'), LIB.LAWS.navigator)
})

test('synthesis.mjs: полная метка держит маршрут; чужая стадия и чужая метка — ошибка; GAPS.md — псевдоним; пустой путь — провал', async () => {
  const { calls } = await runWorkflow('synthesis.mjs', { root: '/tmp/x', stage: 'synth', labels: ['synth__field-spec'], models: { 'field-spec': 'opus' }, efforts: { 'field-spec': 'low' } })
  assert.deepEqual(calls.map(c => [c.label, c.model, c.effort]), [['synth__field-spec', 'opus', 'low']])
  await assert.rejects(runWorkflow('synthesis.mjs', { root: '/tmp/x', stage: 'critique', labels: ['synth__field-spec'] }), /не относится к стадии critique/)
  await assert.rejects(runWorkflow('synthesis.mjs', { root: '/tmp/x', stage: 'method', labels: ['agent'] }), /одна метка — method/)
  const g = await runWorkflow('synthesis.mjs', { root: '/tmp/x', stage: 'critique', labels: ['GAPS.md'] }, () => ({ path: '', verdict: 'ready', losses: [], holes: [], risks: [], blockers: [], acceptance: [] }))
  assert.deepEqual(g.calls.map(c => c.label), ['critique__gaps'])
  assert.deepEqual(g.result.failed, ['critique__gaps'])
  const m = await runWorkflow('synthesis.mjs', { root: '/tmp/x', stage: 'method', labels: ['method'], model: 'haiku', models: { method: 'opus' } })
  assert.equal(m.calls[0].model, 'haiku')
})

test('законы конвейера в Workflow-исполнителях совпадают с LAWS ядра', () => {
  const syn = fs.readFileSync(path.join(SKILL, 'workflows', 'synthesis.mjs'), 'utf8')
  const res = fs.readFileSync(path.join(SKILL, 'workflows', 'research.mjs'), 'utf8')
  const q = (x) => "'" + x + "'"
  assert.ok(syn.includes('const LAW = ' + q(LIB.LAWS.pipeline)), 'synthesis LAW')
  assert.ok(syn.includes('const NAV_LAW = ' + q(LIB.LAWS.navigator)), 'synthesis NAV_LAW')
  assert.ok(syn.includes('law: ' + q(LIB.LAWS.recon)), 'synthesis recon law')
  assert.ok(res.includes('const LAW = ' + q(LIB.LAWS.pipeline)), 'research LAW')
})

test('status: команды Codex рядом с Workflow; финиш — METHOD, затем INDEX, затем AGENT', () => {
  const root = makeEngine()
  const st = run('status.mjs', ['--root', root])
  assert.match(st.out, /Codex: node \S+fanout\.mjs --root \S+ --stage research --labels research__01-alpha/)
  assert.match(st.out, /--stage verify --labels verify__01-alpha/)
  for (const t of TOPICS) verified(root, t)
  for (const f of ['FIELD-SPEC', 'VERDICTS', 'FACTS-BANK-a', 'FACTS-BANK-b', 'FACTS-BANK', 'GAPS']) fs.writeFileSync(path.join(root, 'synthesis', f + '.md'), '# ' + f + '\n\nтекст\n')
  fs.writeFileSync(path.join(root, 'METHOD.md'), '# M\n\nтекст\n')
  assert.equal(JSON.parse(run('status.mjs', ['--root', root, '--json']).out).next.stage, 'index')
  assert.equal(run('build-index.mjs', ['--root', root]).code, 0)
  assert.equal(JSON.parse(run('status.mjs', ['--root', root, '--json']).out).next.stage, 'agent-doc')
  const foot = fs.readFileSync(path.join(root, 'INDEX.md'), 'utf8').match(/перегенерируй карту: `node (\S+) --root (\S+)`/)
  assert.ok(foot && fs.existsSync(foot[1]), 'в подвале INDEX — путь к скрипту, который существует')
})

test('своё имя файла GAPS доходит до методики и аудита', () => {
  const root = makeEngine()
  const e = readEngine(root)
  e.syntheses.find(x => x.label === 'gaps').file = 'COMPLETENESS.md'
  fs.writeFileSync(path.join(root, 'engine.json'), JSON.stringify(e))
  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'method']).code, 0)
  assert.match(fs.readFileSync(path.join(root, 'state', 'tasks', 'method__method.md'), 'utf8'), /synthesis\/COMPLETENESS\.md/)
  const fin = audit(root).findings.filter(x => x.code === 'finish-file-missing').map(x => x.message).join(' ')
  assert.match(fin, /COMPLETENESS\.md/)
  assert.doesNotMatch(fin, /GAPS\.md/)
})

test('строковые списки в engine.json читаются как массивы', () => {
  const n = LIB.normalizeEngine({ topics: [{ slug: 'a', feeds: 'x' }], syntheses: [{ label: 'x', primary: 'a' }] })
  assert.deepEqual(n.topics[0].feeds, ['x'])
  assert.deepEqual(n.syntheses[0].primary, ['a'])
})

test('audit: результат агента не по схеме — предупреждение result-schema', () => {
  const root = makeEngine()
  writeReport(root, '01-alpha', '# a\n\nтекст\n')
  const a = audit(root, 'research')
  assert.ok(a.findings.some(x => x.code === 'result-schema' && /research__01-alpha/.test(x.file)), JSON.stringify(a.findings.map(x => x.code)))
})

test('brief.mjs без исходного запроса не предлагает разведку, которая упадёт', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 're-nr-'))
  const root = path.join(dir, 'n-engine')
  assert.equal(run('engine-init.mjs', ['--root', root, '--slug', 'n']).code, 0)
  const b = run('brief.mjs', ['--root', root])
  assert.equal(b.code, 1)
  assert.doesNotMatch(b.out, /--stage recon/)
  assert.match(b.out, /впиши исходный запрос/)
})

test('render-tasks --stage research с полной меткой research__x рендерит и задачу верификатора', () => {
  const root = makeEngine()
  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'research', '--labels', 'research__02-beta']).code, 0)
  assert.deepEqual(tasks(root), ['research__02-beta.md', 'verify__02-beta.md'])
})

test('status: отчёт без результата агента старше двух часов засчитан как написанный, а не «в работе»', () => {
  const root = makeEngine()
  const p = path.join(root, 'reports', '01-alpha.md')
  fs.writeFileSync(p, '# a\n\nручной отчёт\n')
  const old = (Date.now() - 3 * 60 * 60 * 1000) / 1000
  fs.utimesSync(p, old, old)
  const st = JSON.parse(run('status.mjs', ['--root', root, '--json']).out)
  const r = st.topics.find(t => t.slug === '01-alpha')
  assert.equal(r.derived, 'researched')
  assert.equal(r.inProgress, false)
  assert.ok(st.problems.some(x => /больше двух часов/.test(x)))
})

test('команды в ENGINE.md и prompts/README.md экранируют путь с пробелом', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 're-sp-'))
  const root = path.join(dir, 'sp engine')
  assert.equal(run('engine-init.mjs', ['--root', root, '--slug', 'sp']).code, 0)
  const readme = fs.readFileSync(path.join(root, 'prompts', 'README.md'), 'utf8')
  assert.ok(readme.includes("--root '" + root + "'"), readme.slice(0, 300))
  assert.doesNotMatch(readme, /--root \/[^\n']*sp engine/)
})

// ---------------------------------------------------------------- находки ревью диффа

test('подпись верификатора: сырой возврат упавшего прогона и результат старше ресерча — не подпись; берётся последний датированный раздел', () => {
  const root = makeEngine()
  const res = path.join(root, 'state', 'results')
  writeReport(root, '01-alpha', '# a\n\n## Верификация источников\n\nтекст\n')
  fs.writeFileSync(path.join(res, 'verify__01-alpha.raw.json'), JSON.stringify({ is_error: true, result: 'API Error' }))
  writeReport(root, '02-beta', '# b\n\n## Верификация источников\n\nтекст\n')
  fs.writeFileSync(path.join(res, 'verify__02-beta.json'), JSON.stringify({ wordsBefore: 1, wordsAfter: 2 }))
  const old = (Date.now() - 60 * 60 * 1000) / 1000
  fs.utimesSync(path.join(res, 'verify__02-beta.json'), old, old)
  writeReport(root, '03-gamma', '# c\n\n## Верификация источников\n\nтекст\n\n## Верификация (2026-10-15)\n\nпроверено\n')
  const st = JSON.parse(run('status.mjs', ['--root', root, '--json']).out)
  const der = Object.fromEntries(st.topics.map(t => [t.slug, [t.derived, t.verifyLine]]))
  assert.equal(der['01-alpha'][0], 'researched')
  assert.equal(der['02-beta'][0], 'researched')
  assert.deepEqual(der['03-gamma'], ['verified', 7])
})

test('engine-init --force: «Цель» и свои поля брифа сохраняются, списки отчётов пересобираются', () => {
  const root = makeEngine({ brief: { ...FULL_BRIEF, inputs: [{ ref: 'inputs/a.md', kind: 'k', note: 'своё', sha: 'abc' }], sources: { must: ['m'], avoid: ['a'], prefer: ['p'] } } })
  const readme = path.join(root, 'prompts', 'README.md')
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('**`<Работа 1>`.**', '**РАБОТА-МАРКЕР.**'))
  const r = run('engine-init.mjs', ['--root', root, '--title', 'Другое имя', '--force'])
  assert.equal(r.code, 0, r.out + r.err)
  const e = readEngine(root)
  assert.deepEqual(e.brief.inputs[0], { ref: 'inputs/a.md', kind: 'k', note: 'своё', sha: 'abc' })
  assert.deepEqual(e.brief.sources.prefer, ['p'])
  const md = fs.readFileSync(readme, 'utf8')
  assert.match(md, /РАБОТА-МАРКЕР/)
  assert.match(md, /## Отчёты и своды[\s\S]*reports\/01-alpha\.md/)
  assert.equal((md.match(/\*\*Отчёты:\*\*/g) || []).length, 1)
})

test('engine-init: повтор с теми же ответами — код 0; нечитаемый engine.json без --force — код 1; dry-run не обещает бэкапов', () => {
  const root = makeEngine()
  const ans = path.join(path.dirname(root), 'answers.json')
  assert.equal(run('engine-init.mjs', ['--from', ans]).code, 0)
  const dry = run('engine-init.mjs', ['--root', root, '--title', 'Y', '--force', '--dry-run'])
  assert.match(dry.out, /будут сохранены/)
  assert.doesNotMatch(dry.out, /Прежние версии сохранены/)
  fs.writeFileSync(path.join(root, 'engine.json'), '{ broken')
  const bad = run('engine-init.mjs', ['--from', ans])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /не читается/)
})

test('audit: ссылка «файл.md:строка» — битая, если файла нет; ~ в материалах брифа раскрывается', () => {
  const root = makeEngine({ brief: { ...FULL_BRIEF, inputs: [{ ref: '~/client.pdf', kind: 'k' }] } })
  writeReport(root, '01-alpha', '# a\n\n[x](MISSING-SPEC.md:120)\n')
  assert.ok(audit(root, 'research').findings.some(f => f.code === 'broken-link' && /MISSING-SPEC/.test(f.message)))
  assert.equal(run('render-tasks.mjs', ['--root', root, '--stage', 'research', '--labels', '01-alpha'], { HOME: '/home/u' }).code, 0)
  const t = fs.readFileSync(path.join(root, 'state', 'tasks', 'research__01-alpha.md'), 'utf8')
  assert.match(t, /`\/home\/u\/client\.pdf`/)
})

test('Workflow-исполнители: путь с пробелом в командах взят в кавычки; повтор несёт маршрут только упавших', async () => {
  const s = await runWorkflow('synthesis.mjs', { root: '/tmp/my engine', stage: 'synth', labels: ['a', 'b'], models: { a: 'opus', b: 'sonnet' } },
    (o) => (o.label === 'synth__b' ? { path: '' } : undefined))
  assert.match(s.result.next, /--root '\/tmp\/my engine'/)
  assert.match(s.result.next, /"labels":\["b"\],"models":\{"b":"sonnet"\}/)
  const r = await runWorkflow('research.mjs', { root: '/tmp/my engine', labels: ['01-a'] })
  assert.match(r.result.next, /--root '\/tmp\/my engine'/)
})

test('render-tasks: одиночная стадия с готовым файлом не предлагает прогон заново', () => {
  const root = makeEngine()
  fs.writeFileSync(path.join(root, 'METHOD.md'), '# M\n\nтекст\n')
  const r = run('render-tasks.mjs', ['--root', root, '--stage', 'method'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /все задачи стадии method уже сделаны/)
})

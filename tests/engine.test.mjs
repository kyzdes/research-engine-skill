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

const { todayISO } = await import(path.join(SCRIPTS, 'lib', 'engine.mjs'))

function run(name, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, name), ...args], { encoding: 'utf8' })
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
  fs.writeFileSync(path.join(root, 'reports', '01-alpha.md'), '# 01\n\nтекст отчёта\n\n## Верификация (2026-01-02)\n\nпроверено\n')
  fs.writeFileSync(path.join(root, 'reports', '02-beta.md'), '# 02\n\nтекст отчёта без верификации\n')
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
  for (const t of TOPICS) fs.writeFileSync(path.join(root, 'reports', t + '.md'), '# ' + t + '\n\nотчёт\n')
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
async function runWorkflow(file, args) {
  const src = fs.readFileSync(path.join(SKILL, 'workflows', file), 'utf8').replace(/^export const meta/m, 'const meta')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push(opts)
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
  assert.match(result.next, /status\.mjs --root \/tmp\/x-engine --write/)
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
  assert.match(result.next, /status\.mjs --root \/tmp\/x-engine --write/)
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
    { id: 'A1', question: 'Вопрос один?', job: '' }, { id: 'A2', question: 'Вопрос два?', job: '' }])
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

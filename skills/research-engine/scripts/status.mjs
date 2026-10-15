#!/usr/bin/env node
// status.mjs — состояние движка по диску: что собрано, что упало, сколько ещё стоит и какая
// команда следующая. Workflow-исполнители не видят файловой системы и не трогают ни
// engine.json, ни журнал; статусы выводятся из файлов (lib/engine.mjs → diskState) и только
// повышаются. render-tasks.mjs и fanout.mjs сверяют их сами, этот скрипт — ручной вход.
// Node 18+, ESM, без зависимостей.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  die, isDir, isFile, readText, readJson, countWords, fmt, todayISO,
  normalizeEngine, isGaps, synthStageEntries, appendRunLogRow, toolchainDrift, DEFAULT_FINISH,
  briefFindings, workflowArgs, flushAndExit, diskState, upgradeStatuses, writeEngineJson,
  estimateCost, TOPIC_RANK, SYNTH_RANK, STAGES, resolveRoot, shq, takeValue, PREFIX_BY_STAGE, recordRun,
} from './lib/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const script = (name) => shq(path.join(HERE, name))

const USAGE = `status.mjs — состояние движка по файлам на диске, оставшаяся цена и следующая команда.

  node status.mjs --root <path> [--write] [--json] [--batch 4]
  node status.mjs --root <path> --record <stage> --agents N --tokens T [--minutes M]
                  [--labels a,b] [--host claude|codex] [--note "..."]

  --root     каталог движка (в нём лежит engine.json). Обязателен.
  --write    записать выведенные статусы в engine.json и строку об этом в state/run-log.md.
             Статус только повышается (planned → researched → verified, planned → done).
             render-tasks.mjs и fanout.mjs сверяют статусы сами; флаг нужен после Workflow-
             партии, если следующей команды render-tasks пока не будет.
  --record   записать фактический расход партии в engine.json (runs) и строку в журнал:
             стадия, число агентов, токены, минуты. По своим записям движок уточняет
             оценку оставшейся цены вместо замеров по умолчанию.
  --json     машинный вывод вместо таблиц
  --batch    сколько задач предлагать в следующую партию (по умолчанию 4)
  --help     эта справка

Тема researched — на диске есть reports/<slug>.md и агент записал результат research__<slug>;
verified — в отчёте есть раздел «## Верификация», подписанный верификатором (его результат
verify__<slug> или дата в заголовке). Свод done — его файл в synthesis/.`

function parseArgs(argv) {
  const out = { root: '', write: false, json: false, batch: 4, record: '', agents: 0, tokens: 0, minutes: 0, labels: '', host: 'claude', note: '' }
  const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) die(name + ' ждёт неотрицательное число, получено: ' + v); return n }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const [key, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null]
    const val = () => (inline != null ? inline : takeValue(argv, i++, key))
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0) }
    else if (a === '--write') out.write = true
    else if (a === '--json') out.json = true
    else if (key === '--root') out.root = val() || ''
    else if (key === '--batch') out.batch = Number(val())
    else if (key === '--record') out.record = val() || ''
    else if (key === '--agents') out.agents = num(val(), '--agents')
    else if (key === '--tokens') out.tokens = num(val(), '--tokens')
    else if (key === '--minutes') out.minutes = num(val(), '--minutes')
    else if (key === '--labels') out.labels = val() || ''
    else if (key === '--host') out.host = val() || 'claude'
    else if (key === '--note') out.note = val() || ''
    else die('неизвестный аргумент ' + a + '\n\n' + USAGE)
  }
  if (!out.root) die('не задан --root <path>\n\n' + USAGE)
  if (!Number.isInteger(out.batch) || out.batch < 1 || out.batch > 16) die('--batch принимает целое от 1 до 16')
  if (out.record && !STAGES.includes(out.record)) die('--record принимает стадию: ' + STAGES.join(', '))
  if (out.record && !(out.agents > 0)) die('--record требует --agents N (сколько агентов было в партии)')
  out.root = resolveRoot(out.root)
  if (!isDir(out.root)) die('каталог движка не найден: ' + out.root)
  return out
}

const args = parseArgs(process.argv.slice(2))
const ROOT = args.root
const enginePath = path.join(ROOT, 'engine.json')
const raw = readJson(enginePath)
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
  die(isFile(enginePath) ? 'engine.json не читается как JSON-объект: ' + enginePath : 'нет engine.json в ' + ROOT + ' — движок не заведён или указан не тот --root')
}
const { topics, syntheses } = normalizeEngine(raw)
const state = diskState(raw, ROOT)
const { topicRows, synthRows, problems } = state

// ---------------------------------------------------------------- запись партии и статусов

const writeOrDie = () => {
  try { writeEngineJson(ROOT, raw) } catch (e) { die('не удалось записать ' + enginePath + ': ' + e.message, 1) }
}

let recorded = null
if (args.record) {
  try {
    recorded = recordRun(ROOT, {
      stage: args.record, host: args.host, labels: args.labels ? args.labels.split(',').map(s => s.trim()).filter(Boolean) : [],
      agents: args.agents, tokens: args.tokens, minutes: args.minutes, note: args.note,
    })
  } catch (e) { die('не удалось записать ' + enginePath + ': ' + e.message, 1) }
  raw.runs = (readJson(enginePath) || raw).runs
  try {
    appendRunLogRow(ROOT, [recorded.date, recorded.stage, recorded.host, recorded.labels.join(', ') || '—',
      recorded.agents + ' агентов' + (recorded.tokens ? ', ' + fmt(recorded.tokens) + ' токенов' : '') + (recorded.minutes ? ', ' + recorded.minutes + ' мин' : ''),
      recorded.note || 'status.mjs --record'])
  } catch (e) { console.error('Партия записана в engine.json, но строка журнала не дописалась: ' + e.message) }
}

let changes = []
if (args.write) {
  changes = upgradeStatuses(raw, state)
  if (changes.length) {
    writeOrDie()
    try {
      appendRunLogRow(ROOT, [todayISO(), 'status', '—', changes.map(c => c.split(' ')[0]).join(', '),
        'статусов обновлено: ' + changes.length, 'status.mjs --write: ' + changes.join('; ')])
    } catch (e) { console.error('Статусы записаны, но строка в state/run-log.md не дописалась: ' + e.message) }
  }
}

// ---------------------------------------------------------------- финиш, дрейф, цена

const finish = String(raw.finish || DEFAULT_FINISH)
// Порядок финиша: методика, карта сводов (на неё ссылается AGENT.md), вход для агента.
const finishFiles = [['METHOD.md', 'method'], ['INDEX.md', 'index'], ['AGENT.md', 'agent-doc']]
  .map(([name, stage]) => ({ name, stage, words: countWords(readText(path.join(ROOT, name))) }))
const gapsPresent = syntheses.some(isGaps)
  ? synthRows.some(r => r.role === 'critique' && r.words)
  : countWords(readText(path.join(ROOT, 'synthesis', 'GAPS.md'))) > 0

const drift = toolchainDrift(ROOT, path.resolve(HERE, '..'))
if (drift.length) {
  problems.push('копии исполнителей и схем в движке отстают от скилла: ' + drift.map(d => d.rel).join(', ') +
    ' — их обновит render-tasks.mjs перед следующей стадией; запускать Workflow из старой копии нельзя')
}

const cost = estimateCost(raw, state, ROOT)

// ---------------------------------------------------------------- следующий шаг

const R = shq(ROOT)

function nextStep() {
  // то же в Codex: fanout по тем же меткам
  const codex = (stage, labels) => 'Codex: node ' + script('fanout.mjs') + ' --root ' + R + ' --stage ' + stage + ' --labels ' +
    labels.map(l => PREFIX_BY_STAGE[stage] + '__' + l).join(',') + ' --engine codex'
  const render = (stage, labels) => 'node ' + script('render-tasks.mjs') + ' --root ' + R + ' --stage ' + stage +
    (labels ? ' --labels ' + labels.join(',') : '')
  // аргументы исполнителя с маршрутом моделей и усилий из engine.json
  const wf = (file, stage, labels) => 'Workflow ' + path.join(ROOT, 'workflows', file) + ' с args ' + JSON.stringify(workflowArgs(raw, ROOT, stage, labels))

  if (!topics.length) {
    const bf = briefFindings(raw, ROOT)
    if (bf.blockers.length) {
      return { stage: 'brief', text: 'бриф не готов, блокеров ' + bf.blockers.length + ' (первый: ' + bf.blockers[0] + '). Список и следующий шаг: node ' + script('brief.mjs') + ' --root ' + R }
    }
    return { stage: 'plan', text: 'декомпозиция: бриф готов, тем в engine.json нет — покажи BRIEF.md заказчику и /engine plan; каждой теме — topics[].answers' }
  }

  const busy = topicRows.filter(r => r.inProgress).map(r => r.slug)
  const busyNote = busy.length ? ' (в работе, в партию не ставятся: ' + busy.join(', ') + ')' : ''
  const planned = topicRows.filter(r => r.derived === 'planned' && !r.inProgress).map(r => r.slug)
  if (planned.length) {
    const batch = planned.slice(0, args.batch)
    return {
      stage: 'research', labels: batch,
      text: 'ресерч, партия ' + batch.length + ' из ' + planned.length + ' непрогнанных тем' + busyNote + ':\n    ' +
        render('research', batch) + '\n    ' + wf('research.mjs', 'research', batch) +
        '\n    ' + codex('research', batch) + ' (верификатор следом сам)',
    }
  }
  if (busy.length) return { stage: 'wait', labels: busy, text: 'дождись партии: отчёты ещё пишутся — ' + busy.join(', ') }
  const unverified = topicRows.filter(r => r.derived === 'researched').map(r => r.slug)
  if (unverified.length) {
    const batch = unverified.slice(0, args.batch)
    return {
      stage: 'verify', labels: batch,
      text: 'верификация без повторного ресерча, ' + batch.length + ' из ' + unverified.length + ':\n    ' +
        render('verify', batch) + '\n    ' + wf('research.mjs', 'verify', batch) + '\n    ' + codex('verify', batch),
    }
  }
  const synthTodo = synthStageEntries(syntheses).map(s => synthRows.find(r => r.label === String(s.label)))
    .filter(r => r && r.derived !== 'done').map(r => r.label)
  if (synthTodo.length) {
    const batch = synthTodo.slice(0, args.batch)
    return {
      stage: 'synth', labels: batch,
      text: 'своды, партия ' + batch.length + ' из ' + synthTodo.length + ':\n    ' +
        render('synth', batch) + '\n    ' + wf('synthesis.mjs', 'synth', batch) + '\n    ' + codex('synth', batch),
    }
  }
  const nav = synthRows.find(r => r.role === 'merge')
  if (nav && nav.derived !== 'done') {
    return { stage: 'merge', labels: ['facts-bank'], text: 'навигатор банка фактов:\n    ' + render('merge') + '\n    ' + wf('synthesis.mjs', 'merge', ['facts-bank']) + '\n    ' + codex('merge', ['facts-bank']) }
  }
  if (!gapsPresent) {
    return { stage: 'critique', labels: ['gaps'], text: 'критик полноты:\n    ' + render('critique') + '\n    ' + wf('synthesis.mjs', 'critique', ['gaps']) + '\n    ' + codex('critique', ['gaps']) }
  }
  if (finish === 'base') {
    return { stage: 'done', text: 'финиш base: конвейер доведён до GAPS.md. Прочитай его с пользователем и прогони node ' + script('audit.mjs') + ' --root ' + R }
  }
  for (const f of finishFiles) {
    if (f.words) continue
    if (f.stage === 'index') return { stage: 'index', text: 'карта сводов (на неё ссылается AGENT.md): node ' + script('build-index.mjs') + ' --root ' + R }
    const label = f.stage === 'method' ? 'method' : 'agent'
    return { stage: f.stage, labels: [label], text: f.name + ':\n    ' + render(f.stage) + '\n    ' + wf('synthesis.mjs', f.stage, [label]) + '\n    ' + codex(f.stage, [label]) }
  }
  return { stage: 'done', text: 'все файлы на месте. Пересобери карту после финиша (node ' + script('build-index.mjs') + ' --root ' + R + ') и финальная проверка: node ' + script('audit.mjs') + ' --root ' + R + ', затем чек-лист сдачи из SKILL.md' }
}

const next = nextStep()

// ---------------------------------------------------------------- вывод

if (args.json) {
  console.log(JSON.stringify({
    root: ROOT, finish, topics: topicRows, syntheses: synthRows,
    finishFiles: finishFiles.map(f => ({ name: f.name, present: f.words > 0 })),
    problems, changes, written: args.write, recorded, cost, next,
  }, null, 2))
  await flushAndExit(0)
}

const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length) }
const table = (head, rows) => {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)))
  const line = (cells) => ('  ' + cells.map((c, i) => pad(c, w[i])).join('  ')).replace(/\s+$/, '')
  console.log(line(head))
  for (const r of rows) console.log(line(r))
}
const mark = (rec, der) => (rec === der ? der : rec + ' → ' + der)
const mln = (n) => (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' млн'

console.log('# Состояние движка «' + (raw.title || raw.slug || path.basename(ROOT)) + '»')
console.log(ROOT + ' · профиль ' + (raw.profile || '?') + ' · финиш ' + finish)
console.log('')
console.log('Темы: verified ' + topicRows.filter(r => r.derived === 'verified').length + ' из ' + topicRows.length)
if (topicRows.length) {
  table(['тема', 'статус (engine.json → диск)', 'слов', 'верификация'],
    topicRows.map(r => [r.slug, r.inProgress ? 'в работе' : mark(r.recorded, r.derived), r.words ? fmt(r.words) : '—', r.verifyLine ? 'строка ' + r.verifyLine : '—']))
}
console.log('')
console.log('Своды: done ' + synthRows.filter(r => r.derived === 'done').length + ' из ' + synthRows.length)
if (synthRows.length) {
  table(['свод', 'файл', 'стадия', 'статус (engine.json → диск)', 'слов'],
    synthRows.map(r => [r.label, r.file, r.role, mark(r.recorded, r.derived), r.words ? fmt(r.words) : '—']))
}
if (finish === 'method') {
  console.log('')
  console.log('Финиш: ' + finishFiles.map(f => f.name + (f.words ? ' есть' : ' нет')).join(' · '))
}
if (cost.agents) {
  console.log('')
  console.log('Осталось: ~' + cost.agents + ' агентов, ~' + mln(cost.tokens) + ' токенов')
  table(['ключ маршрута', 'агентов', 'на агента', 'основание'], cost.rows.map(r => [r.key, r.agents, mln(r.perAgent), r.basis]))
}
if (problems.length) {
  console.log('')
  console.log('Расхождения:')
  for (const p of problems) console.log('  · ' + p)
}
console.log('')
if (recorded) console.log('Партия записана в engine.json (runs) и журнал: ' + recorded.stage + ', ' + recorded.agents + ' агентов' + (recorded.tokens ? ', ' + fmt(recorded.tokens) + ' токенов' : '') + '.')
if (args.write) {
  console.log(changes.length
    ? 'Записано в engine.json: ' + changes.join(', ') + '. Строка добавлена в state/run-log.md.'
    : 'engine.json уже совпадает с диском — записывать нечего.')
} else {
  const pending = topicRows.filter(r => TOPIC_RANK[r.derived] > TOPIC_RANK[r.recorded]).length +
    synthRows.filter(r => SYNTH_RANK[r.derived] > SYNTH_RANK[r.recorded]).length
  if (pending) console.log('Статусов отстаёт от диска: ' + pending + '. Записать: node ' + script('status.mjs') + ' --root ' + R + ' --write (или любой следующий render-tasks.mjs)')
}
console.log('Дальше — ' + next.text)

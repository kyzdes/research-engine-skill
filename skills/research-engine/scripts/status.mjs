#!/usr/bin/env node
// status.mjs — состояние движка по диску: что собрано, что упало, какая команда следующая.
// Workflow-исполнители не видят файловой системы и не трогают ни engine.json, ни журнал;
// без этого скрипта статусы тем остаются planned, а audit.mjs молчит там, где должен
// ставить блокер (так застрял движок product-discovery: три темы собраны, в engine.json — planned).
// Node 18+, ESM, без зависимостей.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  die, isDir, isFile, readText, readJson, countWords, fmt, todayISO,
  normalizeEngine, synthFileName, isGaps, bankLayout, synthStageEntries, findVerificationHeading,
  appendRunLogRow, toolchainDrift, DEFAULT_FINISH, briefFindings, workflowArgs,
} from './lib/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const script = (name) => path.join(HERE, name)

const USAGE = `status.mjs — состояние движка по файлам на диске и следующая команда.

  node status.mjs --root <path> [--write] [--json] [--batch 4]

  --root    каталог движка (в нём лежит engine.json). Обязателен.
  --write   записать выведенные статусы в engine.json и строку об этом в state/run-log.md.
            Статус только повышается (planned → researched → verified, planned → done):
            понижение спрятало бы потерянный файл от audit.mjs, который как раз ловит
            «статус есть, файла нет».
  --json    машинный вывод вместо таблиц
  --batch   сколько задач предлагать в следующую партию (по умолчанию 4)
  --help    эта справка

Тема researched — на диске есть reports/<slug>.md. Тема verified — в отчёте есть раздел
«## Верификация». Свод done — на диске есть его файл в synthesis/.`

function parseArgs(argv) {
  const out = { root: '', write: false, json: false, batch: 4 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0) }
    else if (a === '--write') out.write = true
    else if (a === '--json') out.json = true
    else if (a === '--root') out.root = argv[++i] || ''
    else if (a.startsWith('--root=')) out.root = a.slice('--root='.length)
    else if (a === '--batch') out.batch = Number(argv[++i])
    else if (a.startsWith('--batch=')) out.batch = Number(a.slice('--batch='.length))
    else die('неизвестный аргумент ' + a + '\n\n' + USAGE)
  }
  if (!out.root) die('не задан --root <path>\n\n' + USAGE)
  if (!Number.isInteger(out.batch) || out.batch < 1 || out.batch > 16) die('--batch принимает целое от 1 до 16')
  out.root = path.resolve(out.root)
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
const { entry: bankEntry, parts: bankParts } = bankLayout(syntheses)

const resultFile = (label) => path.join(ROOT, 'state', 'results', label + '.json')
const taskFile = (label) => path.join(ROOT, 'state', 'tasks', label + '.md')

const TOPIC_RANK = { planned: 0, researched: 1, verified: 2 }
const SYNTH_RANK = { planned: 0, done: 1 }

// ---------------------------------------------------------------- темы

const problems = []

const topicRows = topics.map(t => {
  const slug = String(t.slug)
  const text = readText(path.join(ROOT, 'reports', slug + '.md'))
  const words = countWords(text)
  const verifyHead = words ? findVerificationHeading(text) : null
  const derived = verifyHead ? 'verified' : words ? 'researched' : 'planned'
  const recorded = Object.prototype.hasOwnProperty.call(TOPIC_RANK, t.status) ? t.status : 'planned'

  if (TOPIC_RANK[recorded] > TOPIC_RANK[derived]) {
    problems.push(slug + ': в engine.json «' + recorded + '», а на диске ' +
      (words ? 'нет раздела «## Верификация»' : 'нет отчёта') + ' — файл потерян или записан не туда (audit.mjs покажет блокер)')
  }
  if (!words && isFile(resultFile('research__' + slug))) {
    problems.push(slug + ': результат research__' + slug + '.json есть, а отчёта нет — агент вернул путь, но файл не записан')
  }
  if (words && !verifyHead && isFile(resultFile('verify__' + slug))) {
    problems.push(slug + ': верификатор отчитался, а раздела «## Верификация» в отчёте нет — достройка не доехала до файла')
  }
  return {
    slug, recorded, derived, words,
    verifyLine: verifyHead ? verifyHead.line : 0,
    rendered: isFile(taskFile('research__' + slug)),
  }
})

// ---------------------------------------------------------------- своды и финиш

const synthRows = syntheses.map(s => {
  const file = synthFileName(s)
  const words = countWords(readText(path.join(ROOT, 'synthesis', file)))
  const derived = words ? 'done' : 'planned'
  const recorded = s.status === 'done' ? 'done' : 'planned'
  if (recorded === 'done' && !words) {
    problems.push(s.label + ': в engine.json done, а файла synthesis/' + file + ' нет (audit.mjs покажет блокер)')
  }
  const role = isGaps(s) ? 'critique' : (bankParts.length && s === bankEntry) ? 'merge' : 'synth'
  return { label: String(s.label), file, role, recorded, derived, words }
})

const finish = String(raw.finish || DEFAULT_FINISH)
const finishFiles = [['METHOD.md', 'method'], ['AGENT.md', 'agent-doc'], ['INDEX.md', 'index']]
  .map(([name, stage]) => ({ name, stage, words: countWords(readText(path.join(ROOT, name))) }))
const gapsPresent = syntheses.some(isGaps)
  ? synthRows.some(r => r.role === 'critique' && r.words)
  : countWords(readText(path.join(ROOT, 'synthesis', 'GAPS.md'))) > 0

const drift = toolchainDrift(ROOT, path.resolve(HERE, '..'))
if (drift.length) {
  problems.push('копии исполнителей и схем в движке отстают от скилла: ' + drift.map(d => d.rel).join(', ') +
    ' — их обновит render-tasks.mjs перед следующей стадией; запускать Workflow из старой копии нельзя')
}

// ---------------------------------------------------------------- следующий шаг

function nextStep() {
  const render = (stage, labels) => 'node ' + script('render-tasks.mjs') + ' --root ' + ROOT + ' --stage ' + stage +
    (labels ? ' --labels ' + labels.join(',') : '')
  // аргументы исполнителя с маршрутом моделей и усилий из engine.json
  const wf = (file, stage, labels) => 'Workflow ' + path.join(ROOT, 'workflows', file) + ' с args ' + JSON.stringify(workflowArgs(raw, ROOT, stage, labels))

  if (!topics.length) {
    const bf = briefFindings(raw, ROOT)
    if (bf.blockers.length) {
      return { stage: 'brief', text: 'бриф не готов, блокеров ' + bf.blockers.length + ' (первый: ' + bf.blockers[0] + '). Список и следующий шаг: node ' + script('brief.mjs') + ' --root ' + ROOT }
    }
    return { stage: 'plan', text: 'декомпозиция: бриф готов, тем в engine.json нет — покажи BRIEF.md заказчику и /engine plan; каждой теме — topics[].answers' }
  }

  const planned = topicRows.filter(r => r.derived === 'planned').map(r => r.slug)
  if (planned.length) {
    const batch = planned.slice(0, args.batch)
    return {
      stage: 'research', labels: batch,
      text: 'ресерч, партия ' + batch.length + ' из ' + planned.length + ' непрогнанных тем:\n    ' +
        render('research', batch) + '\n    ' + wf('research.mjs', 'research', batch),
    }
  }
  const unverified = topicRows.filter(r => r.derived === 'researched').map(r => r.slug)
  if (unverified.length) {
    const batch = unverified.slice(0, args.batch)
    return {
      stage: 'verify', labels: batch,
      text: 'верификация без повторного ресерча, ' + batch.length + ' из ' + unverified.length + ':\n    ' +
        render('verify', batch) + '\n    ' + wf('research.mjs', 'verify', batch),
    }
  }
  const synthTodo = synthStageEntries(syntheses).map(s => synthRows.find(r => r.label === String(s.label)))
    .filter(r => r && r.derived !== 'done').map(r => r.label)
  if (synthTodo.length) {
    const batch = synthTodo.slice(0, args.batch)
    return {
      stage: 'synth', labels: batch,
      text: 'своды, партия ' + batch.length + ' из ' + synthTodo.length + ':\n    ' +
        render('synth', batch) + '\n    ' + wf('synthesis.mjs', 'synth', batch),
    }
  }
  const nav = synthRows.find(r => r.role === 'merge')
  if (nav && nav.derived !== 'done') {
    return { stage: 'merge', labels: ['facts-bank'], text: 'навигатор банка фактов:\n    ' + render('merge') + '\n    ' + wf('synthesis.mjs', 'merge', ['facts-bank']) }
  }
  if (!gapsPresent) {
    return { stage: 'critique', labels: ['gaps'], text: 'критик полноты:\n    ' + render('critique') + '\n    ' + wf('synthesis.mjs', 'critique', ['gaps']) }
  }
  if (finish === 'base') {
    return { stage: 'done', text: 'финиш base: конвейер доведён до GAPS.md. Прочитай его с пользователем и прогони node ' + script('audit.mjs') + ' --root ' + ROOT }
  }
  for (const f of finishFiles) {
    if (f.words) continue
    if (f.stage === 'index') return { stage: 'index', text: 'карта сводов: node ' + script('build-index.mjs') + ' --root ' + ROOT }
    const label = f.stage === 'method' ? 'method' : 'agent'
    return { stage: f.stage, labels: [label], text: f.name + ':\n    ' + render(f.stage) + '\n    ' + wf('synthesis.mjs', f.stage, [label]) }
  }
  return { stage: 'done', text: 'все файлы на месте. Финальная проверка: node ' + script('audit.mjs') + ' --root ' + ROOT + ', затем чек-лист сдачи из SKILL.md' }
}

const next = nextStep()

// ---------------------------------------------------------------- запись

const changes = []
if (args.write) {
  const rawTopics = Array.isArray(raw.topics) ? raw.topics : []
  for (const r of topicRows) {
    const t = rawTopics.find(x => x && String(x.slug) === r.slug)
    if (t && TOPIC_RANK[r.derived] > TOPIC_RANK[r.recorded]) { changes.push(r.slug + ' ' + r.recorded + '→' + r.derived); t.status = r.derived }
  }
  const rawSynth = Array.isArray(raw.syntheses) ? raw.syntheses : []
  for (const r of synthRows) {
    const s = rawSynth.find(x => x && String(x.label || path.basename(String(x.file || ''), '.md').toLowerCase()) === r.label)
    if (s && SYNTH_RANK[r.derived] > SYNTH_RANK[r.recorded]) { changes.push(r.label + ' ' + r.recorded + '→' + r.derived); s.status = r.derived }
  }
  if (changes.length) {
    // запись через временный файл: оборванная запись не должна оставить битый engine.json
    const tmp = enginePath + '.tmp-' + process.pid
    try {
      fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8')
      fs.renameSync(tmp, enginePath)
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* нечего убирать */ }
      die('не удалось записать ' + enginePath + ': ' + e.message, 1)
    }
    try {
      appendRunLogRow(ROOT, [todayISO(), 'status', '—', changes.map(c => c.split(' ')[0]).join(', '),
        'статусов обновлено: ' + changes.length, 'status.mjs --write: ' + changes.join('; ')])
    } catch (e) {
      console.error('Статусы записаны, но строка в state/run-log.md не дописалась: ' + e.message)
    }
  }
  for (const r of topicRows) if (TOPIC_RANK[r.derived] > TOPIC_RANK[r.recorded]) r.recorded = r.derived
  for (const r of synthRows) if (SYNTH_RANK[r.derived] > SYNTH_RANK[r.recorded]) r.recorded = r.derived
}

// ---------------------------------------------------------------- вывод

if (args.json) {
  console.log(JSON.stringify({
    root: ROOT, finish, topics: topicRows, syntheses: synthRows,
    finishFiles: finishFiles.map(f => ({ name: f.name, present: f.words > 0 })),
    problems, changes, written: args.write, next,
  }, null, 2))
  process.exit(0)
}

const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length) }
const table = (head, rows) => {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)))
  const line = (cells) => ('  ' + cells.map((c, i) => pad(c, w[i])).join('  ')).replace(/\s+$/, '')
  console.log(line(head))
  for (const r of rows) console.log(line(r))
}
const mark = (recorded, derived) => (recorded === derived ? derived : recorded + ' → ' + derived)

console.log('# Состояние движка «' + (raw.title || raw.slug || path.basename(ROOT)) + '»')
console.log(ROOT + ' · профиль ' + (raw.profile || '?') + ' · финиш ' + finish)
console.log('')
const done = topicRows.filter(r => r.derived === 'verified').length
console.log('Темы: verified ' + done + ' из ' + topicRows.length)
if (topicRows.length) {
  table(['тема', 'статус (engine.json → диск)', 'слов', 'верификация'],
    topicRows.map(r => [r.slug, mark(r.recorded, r.derived), r.words ? fmt(r.words) : '—', r.verifyLine ? 'строка ' + r.verifyLine : '—']))
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
if (problems.length) {
  console.log('')
  console.log('Расхождения:')
  for (const p of problems) console.log('  · ' + p)
}
console.log('')
if (args.write) {
  console.log(changes.length
    ? 'Записано в engine.json: ' + changes.join(', ') + '. Строка добавлена в state/run-log.md.'
    : 'engine.json уже совпадает с диском — записывать нечего.')
} else {
  const pending = topicRows.filter(r => r.recorded !== r.derived && TOPIC_RANK[r.derived] > TOPIC_RANK[r.recorded]).length +
    synthRows.filter(r => r.recorded !== r.derived && SYNTH_RANK[r.derived] > SYNTH_RANK[r.recorded]).length
  if (pending) console.log('Статусов отстаёт от диска: ' + pending + '. Записать: node ' + script('status.mjs') + ' --root ' + ROOT + ' --write')
}
console.log('Дальше — ' + next.text)

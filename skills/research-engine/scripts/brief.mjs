#!/usr/bin/env node
// brief.mjs — проверка и сборка брифа движка: готов ли бриф к декомпозиции, какие контрольные
// вопросы закрыты темами, BRIEF.md из engine.json. Методика стадии — references/BRIEF.md.
// Node 18+, ESM, без зависимостей.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  die, isDir, isFile, readJson, normalizeEngine, briefFindings, acceptanceCoverage, renderBriefMd, workflowArgs,
  flushAndExit, resolveRoot, takeValue, shq, pinAcceptanceIds, writeEngineJson,
} from './lib/engine.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const script = (name) => shq(path.join(HERE, name))

const USAGE = `brief.mjs — готов ли бриф движка и на какие контрольные вопросы уже назначены темы.

  node brief.mjs --root <path> [--write] [--json]

  --root    каталог движка (в нём лежит engine.json). Обязателен.
  --write   собрать BRIEF.md из engine.json и закрепить в engine.json id контрольных
            вопросов, выданные по порядку (A1, A2…): иначе перестановка вопросов сдвинет
            ссылки topics[].answers.
  --json    машинный вывод
  --help    эта справка

Код возврата 1, если у брифа есть блокеры: декомпозицию по такому брифу не начинают.`

function parseArgs(argv) {
  const out = { root: '', write: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0) }
    else if (a === '--write') out.write = true
    else if (a === '--json') out.json = true
    else if (a === '--root') out.root = takeValue(argv, i++, a)
    else if (a.startsWith('--root=')) out.root = a.slice('--root='.length)
    else die('неизвестный аргумент ' + a + '\n\n' + USAGE)
  }
  if (!out.root) die('не задан --root <path>\n\n' + USAGE)
  out.root = resolveRoot(out.root)
  if (!isDir(out.root)) die('каталог движка не найден: ' + out.root)
  return out
}

const args = parseArgs(process.argv.slice(2))
const ROOT = args.root
const R = shq(ROOT)
const enginePath = path.join(ROOT, 'engine.json')
const raw = readJson(enginePath)
if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
  die(isFile(enginePath) ? 'engine.json не читается как JSON-объект: ' + enginePath
    : 'нет engine.json в ' + ROOT + ' — заведи движок: node ' + script('engine-init.mjs') + ' --root ' + R + ' --slug <slug> --request "<запрос>"')
}

const { topics } = normalizeEngine(raw)
const { brief, blockers, warnings } = briefFindings(raw, ROOT)
const cov = acceptanceCoverage(brief, topics)
if (topics.length) {
  for (const id of cov.uncovered) warnings.push('контрольный вопрос ' + id + ' не закрыт ни одной темой — добавь его в topics[].answers нужной темы или заведи тему')
  for (const u of cov.unknown) warnings.push('тема ' + u.topic + ' ссылается на контрольный вопрос ' + u.id + ', которого нет в брифе')
}

// ---------------------------------------------------------------- запись

const written = []
if (args.write) {
  // id, выданные по порядку, закрепляются в engine.json: ссылки topics[].answers не должны съехать.
  // Остальные поля вопроса (priority, source…) сохраняются.
  if (brief.acceptance.some(a => a.autoId) && raw.brief && Array.isArray(raw.brief.acceptance)) {
    raw.brief.acceptance = pinAcceptanceIds(raw.brief.acceptance, brief.acceptance)
    try {
      writeEngineJson(ROOT, raw)
      written.push('engine.json (id контрольных вопросов закреплены)')
    } catch (e) {
      die('не удалось записать ' + enginePath + ': ' + e.message, 1)
    }
  }
  try {
    fs.writeFileSync(path.join(ROOT, 'BRIEF.md'), renderBriefMd(raw, ROOT, topics), 'utf8')
    written.push('BRIEF.md')
  } catch (e) {
    die('не удалось записать BRIEF.md: ' + e.message, 1)
  }
}

// ---------------------------------------------------------------- следующий шаг

const recon = isFile(path.join(ROOT, 'brief', 'RECON.md'))
let next
if (blockers.length) {
  // разведке нужен исходный запрос: без него render-tasks --stage recon падает
  const reconHint = recon ? ''
    : !(brief.request || brief.restated) ? '; для разведки предмета сначала впиши исходный запрос в brief.request'
    : '; разведка предмета до второго круга вопросов: node ' + script('render-tasks.mjs') + ' --root ' + R +
      ' --stage recon и Workflow ' + path.join(ROOT, 'workflows', 'synthesis.mjs') + ' с args ' + JSON.stringify(workflowArgs(raw, ROOT, 'recon', ['field']))
  next = 'закрой блокеры с заказчиком: вопросы о работе базы — references/BRIEF.md §3' + reconHint +
    '; затем node ' + script('brief.mjs') + ' --root ' + R + ' --write'
} else if (!topics.length) {
  next = 'покажи BRIEF.md заказчику и дождись утверждения (точка останова), затем декомпозиция: каждая тема получает topics[].answers — id контрольных вопросов, ради которых она заведена'
} else if (cov.uncovered.length) {
  next = 'декомпозиция не закрывает контрольные вопросы ' + cov.uncovered.join(', ') + ' — допиши темы или их answers до прогона ресерча'
} else {
  next = 'бриф и карта тем согласованы: node ' + script('render-tasks.mjs') + ' --root ' + R + ' --stage research'
}

// ---------------------------------------------------------------- вывод

if (args.json) {
  console.log(JSON.stringify({
    root: ROOT, ok: blockers.length === 0, blockers, warnings,
    acceptance: brief.acceptance.map(a => ({ id: a.id, question: a.question, job: a.job, topics: cov.map[a.id] })),
    recon, written, next,
  }, null, 2))
  await flushAndExit(blockers.length ? 1 : 0)
}

console.log('# Бриф движка «' + (raw.title || raw.slug || path.basename(ROOT)) + '»')
console.log(ROOT)
console.log('')
console.log('Запрос: ' + (brief.request ? '«' + brief.request.replace(/\s+/g, ' ').slice(0, 160) + (brief.request.length > 160 ? '…' : '') + '»' : '— нет'))
console.log('Работ: ' + brief.jobs.length + ' · контрольных вопросов: ' + brief.acceptance.length + ' · материалов заказчика: ' + brief.inputs.length +
  ' · разведка: ' + (recon ? 'brief/RECON.md есть' : 'нет'))
if (brief.acceptance.length) {
  console.log('')
  console.log('Контрольные вопросы → темы:')
  for (const a of brief.acceptance) {
    const t = cov.map[a.id]
    console.log('  ' + a.id + '  ' + (t.length ? t.join(', ') : topics.length ? '— НЕ ЗАКРЫТ' : '—') + '  · ' + a.question.replace(/\s+/g, ' ').slice(0, 110))
  }
}
if (blockers.length) {
  console.log('')
  console.log('Блокеры (декомпозицию по такому брифу не начинают):')
  for (const b of blockers) console.log('  ✘ ' + b)
}
if (warnings.length) {
  console.log('')
  console.log('Предупреждения:')
  for (const w of warnings) console.log('  · ' + w)
}
if (written.length) {
  console.log('')
  console.log('Записано: ' + written.join(', '))
}
console.log('')
console.log('Дальше — ' + next)
await flushAndExit(blockers.length ? 1 : 0)

#!/usr/bin/env node
// audit.mjs — машинная проверка закона конвейера движка research-engine.
// Node 18+, ESM, без зависимостей. Ни одна проверка не падает на отсутствующем файле:
// пишется «нет файла», а не стектрейс.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  die, isDir, isFile, readText, readJson, countWords, fmt, plural, wordsRu,
  codeFenceMask, maskInlineCode, headings, verificationOf,
  normalizeEngine, synthFileName, isGaps, isBankNav, bankLayout, DEFAULT_FINISH,
  normalizeBrief, acceptanceCoverage, flushAndExit, resolveRoot, takeValue, matrixFindings,
  gapsRelPath, schemaProblems, agentResult,
} from './lib/engine.mjs'

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const USAGE = `audit.mjs — проверка закона конвейера: ни один шаг не сжимает содержание.

  node audit.mjs --root <path> [--stage all|prompts|research|synthesis] [--json] [--all]

  --root    каталог движка (в нём лежит engine.json). Обязателен.
  --stage   что проверять: all (по умолчанию) | prompts | research | synthesis
  --json    машинный вывод вместо читаемого отчёта
  --all     все находки по следам сжатия и числам без источника, без лимита 8 на файл
  --help    эта справка

Блокеры (код возврата 1):
  no-engine-json       нет engine.json или он не читается
  no-report            тема прогонялась (статус, результат агента), а отчёта нет или он пуст
  no-verification      верификация числится (статус verified, результат verify__), а раздела
                       «## Верификация», подписанного верификатором, в отчёте нет
  no-growth            отчёт после верификации не вырос (wordsAfter ≤ wordsBefore)
  synthesis-too-short  свод короче четверти суммарного объёма своих primary-отчётов
  no-synthesis-file    свод (или GAPS.md) помечен done, а файла нет или он пуст
  broken-link          битая внутренняя ссылка в markdown

Предупреждения (код возврата 0):
  бриф и карта тем     no-brief, no-acceptance, acceptance-uncovered, acceptance-unknown,
                       matrix (расхождения feeds/primary, метки, дубли файлов),
                       topic-feeds-nothing, synthesis-without-primary, no-synthesis-spec,
                       no-prompts-readme, no-prompt, thin-prompt, no-questions-section,
                       no-topics, no-syntheses
  отчёты               report-planned, verification-pending, no-words-numbers, words-drift,
                       question-uncovered (эвристика по опорным словам)
  текст                compression[-more] («и т.д.», «см. выше», «аналогично», «…» вне цитат,
                       URL и кода), number-without-source[-more] (число без даты или URL
                       в окне ±3 строки; реквизиты, расчёты и строки банка с источником
                       не в счёт)
  своды и финиш        synthesis-planned, primary-report-missing, finish-file-missing
  результаты агентов   result-schema (state/results/<label>.json не по схеме стадии)`

const SECTIONS = ['Каркас', 'ТЗ и карта тем', 'Отчёты', 'Своды', 'Ссылки']

const MARKERS = [
  'и т.д.', 'и т. д.', 'и т.п.', 'и т. п.', 'и так далее', 'и прочее', 'и пр.',
  'см. выше', 'см. ниже', 'смотри выше', 'аналогично', 'и другие', 'и другое',
  'для краткости', 'примеры строк', 'сокращено', 'опущено', 'etc.', '…', '...',
]

const STOP = new Set([
  'который', 'которые', 'которых', 'каждый', 'каждое', 'каждой', 'полный', 'полная',
  'точный', 'точная', 'точные', 'такой', 'также', 'нужно', 'нужен', 'сколько', 'какие',
  'какой', 'какая', 'когда', 'через', 'между', 'после', 'перед', 'только', 'можно',
  'должен', 'должна', 'должно', 'этого', 'этому', 'более', 'менее', 'всего', 'вопрос',
  'вопросы', 'ресерч', 'ресерча', 'отчёт', 'отчёта', 'отчёте', 'отчет', 'таблица',
  'таблицу', 'таблице', 'источник', 'источники', 'источников', 'данные', 'данных',
  'пример', 'примеры', 'пункт', 'пункты', 'список', 'списка', 'формат', 'правило',
  'правила', 'чтобы', 'быть', 'есть', 'было', 'будет', 'работает', 'работы',
])

const MONTHS = /(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/i

// ---------------------------------------------------------------- аргументы

function parseArgs(argv) {
  const out = { root: '', stage: 'all', json: false, all: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0) }
    else if (a === '--root') out.root = takeValue(argv, i++, a)
    else if (a.startsWith('--root=')) out.root = a.slice('--root='.length)
    else if (a === '--stage') out.stage = takeValue(argv, i++, a)
    else if (a.startsWith('--stage=')) out.stage = a.slice('--stage='.length)
    else if (a === '--json') out.json = true
    else if (a === '--all') out.all = true
    else die('неизвестный аргумент ' + a + '\n\n' + USAGE)
  }
  if (!out.root) die('не задан --root <path>\n\n' + USAGE)
  if (!['all', 'prompts', 'research', 'synthesis'].includes(out.stage)) {
    die('--stage принимает all | prompts | research | synthesis, получено: ' + out.stage)
  }
  out.root = resolveRoot(out.root)
  if (!isDir(out.root)) die('каталог движка не найден: ' + out.root)
  return out
}

// ---------------------------------------------------------------- файлы

function listMd(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort() } catch { return [] }
}

// ---------------------------------------------------------------- находки

const findings = []
const notes = []
let ROOT = ''

const rel = (p) => (p && p.startsWith(ROOT) ? path.relative(ROOT, p) || '.' : p || '')

const seenFindings = new Set()

function push(level, section, file, line, code, message) {
  const f = { level, section, file: rel(file), line: line || 0, code, message }
  const key = level + '|' + f.file + '|' + f.line + '|' + code + '|' + message
  if (seenFindings.has(key)) return // одна и та же находка из двух стадий печатается один раз
  seenFindings.add(key)
  findings.push(f)
}

function blocker(section, file, line, code, message) { push('blocker', section, file, line, code, message) }
function warn(section, file, line, code, message) { push('warn', section, file, line, code, message) }
function note(section, message) { notes.push({ section, message }) }

// ---------------------------------------------------------------- разбор md

// вопросы ТЗ: нумерованные пункты раздела «Вопросы ресерча»
function extractQuestions(promptText) {
  const lines = promptText.split('\n')
  const mask = codeFenceMask(lines)
  const items = []
  let inside = false
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (h) { inside = /вопрос/i.test(h[2]); continue }
    if (!inside) continue
    const m = /^\s*(\d{1,2})[.)]\s+(.*)$/.exec(lines[i])
    if (m) items.push({ n: Number(m[1]), line: i + 1, text: m[2] })
    else if (items.length && lines[i].trim() && !/^\s*[-*|]/.test(lines[i])) {
      items[items.length - 1].text += ' ' + lines[i].trim()
    }
  }
  return items
}

const stem = (w) => w.slice(0, 6)

function keywordsOf(text) {
  const clean = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`_>#]/g, ' ')
    .toLowerCase()
  const words = clean.match(/[a-zа-яё][a-zа-яё0-9-]{4,}/gu) || []
  const seen = new Set()
  const out = []
  for (const w of words) {
    if (STOP.has(w)) continue
    const s = stem(w)
    if (seen.has(s)) continue
    seen.add(s)
    out.push({ word: w, stem: s })
    if (out.length >= 10) break
  }
  return out
}

// Не факты, а реквизиты: даты, идентификаторы препринтов, версии ПО, номера разделов, URL.
// Живой прогон показал, что именно они давали большую часть находок number-without-source:
// дата «14.10.2026» читалась как десятичное 14.10, arXiv 2602.23234 — как число.
const NON_FACTS = [
  /https?:\/\/\S+/g,
  /\]\([^)\s]+\)/g,
  /\b\d{4}-\d{2}-\d{2}(?:[–-]\d{2})?\b/g,
  /\b\d{1,2}(?:[–-]\d{1,2})?\.\d{1,2}\.\d{2,4}\b/g,
  /\b(?:arxiv[:\s]*)?\d{4}\.\d{4,5}(?:v\d+)?\b/gi,
  /\b(?:ios|ipados|macos|watchos|visionos|sdk|xcode|swift|api|v)\s?\d+(?:\.\d+)*\b/gi,
  /(?:§|раздел\p{L}*\s|разд\.\s?|п\.\s?|пункт\p{L}*\s|guideline\s|guidelines\s)\d+(?:\.\d+)*(?:\.[a-z])?/giu,
  /`[^`]*`/g,
  /\b\d+\.\d+\.\d+(?:\.\d+)*(?:\([a-z]\))?/g, // номер пункта правил или версии: 2.3.1(a), 5.6.3
]

const stripNonFacts = (line) => NON_FACTS.reduce((s, re) => s.replace(re, ' '), line)

function significantNumbers(line) {
  const out = []
  const re = /\d+(?:[.,]\d+)?\s?%|\d+[.,]\d+|\d{3,}/g
  const clean = stripNonFacts(line)
  let m
  while ((m = re.exec(clean))) {
    const s = m[0]
    if (/^\d{4}$/.test(s) && Number(s) >= 1900 && Number(s) <= 2100) continue
    out.push(s)
  }
  return out
}

const hasDate = (s) =>
  /\b(19|20)\d{2}\b/.test(s) || /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/.test(s) || MONTHS.test(s)
// URL — со схемой, markdown-ссылка или голый домен с путём (domain.com/path): так источники
// часто пишут в списках «· Apple · 14.10.2026 · performance-partners.apple.com/search-api».
const BARE_URL = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|ai|ru|co|edu|gov|eu|me|info|tech|uk|de|fr)\b(?:\/[^\s|)]*)?/i
const hasUrl = (s) => /https?:\/\//i.test(s) || /\]\([^)\s]+\)/.test(s) || BARE_URL.test(s)

// ---------------------------------------------------------------- проверки текста

// Маркер-слово ищется целым словом: «опущено» не должно срабатывать внутри «не пропущено».
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MARKER_RES = MARKERS.map(mk => ({
  mk,
  re: new RegExp((/^[\p{L}]/u.test(mk) ? '(?<![\\p{L}])' : '') + escapeRe(mk) + (/[\p{L}]$/u.test(mk) ? '(?![\\p{L}])' : ''), 'u'),
}))

const stripQuotesAndUrls = (line) => line
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/\d\s?(…|\.\.\.)\s?\d/g, ' ') // числовой диапазон 2025-01-05…2025-01-11
  .replace(/«[^«»]*»/g, ' ')
  .replace(/“[^“”]*”/g, ' ')
  .replace(/"[^"]*"/g, ' ')

function checkCompression(section, file, text, cap = args.all ? Infinity : 8) {
  const lines = text.split('\n')
  const mask = codeFenceMask(lines)
  let hits = 0
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    // Пропуск внутри дословной цитаты («… can influence …»), в URL и в inline-коде — законная
    // форма цитирования, а не сжатие: живой прогон дал 11 таких ложных находок на 4 отчёта.
    const low = stripQuotesAndUrls(maskInlineCode(lines[i])).toLowerCase()
    const found = MARKER_RES.filter(m => m.re.test(low)).map(m => m.mk)
    if (!found.length) continue
    hits++
    if (hits <= cap) {
      warn(section, file, i + 1, 'compression',
        'след сжатия: «' + found.join('», «') + '» — разверни пункт вместо отсылки')
    }
  }
  if (hits > cap) {
    warn(section, file, 0, 'compression-more',
      'следов сжатия всего ' + hits + ', показаны первые ' + cap + ' — пройди файл grep по маркерам')
  }
  return hits
}

// Ячейки строки markdown-таблицы (без крайних пустых).
const tableCells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim())
const SOURCE_COL = /источник|url|ссылк|source|носитель|первоисточник/i
const DATE_COL = /дата|date|проверен|снят/i
const EMPTY_CELL = /^(|—|-|–|н\/д|n\/a|нет)$/i
// Ссылка на список источников отчёта: [12], [S3], [F64], [A-ext].
const SOURCE_REF = /\[(?:\d{1,3}|[A-ZА-Я][A-Za-zА-Яа-я-]{0,6}\d{0,4})\]/

// Для каждой строки таблицы — ячейки её заголовка: по ним видно, есть ли в таблице
// колонка источника и колонка даты.
function tableHeaders(lines, mask) {
  const out = new Array(lines.length).fill(null)
  for (let i = 0; i < lines.length; i++) {
    if (mask[i] || !/^\s*\|/.test(lines[i])) continue
    const head = tableCells(lines[i])
    let j = i + 1
    while (j < lines.length && !mask[j] && /^\s*\|/.test(lines[j])) { out[j] = head; j++ }
    i = j - 1
  }
  return out
}

// Строка таблицы с заполненной колонкой источника и датой (в строке, в колонке даты
// или рядом) — с источником: так устроен банк фактов, URL стоит в своей ячейке или
// источник назван по имени, а полный адрес лежит в списке источников отчёта.
function tableRowSourced(line, head, win) {
  if (!head) return false
  const cells = tableCells(line)
  const srcIdx = head.findIndex(h => SOURCE_COL.test(h))
  if (srcIdx < 0 || EMPTY_CELL.test(cells[srcIdx] || '')) return false
  const dateIdx = head.findIndex(h => DATE_COL.test(h))
  return hasDate(line) || (dateIdx >= 0 && !EMPTY_CELL.test(cells[dateIdx] || '')) || hasDate(win)
}

function checkNumbers(section, file, text, cap = args.all ? Infinity : 8) {
  const lines = text.split('\n')
  const mask = codeFenceMask(lines)
  const heads = tableHeaders(lines, mask)
  let hits = 0
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const line = lines[i]
    if (/^\s*#{1,6}\s/.test(line)) continue
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue
    if (!significantNumbers(line).length) continue
    // Строка расчёта (LTV = $9,99 × 0,85 × 2,22 = $18,87) — вычисление из уже обвязанных
    // входов, а не новый факт: источник у входов, а не у результата.
    if (/=/.test(line) && /[×*÷]|\s[-+\/]\s/.test(line)) continue
    const win = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join('\n')
    if (hasDate(win) && hasUrl(win)) continue
    if (tableRowSourced(line, heads[i], win)) continue
    if (SOURCE_REF.test(stripNonFacts(line)) && hasDate(win)) continue
    hits++
    if (hits <= cap) {
      const miss = [!hasDate(win) ? 'даты' : null, !hasUrl(win) ? 'URL' : null].filter(Boolean).join(' и ')
      warn(section, file, i + 1, 'number-without-source',
        'число без ' + miss + ' рядом: ' + line.trim().slice(0, 110))
    }
  }
  if (hits > cap) {
    warn(section, file, 0, 'number-without-source-more',
      'строк с числом без даты и URL всего ' + hits + ', показаны первые ' + cap)
  }
  return hits
}

function checkQuestions(section, promptPath, promptText, reportPath, reportText) {
  const questions = extractQuestions(promptText)
  if (!questions.length) {
    warn(section, promptPath, 0, 'no-questions-section',
      'в ТЗ не найден раздел «Вопросы ресерча» с нумерованными пунктами — покрытие не сверить')
    return
  }
  const body = reportText.toLowerCase()
  for (const q of questions) {
    const kws = keywordsOf(q.text)
    if (kws.length < 3) continue
    const hit = kws.filter(k => body.includes(k.stem))
    if (hit.length / kws.length >= 0.4) continue
    const head = q.text.replace(/\*\*/g, '').trim().slice(0, 90)
    warn(section, reportPath, 0, 'question-uncovered',
      'вопрос ТЗ ' + q.n + ' похоже без ответа (совпало ' + hit.length + ' из ' + kws.length +
      ' опорных слов): ' + head + ' — сверь вручную, эвристика')
  }
}

function checkLinks(section, file, text) {
  const lines = text.split('\n')
  const mask = codeFenceMask(lines)
  const dir = path.dirname(file)
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    // Inline-код не ссылка: живой прогон дал два ложных блокера на ripgrep-паттерне
    // вида `[a-z](...)` в обратных кавычках.
    const line = maskInlineCode(lines[i])
    const re = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
    let m
    while ((m = re.exec(line))) {
      let target = m[1]
      // внешняя ссылка с любой схемой (http, ftp, doi:, file:) или протокол-относительная — не наша забота
      // точки в схеме нет: «SPEC.md:120» — ссылка на файл с номером строки, а не URL
      if (/^([a-z][a-z0-9+-]*:|\/\/|#)/i.test(target)) continue
      target = target.split('#')[0]
      if (!target) continue
      try { target = decodeURIComponent(target) } catch { /* оставляем как есть */ }
      const abs = target.startsWith('/') ? target : path.resolve(dir, target)
      if (!isFile(abs) && !isDir(abs)) {
        blocker(section, file, i + 1, 'broken-link', 'битая внутренняя ссылка: ' + target)
      }
    }
  }
}

// ---------------------------------------------------------------- результаты агентов

function deepNumber(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null
  if (typeof obj[key] === 'number') return obj[key]
  if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key].trim())) return Number(obj[key])
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const got = deepNumber(v, key, depth + 1)
      if (got != null) return got
    }
    if (typeof v === 'string' && v.trim().startsWith('{')) {
      try {
        const got = deepNumber(JSON.parse(v), key, depth + 1)
        if (got != null) return got
      } catch { /* не JSON — пропускаем */ }
    }
  }
  return null
}

// Результат верификатора — тот же, что засчитывает status (lib/engine.mjs → agentResult):
// сырой возврат упавшего прогона результатом не считается.
function verifyResult(root, slug) {
  const r = agentResult(root, 'verify__' + slug)
  return r && r.data ? r : null
}

// ---------------------------------------------------------------- основной прогон

const args = parseArgs(process.argv.slice(2))
ROOT = args.root
const stage = args.stage
const doPrompts = stage === 'all' || stage === 'prompts'
const doResearch = stage === 'all' || stage === 'research'
const doSynth = stage === 'all' || stage === 'synthesis'

const enginePath = path.join(ROOT, 'engine.json')
const engine = readJson(enginePath)

if (!engine) {
  blocker('Каркас', enginePath, 0, 'no-engine-json',
    isFile(enginePath)
      ? 'engine.json не читается как JSON — почини файл, без него аудита нет'
      : 'нет файла engine.json — движок не собран или указан не тот --root')
  await output()
}

const { topics, syntheses } = normalizeEngine(engine)
const { entry: bankEntry, parts: bankParts } = bankLayout(syntheses)
// Особые файлы движка: GAPS.md пишет стадия critique, навигатор банка, собранного частями, —
// стадия merge. У них нет тем в primary и нет ТЗ в synthesis-spec; мерить их порогом
// «четверть от primary-отчётов» и требовать от них primary — ложные находки.
const isSpecial = (s) => isGaps(s) || (bankParts.length > 0 && s === bankEntry)

note('Каркас', 'движок: ' + (engine.title || engine.slug || '(без названия)') +
  ' · профиль ' + (engine.profile || '?') + ' · финиш ' + (engine.finish || '?') +
  ' · тем ' + topics.length + ', сводов ' + syntheses.length)

if (!topics.length) warn('Каркас', enginePath, 0, 'no-topics', 'в engine.json нет тем — декомпозиция не сделана')
if (!syntheses.length) warn('Каркас', enginePath, 0, 'no-syntheses', 'в engine.json нет сводов — карта сводов не задана')

// ---- ТЗ и карта тем
if (doPrompts) {
  const readme = path.join(ROOT, 'prompts', 'README.md')
  if (!isFile(readme)) warn('ТЗ и карта тем', readme, 0, 'no-prompts-readme', 'нет файла prompts/README.md — карты «тема → свод» нет')

  // Бриф: работа базы и контрольные вопросы (references/BRIEF.md). Тема без контрольного
  // вопроса — допустима (фундамент), контрольный вопрос без темы — база его не ответит.
  if (!engine.brief) {
    warn('ТЗ и карта тем', enginePath, 0, 'no-brief',
      'в engine.json нет брифа — работа базы и контрольные вопросы не заданы, готовность базы мерить нечем (references/BRIEF.md, brief.mjs)')
  } else {
    const brief = normalizeBrief(engine.brief)
    const cov = acceptanceCoverage(brief, topics)
    if (!brief.acceptance.length) {
      warn('ТЗ и карта тем', enginePath, 0, 'no-acceptance', 'в брифе нет контрольных вопросов — критику и заказчику нечем принять базу')
    } else if (topics.length) {
      for (const id of cov.uncovered) {
        const a = brief.acceptance.find(x => x.id === id)
        warn('ТЗ и карта тем', enginePath, 0, 'acceptance-uncovered',
          'контрольный вопрос ' + id + ' не закрыт ни одной темой (topics[].answers) — база на него не ответит: ' + a.question.slice(0, 90))
      }
    }
    for (const u of cov.unknown) {
      warn('ТЗ и карта тем', enginePath, 0, 'acceptance-unknown', 'тема ' + u.topic + ' ссылается на контрольный вопрос ' + u.id + ', которого нет в брифе')
    }
  }

  for (const m of matrixFindings({ topics, syntheses })) warn('ТЗ и карта тем', enginePath, 0, 'matrix', m)

  for (const t of topics) {
    const feedsFromTopic = Array.isArray(t.feeds) ? t.feeds : []
    const feedsFromSynth = syntheses.filter(s =>
      (Array.isArray(s.primary) && s.primary.includes(t.slug)) ||
      (Array.isArray(s.secondary) && s.secondary.includes(t.slug))).map(s => s.label || s.file)
    if (!feedsFromTopic.length && !feedsFromSynth.length) {
      warn('ТЗ и карта тем', enginePath, 0, 'topic-feeds-nothing',
        'тема ' + t.slug + ' не питает ни один свод — либо припиши её к своду, либо убери из движка')
    }
    const p = path.join(ROOT, 'prompts', t.slug + '.md')
    const text = readText(p)
    if (text == null) {
      warn('ТЗ и карта тем', p, 0, 'no-prompt', 'нет файла ТЗ на тему ' + t.slug)
      continue
    }
    const h = headings(text, 2).filter(x => x.level === 2)
    if (h.length < 4) {
      warn('ТЗ и карта тем', p, 0, 'thin-prompt',
        'в ТЗ ' + h.length + ' ' + plural(h.length, 'раздел', 'раздела', 'разделов') +
        ' вместо шести из templates/prompt.tmpl.md')
    }
    if (!extractQuestions(text).length) {
      warn('ТЗ и карта тем', p, 0, 'no-questions-section',
        'нет нумерованных пунктов в разделе «Вопросы ресерча» — покрытие темы нечем сверять')
    }
  }

  for (const s of syntheses) {
    if (isSpecial(s)) continue
    if (!Array.isArray(s.primary) || !s.primary.length) {
      warn('ТЗ и карта тем', enginePath, 0, 'synthesis-without-primary',
        'свод ' + s.label + ' без primary-темы — он соберётся из воздуха')
    }
    const spec = path.join(ROOT, 'synthesis-spec', s.label + '.md')
    if (!isFile(spec)) {
      warn('ТЗ и карта тем', spec, 0, 'no-synthesis-spec', 'нет ТЗ на свод ' + s.label)
    }
  }
}

// ---- Отчёты
const reportWords = new Map()

if (doResearch || doSynth) {
  for (const t of topics) {
    const slug = t.slug
    const p = path.join(ROOT, 'reports', slug + '.md')
    const text = readText(p)
    const status = String(t.status || 'planned')
    // Прогон числится по статусу и по результатам агентов на диске, а не по журналу: в журнал
    // попадают и упавшие задачи, и метка pricing находилась внутри pricing-b2b.
    const ranResearch = status !== 'planned' ||
      !!agentResult(ROOT, 'research__' + slug) ||
      !!verifyResult(ROOT, slug)
    // пустой файл — тот же потерянный отчёт: агент открыл файл и оборвался
    if (text == null || !countWords(text)) {
      if (!ranResearch) {
        if (doResearch) warn('Отчёты', p, 0, 'report-planned', 'нет файла отчёта, тема в статусе planned — просто ещё не прогнана')
      } else {
        blocker('Отчёты', p, 0, 'no-report',
          (text == null ? 'нет отчёта' : 'отчёт пуст') + ' на тему ' + slug + ', хотя ресерч по ней числится (статус темы «' + status + '») — файл потерян, оборван или записан не туда')
      }
      continue
    }
    const words = countWords(text)
    reportWords.set(slug, words)
    if (!doResearch) continue

    // заголовок ищем по смыслу: живой прогон показал, что агент пишет и «## 8. Протокол верификации от <дата>»;
    // засчитывается только раздел, подписанный верификатором (lib/engine.mjs → verificationOf)
    const { head: anyHead, signed: verifyHead } = verificationOf(ROOT, slug, text)
    const vr = verifyResult(ROOT, slug)
    const verifyExpected = status === 'verified' || !!vr

    if (!verifyHead) {
      if (verifyExpected) {
        blocker('Отчёты', p, anyHead ? anyHead.line : 0, 'no-verification',
          (anyHead ? 'раздел «' + anyHead.title + '» не подписан верификатором (нет результата verify__' + slug + ' и даты в заголовке)' : 'в отчёте нет раздела «## Верификация»') +
          ', хотя верификация ' + (status === 'verified' ? 'отмечена статусом темы' : 'числится в state/results') + ' — отчёт не достроен')
      } else {
        warn('Отчёты', p, 0, 'verification-pending',
          'верификации ещё не было: ' + (anyHead ? 'раздел «' + anyHead.title + '» написал не верификатор' : 'раздела «## Верификация» нет') + ', статус темы «' + status + '»')
      }
    }

    const before = vr ? deepNumber(vr.data, 'wordsBefore') : null
    const after = vr ? deepNumber(vr.data, 'wordsAfter') : null
    if (before != null && after != null) {
      if (after <= before) {
        blocker('Отчёты', p, 0, 'no-growth',
          'отчёт после верификации не вырос: было ' + wordsRu(before) + ', стало ' + wordsRu(after) +
          ' — верификатор сокращал вместо достройки')
      } else {
        note('Отчёты', slug + ': ' + wordsRu(words) + ' · верификация +' + wordsRu(after - before) +
          (verifyHead ? ' · раздел «Верификация» на строке ' + verifyHead.line : ''))
        const drift = Math.abs(after - words) / Math.max(after, 1)
        if (drift > 0.3) {
          warn('Отчёты', p, 0, 'words-drift',
            'заявленный объём после верификации (' + fmt(after) + ') расходится с файлом (' + fmt(words) +
            ') больше чем на треть — сверь, тот ли файл правили')
        }
      }
    } else if (verifyHead) {
      note('Отчёты', slug + ': ' + wordsRu(words) + ' · раздел «Верификация» есть')
      warn('Отчёты', vr ? vr.path : path.join(ROOT, 'state', 'results', 'verify__' + slug + '.json'), 0,
        'no-words-numbers',
        vr
          ? 'в результате верификации нет чисел wordsBefore/wordsAfter — рост отчёта подтверждён только разделом в файле'
          : 'нет файла результата верификации — рост отчёта подтверждён только разделом «## Верификация» в файле')
    } else if (verifyExpected) {
      warn('Отчёты', p, 0, 'no-words-numbers',
        'рост объёма после верификации подтвердить нечем: ни чисел в state/results, ни раздела в отчёте')
    } else {
      note('Отчёты', slug + ': ' + wordsRu(words) + ' · верификация не прогонялась')
    }

    checkCompression('Отчёты', p, text)
    checkNumbers('Отчёты', p, text)

    const promptText = readText(path.join(ROOT, 'prompts', slug + '.md'))
    if (promptText != null) checkQuestions('Отчёты', path.join(ROOT, 'prompts', slug + '.md'), promptText, p, text)
  }
}

// ---- Своды
if (doSynth) {
  for (const s of syntheses) {
    const file = synthFileName(s)
    const p = path.join(ROOT, 'synthesis', file)
    const text = readText(p)
    const status = String(s.status || 'planned')
    // GAPS.md — не надмножество отчётов, а их ревизия: порог четверти к нему не применяется,
    // но done без файла — та же потеря, что у свода
    if (isGaps(s)) {
      if (status === 'done' && !countWords(text)) blocker('Своды', p, 0, 'no-synthesis-file', 'нет файла ' + file + ' (или он пуст), а запись gaps помечена done')
      continue
    }
    if (text == null || !countWords(text)) {
      if (status === 'planned') {
        warn('Своды', p, 0, 'synthesis-planned', 'нет файла свода ' + file + ', статус planned — ещё не собран')
      } else {
        blocker('Своды', p, 0, 'no-synthesis-file', (text == null ? 'нет файла свода ' : 'пустой файл свода ') + file + ', а статус свода «' + status + '»')
      }
      continue
    }
    const words = countWords(text)
    if (isSpecial(s)) {
      // навигатор поверх частей банка: данные живут в частях, сам он — вход в них
      note('Своды', file + ': ' + wordsRu(words) + ' · навигатор банка фактов поверх ' + bankParts.length + ' ' +
        plural(bankParts.length, 'части', 'частей', 'частей') + ', порог четверти к нему не применяется')
      continue
    }
    const primary = Array.isArray(s.primary) ? s.primary : []
    if (!primary.length) {
      warn('Своды', enginePath, 0, 'synthesis-without-primary',
        'свод ' + s.label + ' без primary-темы — он соберётся из воздуха')
    }
    let sum = 0
    const missing = []
    for (const slug of primary) {
      if (reportWords.has(slug)) sum += reportWords.get(slug)
      else {
        const w = countWords(readText(path.join(ROOT, 'reports', slug + '.md')))
        if (w) { reportWords.set(slug, w); sum += w } else missing.push(slug)
      }
    }
    if (missing.length) {
      warn('Своды', p, 0, 'primary-report-missing',
        'нет файлов primary-отчётов: ' + missing.join(', ') + ' — объём свода сравнивать не с чем полностью')
    }
    if (sum > 0) {
      const share = words / sum
      if (share < 0.25) {
        blocker('Своды', p, 0, 'synthesis-too-short',
          'свод сжат до ' + Math.round(share * 100) + '% от своих primary-отчётов (' +
          fmt(words) + ' слов против ' + fmt(sum) + ') — порог четверть; верни выброшенное в свод')
      } else {
        note('Своды', file + ': ' + wordsRu(words) + ', ' + Math.round(share * 100) +
          '% от primary-отчётов (' + fmt(sum) + ')')
      }
    } else {
      note('Своды', file + ': ' + wordsRu(words) + ', ' +
        (primary.length ? 'ни одного primary-отчёта на диске нет' : 'primary-темы в engine.json не заданы') +
        ' — порог четверти не проверить')
    }
    checkCompression('Своды', p, text)
    checkNumbers('Своды', p, text)
  }

  const finish = String(engine.finish || DEFAULT_FINISH)
  const gapsRel = gapsRelPath(syntheses)
  const tail = [[gapsRel, path.join(ROOT, gapsRel)]]
  if (finish === 'method') {
    tail.push(['METHOD.md', path.join(ROOT, 'METHOD.md')])
    tail.push(['AGENT.md', path.join(ROOT, 'AGENT.md')])
    tail.push(['INDEX.md', path.join(ROOT, 'INDEX.md')])
  }
  for (const [name, p] of tail) {
    if (!isFile(p)) warn('Своды', p, 0, 'finish-file-missing', 'нет файла ' + name + ' — финиш «' + finish + '» не доведён')
  }
}

// ---- Результаты агентов: файл state/results/<label>.json читают audit и status, а Workflow
// проверяет по схеме только возврат в чат. Схема — копия в движке, иначе — в скилле.
{
  const SCHEMA_OF = { recon: 'file', research: 'research', verify: 'verify', synth: 'file', merge: 'file', critique: 'gaps', method: 'file' }
  const resDir = path.join(ROOT, 'state', 'results')
  let files = []
  try { files = fs.readdirSync(resDir).filter(f => f.endsWith('.json') && !f.endsWith('.raw.json')).sort() } catch { /* каталога нет */ }
  const schemaCache = {}
  const schemaOf = (name) => {
    if (!(name in schemaCache)) schemaCache[name] = readJson(path.join(ROOT, 'schemas', name + '.json')) || readJson(path.join(SKILL, 'schemas', name + '.json'))
    return schemaCache[name]
  }
  for (const f of files) {
    const prefix = f.split('__')[0]
    if (!SCHEMA_OF[prefix]) continue
    const stageOk = (prefix === 'research' || prefix === 'verify') ? doResearch : (prefix === 'recon' ? doPrompts : doSynth)
    if (!stageOk) continue
    const schema = schemaOf(SCHEMA_OF[prefix])
    if (!schema) continue
    const data = readJson(path.join(resDir, f))
    const probs = data ? schemaProblems(data, schema) : ['файл не читается как JSON']
    if (probs.length) warn('Отчёты', path.join(resDir, f), 0, 'result-schema', 'результат агента не по схеме ' + SCHEMA_OF[prefix] + '.json: ' + probs.slice(0, 5).join('; ') + ' — если файл записан прежней версией скилла, это след старой схемы, а не брак')
  }
}

// ---- Ссылки
{
  const buckets = []
  if (doPrompts) buckets.push('prompts', 'synthesis-spec')
  if (doResearch) buckets.push('reports')
  if (doSynth) buckets.push('synthesis')
  for (const b of buckets) {
    const dir = path.join(ROOT, b)
    for (const f of listMd(dir)) {
      const p = path.join(dir, f)
      const text = readText(p)
      if (text != null) checkLinks('Ссылки', p, text)
    }
  }
  if (stage === 'all') {
    for (const f of ['ENGINE.md', 'METHOD.md', 'AGENT.md', 'INDEX.md']) {
      const p = path.join(ROOT, f)
      const text = readText(p)
      if (text != null) checkLinks('Ссылки', p, text)
    }
  }
}

await output()

// ---------------------------------------------------------------- вывод

async function output() {
  const blockers = findings.filter(f => f.level === 'blocker')
  const warns = findings.filter(f => f.level === 'warn')

  if (args.json) {
    console.log(JSON.stringify({
      root: ROOT,
      stage: args.stage,
      ok: blockers.length === 0,
      counts: { blockers: blockers.length, warnings: warns.length },
      findings,
      notes,
    }, null, 2))
    await flushAndExit(blockers.length ? 1 : 0)
  }

  const title = engine && engine.title ? engine.title : path.basename(ROOT)
  console.log('# Аудит движка «' + title + '»')
  console.log(ROOT + ' · стадия: ' + args.stage)
  console.log('')

  for (const section of SECTIONS) {
    const fs_ = findings.filter(f => f.section === section)
    const ns = notes.filter(n => n.section === section)
    if (!fs_.length && !ns.length) continue
    console.log('## ' + section)
    for (const n of ns) console.log('  ·        ' + n.message)
    for (const f of fs_.filter(f => f.level === 'blocker')) console.log(line(f))
    for (const f of fs_.filter(f => f.level === 'warn')) console.log(line(f))
    console.log('')
  }

  console.log('Итого: блокеров ' + blockers.length + ', предупреждений ' + warns.length + '.')
  if (blockers.length) {
    console.log('Блокер — это нарушенный закон конвейера. Чини и гоняй audit заново.')
  } else if (warns.length) {
    console.log('Блокеров нет. Предупреждения разбери руками: каждое либо чинится, либо объясняется в run-log.')
  } else {
    console.log('Блокеров и предупреждений нет.')
  }
  await flushAndExit(blockers.length ? 1 : 0)
}

function line(f) {
  const mark = f.level === 'blocker' ? 'БЛОКЕР  ' : 'ПРЕДУПР '
  const addr = f.file ? f.file + (f.line ? ':' + f.line : '') + ' — ' : ''
  return '  ' + mark + ' ' + addr + f.message
}

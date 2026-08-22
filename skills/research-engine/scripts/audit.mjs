#!/usr/bin/env node
// audit.mjs — машинная проверка закона конвейера движка research-engine.
// Node 18+, ESM, без зависимостей. Ни одна проверка не падает на отсутствующем файле:
// пишется «нет файла», а не стектрейс.

import fs from 'node:fs'
import path from 'node:path'

const USAGE = `audit.mjs — проверка закона конвейера: ни один шаг не сжимает содержание.

  node audit.mjs --root <path> [--stage all|prompts|research|synthesis] [--json]

  --root    каталог движка (в нём лежит engine.json). Обязателен.
  --stage   что проверять: all (по умолчанию) | prompts | research | synthesis
  --json    машинный вывод вместо читаемого отчёта
  --help    эта справка

Блокеры (код возврата 1):
  нет отчёта на прогнанную тему · в отчёте нет раздела «## Верификация» ·
  отчёт после верификации не вырос · свод короче четверти суммарного объёма своих
  primary-отчётов · нет файла свода, помеченного done · битая внутренняя ссылка.

Предупреждения (код возврата 0):
  следы сжатия («и т.д.», «см. выше», «аналогично», «и другие», «…») · вопрос ТЗ без
  ответа в отчёте · число без даты и URL рядом · тема, не питающая ни один свод ·
  свод без primary-темы · недостающие файлы финиша.`

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

function die(msg, code = 2) {
  console.error('Ошибка: ' + msg)
  process.exit(code)
}

function parseArgs(argv) {
  const out = { root: '', stage: 'all', json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0) }
    else if (a === '--root') out.root = argv[++i] || ''
    else if (a.startsWith('--root=')) out.root = a.slice('--root='.length)
    else if (a === '--stage') out.stage = argv[++i] || ''
    else if (a.startsWith('--stage=')) out.stage = a.slice('--stage='.length)
    else if (a === '--json') out.json = true
    else die('неизвестный аргумент ' + a + '\n\n' + USAGE)
  }
  if (!out.root) die('не задан --root <path>\n\n' + USAGE)
  if (!['all', 'prompts', 'research', 'synthesis'].includes(out.stage)) {
    die('--stage принимает all | prompts | research | synthesis, получено: ' + out.stage)
  }
  out.root = path.resolve(out.root)
  if (!isDir(out.root)) die('каталог движка не найден: ' + out.root)
  return out
}

// ---------------------------------------------------------------- файлы

function isDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }
function isFile(p) { try { return fs.statSync(p).isFile() } catch { return false } }
function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
function readJson(p) { const t = readText(p); if (t == null) return null; try { return JSON.parse(t) } catch { return null } }
function listMd(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort() } catch { return [] }
}

const countWords = (t) => (t ? (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length : 0)
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  if (b === 1) return one
  return many
}
const wordsRu = (n) => fmt(n) + ' ' + plural(n, 'слово', 'слова', 'слов')

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

function codeFenceMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; mask[i] = true; continue }
    mask[i] = inFence
  }
  return mask
}

function headings(text, maxDepth = 6) {
  const lines = text.split('\n')
  const mask = codeFenceMask(lines)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (m && m[1].length <= maxDepth) out.push({ line: i + 1, level: m[1].length, title: m[2] })
  }
  return out
}

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

function significantNumbers(line) {
  const out = []
  const re = /\d+(?:[.,]\d+)?\s?%|\d+[.,]\d+|\d{3,}/g
  let m
  while ((m = re.exec(line))) {
    const s = m[0]
    if (/^\d{4}$/.test(s) && Number(s) >= 1900 && Number(s) <= 2100) continue
    out.push(s)
  }
  return out
}

const hasDate = (s) =>
  /\b(19|20)\d{2}\b/.test(s) || /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/.test(s) || MONTHS.test(s)
const hasUrl = (s) => /https?:\/\//i.test(s) || /\]\([^)\s]+\)/.test(s)

// ---------------------------------------------------------------- проверки текста

function checkCompression(section, file, text, cap = 8) {
  const lines = text.split('\n')
  const mask = codeFenceMask(lines)
  let hits = 0
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const low = lines[i].toLowerCase()
    const found = MARKERS.filter(mk => low.includes(mk))
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

function checkNumbers(section, file, text, cap = 8) {
  const lines = text.split('\n')
  const mask = codeFenceMask(lines)
  let hits = 0
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const line = lines[i]
    if (/^\s*#{1,6}\s/.test(line)) continue
    if (/^\s*\|?\s*-{3,}/.test(line)) continue
    if (!significantNumbers(line).length) continue
    const win = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join('\n')
    if (hasDate(win) && hasUrl(win)) continue
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
    const re = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
    let m
    while ((m = re.exec(lines[i]))) {
      let target = m[1]
      if (/^(https?:|mailto:|tel:|data:|#)/i.test(target)) continue
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

function verifyResult(root, slug) {
  const dir = path.join(root, 'state', 'results')
  for (const name of ['verify__' + slug + '.json', 'verify__' + slug + '.raw.json']) {
    const p = path.join(dir, name)
    const data = readJson(p)
    if (data) return { path: p, data }
  }
  return null
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
  output()
}

const topics = Array.isArray(engine.topics) ? engine.topics.filter(t => t && t.slug) : []
const syntheses = Array.isArray(engine.syntheses) ? engine.syntheses.filter(s => s && (s.label || s.file)) : []
const runLog = readText(path.join(ROOT, 'state', 'run-log.md')) || ''

note('Каркас', 'движок: ' + (engine.title || engine.slug || '(без названия)') +
  ' · профиль ' + (engine.profile || '?') + ' · финиш ' + (engine.finish || '?') +
  ' · тем ' + topics.length + ', сводов ' + syntheses.length)

if (!topics.length) warn('Каркас', enginePath, 0, 'no-topics', 'в engine.json нет тем — декомпозиция не сделана')
if (!syntheses.length) warn('Каркас', enginePath, 0, 'no-syntheses', 'в engine.json нет сводов — карта сводов не задана')

// ---- ТЗ и карта тем
if (doPrompts) {
  const readme = path.join(ROOT, 'prompts', 'README.md')
  if (!isFile(readme)) warn('ТЗ и карта тем', readme, 0, 'no-prompts-readme', 'нет файла prompts/README.md — карты «тема → свод» нет')

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
    if (!Array.isArray(s.primary) || !s.primary.length) {
      warn('ТЗ и карта тем', enginePath, 0, 'synthesis-without-primary',
        'свод ' + (s.label || s.file) + ' без primary-темы — он соберётся из воздуха')
    }
    const spec = path.join(ROOT, 'synthesis-spec', (s.label || '') + '.md')
    if (s.label && !isFile(spec)) {
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
    const resDir = path.join(ROOT, 'state', 'results')
    const ranResearch = status !== 'planned' ||
      isFile(path.join(resDir, 'research__' + slug + '.json')) ||
      isFile(path.join(resDir, 'research__' + slug + '.raw.json')) ||
      !!verifyResult(ROOT, slug) ||
      runLog.includes('research__' + slug) || runLog.includes('verify__' + slug)
    if (text == null) {
      if (!ranResearch) {
        if (doResearch) warn('Отчёты', p, 0, 'report-planned', 'нет файла отчёта, тема в статусе planned — просто ещё не прогнана')
      } else {
        blocker('Отчёты', p, 0, 'no-report',
          'нет отчёта на тему ' + slug + ', хотя ресерч по ней числится (статус темы «' + status + '») — файл потерян или записан не туда')
      }
      continue
    }
    const words = countWords(text)
    reportWords.set(slug, words)
    if (!doResearch) continue

    // заголовок ищем по смыслу: живой прогон показал, что агент пишет и «## 8. Протокол верификации от <дата>»
    const verifyHead = headings(text, 3).find(h => h.level <= 3 && /^(\d+[.)]\s*)?(протокол\s+)?верификаци/i.test(h.title))
    const vr = verifyResult(ROOT, slug)
    const loggedVerify = runLog.includes('verify__' + slug)
    const verifyExpected = status === 'verified' || !!vr || loggedVerify

    if (!verifyHead) {
      if (verifyExpected) {
        blocker('Отчёты', p, 0, 'no-verification',
          'в отчёте нет раздела «## Верификация», хотя верификация ' +
          (status === 'verified' ? 'отмечена статусом темы' : 'числится в state') + ' — отчёт не достроен')
      } else {
        warn('Отчёты', p, 0, 'verification-pending',
          'верификации ещё не было: раздела «## Верификация» нет, статус темы «' + status + '»')
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
    const file = s.file || String(s.label || 'SYNTHESIS').toUpperCase() + '.md'
    const p = path.join(ROOT, 'synthesis', file)
    const text = readText(p)
    const status = String(s.status || 'planned')
    if (text == null) {
      if (status === 'planned') {
        warn('Своды', p, 0, 'synthesis-planned', 'нет файла свода ' + file + ', статус planned — ещё не собран')
      } else {
        blocker('Своды', p, 0, 'no-synthesis-file', 'нет файла свода ' + file + ', а статус свода «' + status + '»')
      }
      continue
    }
    const words = countWords(text)
    const primary = Array.isArray(s.primary) ? s.primary : []
    if (!primary.length) {
      warn('Своды', enginePath, 0, 'synthesis-without-primary',
        'свод ' + (s.label || file) + ' без primary-темы — он соберётся из воздуха')
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

  const finish = String(engine.finish || 'base')
  const tail = [['synthesis/GAPS.md', path.join(ROOT, 'synthesis', 'GAPS.md')]]
  if (finish === 'method') {
    tail.push(['METHOD.md', path.join(ROOT, 'METHOD.md')])
    tail.push(['AGENT.md', path.join(ROOT, 'AGENT.md')])
    tail.push(['INDEX.md', path.join(ROOT, 'INDEX.md')])
  }
  for (const [name, p] of tail) {
    if (!isFile(p)) warn('Своды', p, 0, 'finish-file-missing', 'нет файла ' + name + ' — финиш «' + finish + '» не доведён')
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

output()

// ---------------------------------------------------------------- вывод

function output() {
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
    process.exit(blockers.length ? 1 : 0)
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
  process.exit(blockers.length ? 1 : 0)
}

function line(f) {
  const mark = f.level === 'blocker' ? 'БЛОКЕР  ' : 'ПРЕДУПР '
  const addr = f.file ? f.file + (f.line ? ':' + f.line : '') + ' — ' : ''
  return '  ' + mark + ' ' + addr + f.message
}

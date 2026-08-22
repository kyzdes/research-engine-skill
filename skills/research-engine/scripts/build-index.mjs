#!/usr/bin/env node
// build-index.mjs — сборка INDEX.md: карта сводов с номерами строк.
// Node 18+, ESM, без зависимостей. Формат — как в aso-skill/skills/aso/references/INDEX.md.

import fs from 'node:fs'
import path from 'node:path'

const USAGE = `build-index.mjs — карта сводов: когда открывать, сколько строк и слов, «строка | раздел».

  node build-index.mjs --root <path> [--dir synthesis] [--out INDEX.md] [--max-depth 2]

  --root        каталог движка (в нём лежит engine.json). Обязателен.
  --dir         что индексировать, относительно --root (по умолчанию synthesis)
  --out         куда писать, относительно --root (по умолчанию INDEX.md)
  --max-depth   до какого уровня заголовков строить таблицу (по умолчанию 2 = только «##»)
  --help        эта справка

Порядок файлов — из engine.json (порядок работы), а не по алфавиту. Файлы, которых нет
в engine.json, идут в конец. METHOD.md подхватывается из корня движка первой строкой карты.`

// ---------------------------------------------------------------- аргументы

function die(msg, code = 2) {
  console.error('Ошибка: ' + msg)
  process.exit(code)
}

function parseArgs(argv) {
  const out = { root: '', dir: 'synthesis', out: 'INDEX.md', maxDepth: 2 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0) }
    else if (a === '--root') out.root = argv[++i] || ''
    else if (a.startsWith('--root=')) out.root = a.slice('--root='.length)
    else if (a === '--dir') out.dir = argv[++i] || ''
    else if (a.startsWith('--dir=')) out.dir = a.slice('--dir='.length)
    else if (a === '--out') out.out = argv[++i] || ''
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length)
    else if (a === '--max-depth') out.maxDepth = Number(argv[++i])
    else if (a.startsWith('--max-depth=')) out.maxDepth = Number(a.slice('--max-depth='.length))
    else die('неизвестный аргумент ' + a + '\n\n' + USAGE)
  }
  if (!out.root) die('не задан --root <path>\n\n' + USAGE)
  if (!out.dir) die('--dir не может быть пустым')
  if (!out.out) die('--out не может быть пустым')
  if (!Number.isInteger(out.maxDepth) || out.maxDepth < 2 || out.maxDepth > 6) {
    die('--max-depth принимает целое от 2 до 6')
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

function scan(text, maxDepth) {
  const lines = text.split('\n')
  const mask = codeFenceMask(lines)
  const heads = []
  let h1 = ''
  let intro = ''
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (m) {
      if (m[1].length === 1 && !h1) h1 = m[2]
      else if (m[1].length >= 2 && m[1].length <= maxDepth) heads.push({ line: i + 1, level: m[1].length, title: m[2] })
      continue
    }
    if (intro) continue
    const raw = lines[i].trim()
    if (!raw) continue
    if (/^([-*+>|]|\d+[.)]|---|===|\|)/.test(raw)) continue
    intro = raw
  }
  return { lines: lines.length, heads, h1, intro }
}

function firstSentence(s, limit = 260) {
  if (!s) return ''
  const clean = s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const m = /^(.+?[.!?])(\s|$)/.exec(clean)
  let out = m ? m[1] : clean
  if (out.length > limit) out = out.slice(0, limit - 1).replace(/[\s,;:]+\S*$/, '') + '…'
  return out
}

const escapeCell = (s) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

const linesRu = (n) => fmt(n) + ' ' + plural(n, 'строка', 'строки', 'строк')
const wordsRu = (n) => fmt(n) + ' ' + plural(n, 'слово', 'слова', 'слов')

// Файлы с известной ролью: подпись «когда открывать» ставится по роли, а не по названию свода.
function knownWhen(name) {
  if (name === 'METHOD.md') return 'Всегда, целиком, до первого действия.'
  if (name === 'AGENT.md') return 'Первый файл сессии: как работать по движку.'
  if (name === 'GAPS.md') return 'Прежде чем что-то пообещать заказчику: чего движок не знает и где навредит.'
  if (name === 'FACTS-BANK.md') return 'Навигатор банка: ищешь, в какой части лежит число.'
  if (/^FACTS-BANK-[a-z]\.md$/i.test(name)) return 'Ищешь число, а не процедуру — grep по части банка, чтения подряд не бывает.'
  if (name === 'VERDICTS.md') return 'Спор между источниками: чья позиция чем подтверждена.'
  return ''
}

// ---------------------------------------------------------------- сборка

const args = parseArgs(process.argv.slice(2))
const ROOT = args.root
const DIR = path.resolve(ROOT, args.dir)
const OUT = path.resolve(ROOT, args.out)

if (!isDir(DIR)) die('нет каталога для индексации: ' + DIR)

const engine = readJson(path.join(ROOT, 'engine.json')) || {}
if (!engine.title && !engine.slug) {
  console.error('Предупреждение: engine.json не прочитан — порядок файлов будет алфавитный, названия сводов взяты из файлов.')
}

const syntheses = Array.isArray(engine.syntheses) ? engine.syntheses.filter(Boolean) : []

// порядок: как в engine.json, остальное — в конец по алфавиту
const present = fs.readdirSync(DIR).filter(f => f.endsWith('.md')).sort()
const ordered = []
const seen = new Set()
for (const s of syntheses) {
  const file = s.file || (s.label ? String(s.label).toUpperCase() + '.md' : '')
  if (!file || seen.has(file)) continue
  if (!present.includes(file)) continue
  seen.add(file)
  ordered.push({ file, meta: s })
}
for (const f of present) {
  if (seen.has(f)) continue
  if (f === 'INDEX.md' || path.resolve(DIR, f) === OUT) continue // карту по карте не строим
  seen.add(f)
  ordered.push({ file: f, meta: null })
}

if (!ordered.length) die('в каталоге ' + DIR + ' нет ни одного .md — индексировать нечего')

// METHOD.md читается целиком, поэтому идёт первым — из корня движка или из самого каталога
const entries = []
const methodPath = path.join(ROOT, 'METHOD.md')
if (path.resolve(DIR) !== path.resolve(ROOT) && isFile(methodPath)) {
  entries.push({ abs: methodPath, name: 'METHOD.md', meta: null, method: true })
}
for (const o of ordered) {
  entries.push({ abs: path.join(DIR, o.file), name: o.file, meta: o.meta, method: o.file === 'METHOD.md' })
}
const methodAt = entries.findIndex(e => e.method)
if (methodAt > 0) entries.unshift(entries.splice(methodAt, 1)[0])

const blocks = []
let totalWords = 0
let biggest = { name: '', lines: 0 }
let secondBiggest = { name: '', lines: 0 }
const skipped = []

for (const e of entries) {
  const text = readText(e.abs)
  if (text == null) { skipped.push(e.name); continue }
  const info = scan(text, args.maxDepth)
  const words = countWords(text)
  totalWords += words
  if (!e.method) {
    if (info.lines > biggest.lines) { secondBiggest = biggest; biggest = { name: e.name, lines: info.lines } }
    else if (info.lines > secondBiggest.lines) { secondBiggest = { name: e.name, lines: info.lines } }
  }

  const when = (e.meta && (e.meta.when || e.meta.whenToOpen))
    || knownWhen(e.name)
    || (e.meta && e.meta.title ? 'Работаешь с темой: ' + e.meta.title + '.' : 'Точечно, по адресу из таблицы ниже.')

  const what = firstSentence(info.intro) ||
    (info.heads.length ? info.heads.slice(0, 4).map(h => h.title).join('; ') + '.' : 'Содержимое не размечено заголовками.')

  const rows = info.heads.map(h => {
    const indent = h.level > 2 ? '— '.repeat(h.level - 2) : ''
    return '| ' + h.line + ' | ' + indent + escapeCell(h.title) + ' |'
  })

  const b = []
  b.push('## `' + e.name + '`')
  b.push('')
  b.push('**Когда открывать:** ' + when + ' · **Объём:** ' + linesRu(info.lines) + ', ~' + wordsRu(words) + '.')
  b.push('')
  b.push(what)
  b.push('')
  if (rows.length) {
    b.push('| Строка | Раздел |')
    b.push('|---|---|')
    b.push(...rows)
  } else {
    b.push('Заголовков до уровня ' + '#'.repeat(args.maxDepth) + ' включительно в файле нет — ищи по нему `grep -n`.')
  }
  blocks.push(b.join('\n'))
}

const today = engine.today || new Date().toISOString().slice(0, 10)
const title = engine.title || engine.slug || path.basename(ROOT)
const volume = totalWords >= 10000
  ? 'около ' + fmt(Math.round(totalWords / 1000)) + ' ' +
    plural(Math.round(totalWords / 1000), 'тысячи', 'тысяч', 'тысяч') + ' слов'
  : totalWords >= 1000
    ? 'около ' + fmt(Math.round(totalWords / 100) * 100) + ' слов'
    : fmt(totalWords) + ' ' + plural(totalWords, 'слово', 'слова', 'слов')
const wholeRead = entries.some(e => e.method) ? '`METHOD.md`' : 'ни один'
const bigNote = biggest.name
  ? 'в `' + biggest.name + '` ' + linesRu(biggest.lines) +
    (secondBiggest.name ? ', в `' + secondBiggest.name + '` — ' + linesRu(secondBiggest.lines) : '') + '.'
  : ''

const head = []
head.push('# INDEX — навигатор по своду движка «' + title + '»')
head.push('')
head.push('Свод — ' + entries.length + ' ' + plural(entries.length, 'файл', 'файла', 'файлов') + ' и ' + volume + '. **Целиком не читается ' +
  (wholeRead === 'ни один' ? 'ни один файл' : 'ничего, кроме ' + wholeRead) +
  '.** Ниже — карта: какой файл про что и на какой строке лежит нужный раздел.')
head.push('')
head.push('## Как читать большой свод')
head.push('')
head.push('1. **Найди адрес здесь.** В таблицах ниже у каждого раздела стоит номер строки на дату сборки.')
head.push('2. **Открой окном:** `Read` с `offset` = номер строки и `limit` = 60–200. Не открывай файл без `offset` — ' +
  (bigNote || 'своды длинные и съедают контекст целиком.'))
head.push('3. **Раздела нет в карте** (строки уехали после правок) — `grep -n \'^#\' <файл>` и дальше окном.')
head.push('4. **Ищешь число, а не процедуру** — иди в банк фактов через `grep`, а не читай подряд. Каждое число там лежит с выборкой, носителем, датой и URL.')
head.push('5. **Не пересказывай свод в ответе.** Он источник точной формулировки и точного числа, а не текст для копирования заказчику.')
head.push('')
head.push('Порядок таблиц ниже = порядок работы, а не алфавит.')
head.push('')
if (isDir(path.join(ROOT, 'reports'))) {
  head.push('Ссылки вида `reports/<тема>.md` внутри сводов — провенанс: адрес в исходных отчётах движка. Отчёты лежат в `' +
    path.join(ROOT, 'reports') + '`, читать их незачем: всё извлечённое уже в сводах. Открывай отчёт, только когда пересобираешь движок.')
  head.push('')
}
head.push('---')
head.push('')
head.push('')

const foot = []
foot.push('')
foot.push('---')
foot.push('')
foot.push('*Номера строк сняты ' + today + '. После правки любого свода перегенерируй карту: `node scripts/build-index.mjs --root ' + ROOT + '`.*')
foot.push('')

const outText = head.join('\n') + blocks.join('\n\n') + '\n' + foot.join('\n')

try {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, outText, 'utf8')
} catch (e) {
  die('не удалось записать ' + OUT + ': ' + e.message, 1)
}

console.log('INDEX собран: ' + entries.length + ' ' + plural(entries.length, 'файл', 'файла', 'файлов') +
  ', ~' + fmt(totalWords) + ' ' + plural(totalWords, 'слово', 'слова', 'слов') + ' → ' + OUT)
if (skipped.length) console.log('Не прочитаны (пропущены): ' + skipped.join(', '))

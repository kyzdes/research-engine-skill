// lib/engine.mjs — общее ядро скриптов движка: чтение engine.json, канон имён файлов и меток
// задач, роли особых сводов (GAPS, навигатор банка фактов), счёт слов, русские числительные.
// Раньше всё это жило копиями в каждом скрипте и успело разъехаться: fanout считал задачей
// стадии synth и GAPS.md, audit мерил навигатор банка как обычный свод, имя файла свода
// по умолчанию строилось тремя разными способами. Правило: если два скрипта должны
// договориться о чём-то в engine.json — это живёт здесь.
// Node 18+, ESM, без зависимостей.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Корень скилла: схемы возврата лежат в <скилл>/schemas, копии — в <движок>/schemas.
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------- файлы и ошибки

export function die(msg, code = 2) {
  console.error('Ошибка: ' + msg)
  process.exit(code)
}

// Выход после печати. process.exit() сразу после console.log обрезает вывод в пайп: Node
// дописывает stdout асинхронно, и машинный JSON аудита ломался на ~64 КБ. Пустая запись
// с колбэком срабатывает, когда ушло всё записанное раньше. Вызывать через await.
export async function flushAndExit(code = 0) {
  await new Promise(resolve => process.stdout.write('', resolve))
  process.exit(code)
}

// Значение флага командной строки: следующий аргумент, если это не другой флаг. Без проверки
// «status.mjs --root --write» принимал «--write» за путь движка.
export function takeValue(argv, i, name) {
  const v = argv[i + 1]
  if (v === undefined || (v.startsWith('--') && v.length > 2)) die('у аргумента ' + name + ' нет значения')
  return v
}

// ~ в пути раскрывается во всех скриптах одинаково: SKILL.md даёт корень вида ~/Desktop/...,
// а answers.json и args пишут его как есть — без раскрытия появлялся каталог с именем «~».
export const expandHome = (p) => String(p || '').replace(/^~(?=\/|$)/, process.env.HOME || '~')
export const resolveRoot = (p) => path.resolve(expandHome(p))

// Кавычки для пути в печатаемой команде: каталог с пробелом иначе ломает скопированную строку.
export function shq(s) {
  const v = String(s)
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : "'" + v.replace(/'/g, "'\\''") + "'"
}

export function isDir(p) { try { return fs.statSync(p).isDirectory() } catch { return false } }
export function isFile(p) { try { return fs.statSync(p).isFile() } catch { return false } }
export function readText(p) { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
export function readJson(p) {
  const t = readText(p)
  if (t == null) return null
  try { return JSON.parse(t) } catch { return null }
}

// ---------------------------------------------------------------- текст и числа

export const countWords = (t) => (t ? (t.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length : 0)
export const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  if (b === 1) return one
  return many
}

export const wordsRu = (n) => fmt(n) + ' ' + plural(n, 'слово', 'слова', 'слов')

// Локальная дата, а не UTC: сборка ночью по Москве иначе получает вчерашнее число.
export function todayISO() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

export const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))

// ---------------------------------------------------------------- контракт движка

// recon — разведка предмета на стадии брифа, до вопросов заказчику и до декомпозиции.
export const STAGES = ['recon', 'research', 'verify', 'synth', 'merge', 'critique', 'method', 'agent-doc']

// Префикс метки задачи по стадии. agent-doc делит префикс с method: обе пишут файлы финиша.
export const PREFIX_BY_STAGE = {
  recon: 'recon', research: 'research', verify: 'verify', synth: 'synth',
  merge: 'merge', critique: 'critique', method: 'method', 'agent-doc': 'method',
}

export const DEFAULT_FINISH = 'method'
export const DEFAULT_WORDS = { report: 3500, synthesis: 6000 }

// Нормы профилей: [темы от, темы до, своды от, своды до]. Те же числа стоят в таблице
// профилей SKILL.md — поправил здесь, поправь и там. Своды считаются вместе с частями
// банка фактов, навигатором и GAPS.md: так их и перечисляет engine.json.
export const PROFILE_NORM = { S: [5, 6, 3, 4], M: [8, 10, 6, 9], L: [13, 16, 10, 16] }

// Имя файла свода по метке, если в engine.json нет поля file: «field-spec» → FIELD-SPEC.md,
// «рынок» → РЫНОК.md. Буквы любого алфавита сохраняются: латинский фильтр превращал все
// кириллические метки в одно имя «.md», и своды перезаписывали друг друга.
export function defaultSynthFile(label) {
  const base = String(label || 'synthesis').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  return (base || 'SYNTHESIS') + '.md'
}

export const synthFileName = (s) => String(s.file || defaultSynthFile(s.label))

// Слаг темы и метка свода становятся частью имени файла задачи (research__<slug>.md) и метки
// в списке через запятую. Слэш уводит файл из каталога, запятая режет список, двойное
// подчёркивание ломает разбор «префикс__метка».
const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u
export function labelProblem(x) {
  const v = String(x == null ? '' : x)
  if (!v.trim()) return 'пустая метка'
  if (!LABEL_RE.test(v)) return '«' + v + '» — допустимы буквы, цифры и дефис; без пробелов, слэшей, запятых, точек и подчёркиваний'
  return ''
}

// GAPS.md стоит в syntheses как файл движка, но пишет его стадия critique, а не сводчик:
// primary ему не нужен, в стадию synth он не входит. Имя файла может быть своим.
export const isGaps = (s) => /^GAPS\.md$/i.test(String(s.file || '')) || String(s.label) === 'gaps'
// Навигатор банка фактов, собранного частями: primary у него — метки частей, а не темы.
export const isBankNav = (s) => /^FACTS-BANK\.md$/i.test(String(s.file || '')) || String(s.label) === 'facts-bank'
export const isBankPart = (s) => /^FACTS-BANK-/i.test(String(s.file || ''))

// Путь GAPS.md относительно корня: у записи gaps может быть своё имя файла, и методика
// с AGENT.md обязаны читать именно его.
export function gapsRelPath(syntheses) {
  const g = (syntheses || []).find(isGaps)
  return path.join('synthesis', g ? synthFileName(g) : 'GAPS.md')
}

// Списковые поля, которые в engine.json правят руками: строка вместо массива — частая ошибка,
// и раньше engine-init её принимал, а остальные скрипты молча игнорировали.
const TOPIC_LISTS = ['feeds', 'answers']
const SYNTH_LISTS = ['primary', 'secondary', 'parts']

// Приводит сырой engine.json к спискам, на которые опираются все скрипты. Не падает на
// отсутствующих необязательных полях и не теряет лишние: raw остаётся как был, списки
// в копиях записей приведены к массивам строк.
export function normalizeEngine(raw) {
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const lists = (o, keys) => {
    const out = { ...o }
    for (const k of keys) if (k in o) out[k] = strList(o[k])
    return out
  }
  const topics = (Array.isArray(e.topics) ? e.topics : [])
    .filter(t => t && typeof t === 'object' && t.slug != null && String(t.slug).trim())
    .map(t => lists({ ...t, slug: String(t.slug).trim() }, TOPIC_LISTS))
  const syntheses = (Array.isArray(e.syntheses) ? e.syntheses : [])
    .filter(s => s && typeof s === 'object' && (s.label || s.file))
    .map(s => lists(s.label ? { ...s, label: String(s.label).trim() } : { ...s, label: path.basename(String(s.file), '.md').toLowerCase() }, SYNTH_LISTS))
  return { raw: e, topics, syntheses }
}

// Банк фактов частями: навигатор и его части. Части берутся из primary/parts навигатора,
// а если их там нет — по имени файла FACTS-BANK-<часть>.md.
export function bankLayout(syntheses) {
  const entry = syntheses.find(isBankNav) || null
  const declared = entry
    ? [...strList(entry.primary), ...strList(entry.parts)]
        .map(l => syntheses.find(s => String(s.label) === l)).filter(Boolean)
    : []
  const parts = declared.length ? declared : syntheses.filter(isBankPart)
  return { entry, parts }
}

const isPartOf = (parts, s) => Boolean(s) && parts.some(p => String(p.label) === String(s.label))

// Согласованность матрицы «тема → свод» и меток. Возвращает предупреждения строками:
// их печатают engine-init, render-tasks (стадия synth) и audit (стадия prompts).
export function matrixFindings(engine) {
  const { topics, syntheses } = engine
  const out = []
  const { entry: bankEntry, parts: bankParts } = bankLayout(syntheses)
  const special = (s) => isGaps(s) || (bankParts.length > 0 && bankEntry && s.label === bankEntry.label)
  for (const t of topics) { const p = labelProblem(t.slug); if (p) out.push('слаг темы ' + p) }
  for (const s of syntheses) { const p = labelProblem(s.label); if (p) out.push('метка свода ' + p) }
  const seenTopic = new Set()
  for (const t of topics) {
    if (seenTopic.has(t.slug)) out.push('тема ' + t.slug + ' встречается в topics дважды')
    seenTopic.add(t.slug)
  }
  const files = new Map()
  for (const s of syntheses) {
    const f = synthFileName(s).toLowerCase()
    if (files.has(f)) out.push('своды ' + files.get(f) + ' и ' + s.label + ' пишут один файл synthesis/' + synthFileName(s) + ' — второй перезапишет первый; задай поле file')
    else files.set(f, s.label)
  }
  const byLabel = new Map(syntheses.map(s => [String(s.label), s]))
  for (const t of topics) {
    for (const f of strList(t.feeds)) {
      const s = byLabel.get(f)
      if (!s) { out.push('тема ' + t.slug + ' питает свод ' + f + ', которого нет в syntheses'); continue }
      if (special(s)) continue
      if (![...strList(s.primary), ...strList(s.secondary)].includes(t.slug)) {
        out.push('тема ' + t.slug + ' указывает в feeds свод ' + f + ', а в его primary и secondary её нет — сводчик прочитает её только точечно, как остальной корпус. Впиши тему в primary или secondary свода')
      }
    }
  }
  // Части банка фактов по роли берут весь корпус, а feeds темы перечисляет содержательные своды:
  // обратную сверку для частей не делаем, иначе каждая тема движка L даёт ложное предупреждение.
  for (const s of syntheses) {
    if (special(s) || isPartOf(bankParts, s)) continue
    for (const slug of strList(s.primary)) {
      const t = topics.find(x => x.slug === slug)
      if (t && strList(t.feeds).length && !strList(t.feeds).includes(String(s.label))) {
        out.push('свод ' + s.label + ' держит тему ' + slug + ' в primary, а в её feeds свода нет — матрица «тема → свод» расходится, поправь feeds темы')
      }
    }
  }
  return out
}

// Своды, которые собирает стадия synth: без GAPS.md (его пишет critique) и без навигатора
// банка, если банк собран частями (навигатор собирает merge).
export function synthStageEntries(syntheses) {
  const { entry, parts } = bankLayout(syntheses)
  return syntheses.filter(s => !isGaps(s) && !(parts.length && entry && s === entry))
}

// Канонический список меток задач стадии. Его же рендерит render-tasks.mjs — исполнитель
// и рендер обязаны видеть один и тот же набор, иначе fanout ищет файл задачи, которого нет.
export function stageLabels(stage, engine) {
  const { topics, syntheses } = engine
  if (stage === 'recon') return ['recon__field']
  if (stage === 'research' || stage === 'verify') return topics.map(t => stage + '__' + t.slug)
  if (stage === 'synth') return synthStageEntries(syntheses).map(s => 'synth__' + s.label)
  if (stage === 'merge') return ['merge__facts-bank']
  if (stage === 'critique') return ['critique__gaps']
  if (stage === 'method') return ['method__method']
  if (stage === 'agent-doc') return ['method__agent']
  return []
}

// ---------------------------------------------------------------- статусы по диску

// Статус — производная от файлов на диске, а не запись агента: Workflow-исполнители
// файловой системы не видят и engine.json не трогают. Тема researched — отчёт есть и агент
// дописал результат (иначе отчёт может быть недописан прямо сейчас), verified — в отчёте
// раздел «## Верификация». Свод done — файл на диске. Статус только повышается: понижение
// спрятало бы потерянный файл от audit.mjs, который как раз ловит «статус есть, файла нет».
export const TOPIC_RANK = { planned: 0, researched: 1, verified: 2 }
export const SYNTH_RANK = { planned: 0, done: 1 }

// ---------------------------------------------------------------- результаты агентов

// Схема возврата по префиксу метки задачи.
export const SCHEMA_BY_PREFIX = { recon: 'file', research: 'research', verify: 'verify', synth: 'file', merge: 'file', critique: 'gaps', method: 'file' }
const schemaCache = new Map()
export function stageSchema(root, label) {
  const name = SCHEMA_BY_PREFIX[String(label).split('__')[0]]
  if (!name) return null
  const key = root + '|' + name
  if (!schemaCache.has(key)) schemaCache.set(key, readJson(path.join(root, 'schemas', name + '.json')) || readJson(path.join(SKILL_DIR, 'schemas', name + '.json')))
  return schemaCache.get(key)
}

// Результат агента на диске. <label>.json агент пишет сам последним действием — он и есть
// отметка «работа сделана». Сырой возврат хоста <label>.raw.json fanout пишет и при провале
// (stdout с is_error), поэтому он засчитывается, только если сам по себе годный результат.
export function agentResult(root, label) {
  const dir = path.join(root, 'state', 'results')
  const p = path.join(dir, label + '.json')
  if (isFile(p)) return { path: p, data: readJson(p), mtimeMs: mtimeMs(p), raw: false }
  const r = path.join(dir, label + '.raw.json')
  const data = isFile(r) ? readJson(r) : null
  if (!data || data.is_error === true) return null
  const schema = stageSchema(root, label)
  if (schema && schemaProblems(data, schema).length) return null
  return { path: r, data, mtimeMs: mtimeMs(r), raw: true }
}

const STALE_REPORT_MS = 2 * 60 * 60 * 1000
const mtimeMs = (p) => { try { return fs.statSync(p).mtimeMs } catch { return 0 } }
const staleReport = (root, slug) => Date.now() - mtimeMs(path.join(root, 'reports', slug + '.md')) > STALE_REPORT_MS

export function diskState(raw, root) {
  const { topics, syntheses } = normalizeEngine(raw)
  const { entry: bankEntry, parts: bankParts } = bankLayout(syntheses)
  const result = (label) => agentResult(root, label) != null
  const problems = []
  const topicRows = topics.map(t => {
    const slug = String(t.slug)
    const text = readText(path.join(root, 'reports', slug + '.md'))
    const words = countWords(text)
    // Раздел верификации засчитывается, если его подписал верификатор: есть его результат
    // или в заголовке дата проверки. Ресерчер, назвавший раздел «## Верификация источников»,
    // иначе сам переводил тему в verified, и стадия верификации пропускалась.
    const { head, signed: verifyHead } = verificationOf(root, slug, words ? text : '')
    const researchDone = result('research__' + slug)
    const derived = verifyHead ? 'verified' : (words && (researchDone || staleReport(root, slug))) ? 'researched' : 'planned'
    const recorded = Object.prototype.hasOwnProperty.call(TOPIC_RANK, t.status) ? t.status : 'planned'
    if (TOPIC_RANK[recorded] > TOPIC_RANK[derived]) {
      problems.push(slug + ': в engine.json «' + recorded + '», а на диске ' +
        (!words ? 'нет отчёта' : head ? 'раздел «' + head.title + '» не подписан верификатором (нет результата verify__' + slug + ' и даты в заголовке)' : 'нет раздела «## Верификация»') +
        ' — файл потерян или записан не туда (audit.mjs покажет блокер)')
    }
    if (!words && researchDone) {
      problems.push(slug + ': результат research__' + slug + '.json есть, а отчёта нет — агент вернул путь, но файл не записан')
    }
    // Отчёт без результата агента: пока файл свежий — агент ещё пишет; через два часа без правок
    // это ручной трек или агент оборвался после записи — тема засчитывается, иначе status вечно
    // ждёт партию, которой нет.
    const reportPath = path.join(root, 'reports', slug + '.md')
    const stale = Boolean(words && !researchDone && !verifyHead) && Date.now() - mtimeMs(reportPath) > STALE_REPORT_MS
    if (stale) {
      problems.push(slug + ': отчёт без результата research__' + slug + '.json не менялся больше двух часов — засчитан как написанный (ручной трек или обрыв агента после записи); проверь, что он дописан до конца')
    } else if (words && !researchDone && !verifyHead) {
      problems.push(slug + ': отчёт на диске есть, а результата research__' + slug + '.json нет — агент ещё пишет или оборвался; статус не повышается')
    }
    if (words && !verifyHead && result('verify__' + slug)) {
      problems.push(slug + ': верификатор отчитался, а раздела «## Верификация» в отчёте нет — достройка не доехала до файла')
    }
    // отчёт пишется прямо сейчас или агент оборвался: в следующую партию его не ставим
    const inProgress = Boolean(words && !researchDone && !verifyHead && !stale)
    return { slug, recorded, derived, words, verifyLine: verifyHead ? verifyHead.line : 0, inProgress }
  })
  const synthRows = syntheses.map(s => {
    const file = synthFileName(s)
    const words = countWords(readText(path.join(root, 'synthesis', file)))
    const derived = words ? 'done' : 'planned'
    const recorded = s.status === 'done' ? 'done' : 'planned'
    if (recorded === 'done' && !words) {
      problems.push(s.label + ': в engine.json done, а файла synthesis/' + file + ' нет (audit.mjs покажет блокер)')
    }
    const role = isGaps(s) ? 'critique' : (bankParts.length && s === bankEntry) ? 'merge' : isPartOf(bankParts, s) ? 'bank' : 'synth'
    return { label: String(s.label), file, role, recorded, derived, words }
  })
  return { topicRows, synthRows, problems }
}

// Повышает статусы в raw по выведенным из диска; возвращает список изменений «метка было→стало».
export function upgradeStatuses(raw, state) {
  const changes = []
  const rawTopics = Array.isArray(raw.topics) ? raw.topics : []
  for (const r of state.topicRows) {
    const t = rawTopics.find(x => x && String(x.slug) === r.slug)
    if (t && TOPIC_RANK[r.derived] > TOPIC_RANK[r.recorded]) { changes.push(r.slug + ' ' + r.recorded + '→' + r.derived); t.status = r.derived; r.recorded = r.derived }
  }
  const rawSynth = Array.isArray(raw.syntheses) ? raw.syntheses : []
  for (const r of state.synthRows) {
    const s = rawSynth.find(x => x && String(x.label || path.basename(String(x.file || ''), '.md').toLowerCase()) === r.label)
    if (s && SYNTH_RANK[r.derived] > SYNTH_RANK[r.recorded]) { changes.push(r.label + ' ' + r.recorded + '→' + r.derived); s.status = r.derived; r.recorded = r.derived }
  }
  return changes
}

// Запись engine.json через временный файл: оборванная запись не оставит битый файл.
export function writeEngineJson(root, raw) {
  const p = path.join(root, 'engine.json')
  const tmp = p + '.tmp-' + process.pid
  try {
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, p)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* нечего убирать */ }
    throw e
  }
}

// Сверка статусов с диском и запись, если что-то повысилось. who — кто сверял (в журнал).
export function syncStatuses(root, raw, who) {
  const state = diskState(raw, root)
  const changes = upgradeStatuses(raw, state)
  if (changes.length) {
    writeEngineJson(root, raw)
    try {
      appendRunLogRow(root, [todayISO(), 'status', '—', changes.map(c => c.split(' ')[0]).join(', '),
        'статусов обновлено: ' + changes.length, who + ': ' + changes.join('; ')])
    } catch { /* журнал не критичен: статусы уже записаны */ }
  }
  return { state, changes }
}

// ---------------------------------------------------------------- цена прогона

// Средний расход токенов на одного агента по ключу маршрута — замеры живых прогонов.
// Как только в engine.json появляются свои записи runs, оценка берётся из них.
export const TOKENS_PER_AGENT = {
  recon: { tokens: 160000, basis: 'замер aso-growth 14.10.2026: 1 агент sonnet, 159 тыс.' },
  research: { tokens: 460000, basis: 'замер aso-growth 14.10.2026: партия ресерча 8 агентов sonnet+opus, 3,67 млн' },
  verify: { tokens: 460000, basis: 'тот же замер: ресерчер и верификатор в партии не разделены' },
  synth: { tokens: 400000, basis: 'без замера' },
  bank: { tokens: 400000, basis: 'без замера' },
  merge: { tokens: 300000, basis: 'без замера' },
  critique: { tokens: 400000, basis: 'без замера' },
  method: { tokens: 400000, basis: 'без замера' },
  'agent-doc': { tokens: 150000, basis: 'без замера' },
}
// Записи runs по стадии кормят ключи маршрута: партия research — это ресерчер и верификатор.
const RUN_KEYS = { research: ['research', 'verify'], verify: ['verify'], synth: ['synth', 'bank'] }

// Сколько агентов ещё нужно движку по ключам маршрута.
// finish — какие файлы финиша уже на диске: { method: bool, agent: bool }.
export function remainingAgents(raw, state, finish = {}) {
  const n = {}
  const add = (k, c = 1) => { n[k] = (n[k] || 0) + c }
  for (const r of state.topicRows) {
    if (r.derived === 'planned') { add('research'); add('verify') } else if (r.derived === 'researched') add('verify')
  }
  for (const r of state.synthRows) {
    if (r.derived === 'done') continue
    if (r.role === 'bank') add('bank')
    else if (r.role === 'synth') add('synth')
    else if (r.role === 'merge') add('merge')
    else if (r.role === 'critique') add('critique')
  }
  if (!state.synthRows.some(r => r.role === 'critique')) add('critique')
  // разведка нужна профилям M и L до декомпозиции; на диске её след — brief/RECON.md
  if (finish.recon === false && ['M', 'L'].includes(String(raw.profile || '').toUpperCase())) add('recon')
  if (String(raw.finish || DEFAULT_FINISH) === 'method') {
    if (!finish.method) add('method')
    if (!finish.agent) add('agent-doc')
  }
  return n
}

export function estimateCost(raw, state, root) {
  const runs = Array.isArray(raw.runs) ? raw.runs : []
  const own = {}
  for (const r of runs) {
    const agents = Number(r && r.agents), tokens = Number(r && r.tokens)
    if (!(agents > 0 && tokens > 0)) continue
    for (const k of RUN_KEYS[r.stage] || [r.stage]) {
      own[k] = own[k] || { agents: 0, tokens: 0 }
      own[k].agents += agents
      own[k].tokens += tokens
    }
  }
  const finishDone = (name) => countWords(readText(path.join(root, name))) > 0
  const need = remainingAgents(raw, state, { method: finishDone('METHOD.md'), agent: finishDone('AGENT.md'), recon: countWords(readText(path.join(root, 'brief', 'RECON.md'))) > 0 })
  const rows = Object.entries(need).map(([key, agents]) => {
    const m = own[key]
    const per = m ? Math.round(m.tokens / m.agents) : (TOKENS_PER_AGENT[key] || { tokens: 400000 }).tokens
    const basis = m ? 'свои прогоны движка: ' + m.agents + ' агентов' : (TOKENS_PER_AGENT[key] || { basis: 'без замера' }).basis
    return { key, agents, perAgent: per, tokens: per * agents, basis }
  })
  return { rows, agents: rows.reduce((a, r) => a + r.agents, 0), tokens: rows.reduce((a, r) => a + r.tokens, 0) }
}

// Запись фактического расхода партии в engine.json (runs). Читает файл заново: между стартом
// партии и её концом его могли переписать render-tasks или status. Возвращает запись.
export function recordRun(root, rec) {
  const p = path.join(root, 'engine.json')
  const raw = readJson(p)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('engine.json не читается: ' + p)
  const entry = {
    date: rec.date || todayISO(), stage: rec.stage, host: rec.host || 'claude',
    labels: Array.isArray(rec.labels) ? rec.labels : [], agents: Number(rec.agents) || 0,
    tokens: Number(rec.tokens) > 0 ? Number(rec.tokens) : null, minutes: Number(rec.minutes) > 0 ? Number(rec.minutes) : null,
    note: rec.note || '',
  }
  raw.runs = Array.isArray(raw.runs) ? raw.runs : []
  raw.runs.push(entry)
  writeEngineJson(root, raw)
  return entry
}

// ---------------------------------------------------------------- модели по стадиям

// Какой модели отдавать задачу. Правило: суждение и проверка — сильнейшей модели (верификатор,
// сводчик плейбуков, критик, автор методики); объём с веб-поиском и перенос без сжатия —
// средней (разведка, ресерч, части банка фактов, навигатор, AGENT.md). Маленькая модель по
// умолчанию не стоит нигде: каждая стадия либо судит, либо переносит большой текст без потерь,
// а это ровно то, в чём она слабее всего. Переопределяется полями models и efforts в engine.json.
export const DEFAULT_MODELS = {
  recon: 'sonnet', research: 'sonnet', verify: 'opus', synth: 'opus', bank: 'sonnet',
  merge: 'sonnet', critique: 'opus', method: 'opus', 'agent-doc': 'sonnet',
}
export const DEFAULT_EFFORTS = {
  recon: 'medium', research: 'high', verify: 'high', synth: 'high', bank: 'medium',
  merge: 'medium', critique: 'high', method: 'high', 'agent-doc': 'medium',
}
export const ROUTE_KEYS = Object.keys(DEFAULT_MODELS)

// Тот же маршрут для Codex: псевдонимы Claude (opus, sonnet) кодексу не годятся. Правило то же —
// суждение и проверка на frontier-модели, объём и перенос на рабочей лошадке. Имена моделей
// сверены с каталогом codex-cli 0.159.3 (codex debug models, 15.10.2026): gpt-6-astra —
// «frontier intelligence», gpt-6.1-sol — «latest workhorse». Без маршрута codex берёт модель
// и усилие из ~/.codex/config.toml — часто frontier с xhigh на каждом агенте, дорого и медленно.
// Переопределяется полями codexModels и codexEfforts в engine.json.
export const CODEX_DEFAULT_MODELS = {
  recon: 'gpt-6.1-sol', research: 'gpt-6.1-sol', verify: 'gpt-6-astra', synth: 'gpt-6-astra', bank: 'gpt-6.1-sol',
  merge: 'gpt-6.1-sol', critique: 'gpt-6-astra', method: 'gpt-6-astra', 'agent-doc': 'gpt-6.1-sol',
}
export const CODEX_DEFAULT_EFFORTS = { ...DEFAULT_EFFORTS }
export const HOSTS = ['claude', 'codex']

// Части банка фактов идут отдельным ключом bank: перенос тысяч строк таблиц требует
// аккуратности, а не суждения, и на сильнейшей модели это дорого без выигрыша. Часть —
// это запись из раскладки банка (primary/parts навигатора), а не только файл FACTS-BANK-*.
export function routeKey(stage, synthEntry, syntheses) {
  if (stage !== 'synth' || !synthEntry) return stage
  const parts = syntheses ? bankLayout(syntheses).parts : []
  return isPartOf(parts, synthEntry) || isBankPart(synthEntry) ? 'bank' : stage
}

// host — claude (models/efforts) или codex (codexModels/codexEfforts); у каждого свои умолчания.
export function routeFor(raw, stage, synthEntry, host = 'claude') {
  const key = routeKey(stage, synthEntry, normalizeEngine(raw).syntheses)
  const pick = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {})
  const codex = host === 'codex'
  const m = pick(raw && (codex ? raw.codexModels : raw.models))
  const ef = pick(raw && (codex ? raw.codexEfforts : raw.efforts))
  const dm = codex ? CODEX_DEFAULT_MODELS : DEFAULT_MODELS
  const de = codex ? CODEX_DEFAULT_EFFORTS : DEFAULT_EFFORTS
  return { key, model: String(m[key] || dm[key] || ''), effort: String(ef[key] || de[key] || '') }
}

// Стадия по метке задачи: research__x → research, method__agent → agent-doc.
export function stageOfLabel(label) {
  const [prefix, rest] = String(label).split('__')
  if (prefix === 'method') return rest === 'agent' ? 'agent-doc' : 'method'
  return prefix
}

// Аргументы Workflow-исполнителя для партии: модели и усилия считаются здесь, из engine.json,
// потому что сам исполнитель файловой системы не видит. shortLabels — метки без префикса стадии.
export function workflowArgs(raw, root, stage, shortLabels) {
  const { syntheses } = normalizeEngine(raw)
  const models = {}
  const efforts = {}
  if (stage === 'research' || stage === 'verify') {
    for (const k of stage === 'research' ? ['research', 'verify'] : ['verify']) {
      const r = routeFor(raw, k)
      models[k] = r.model
      efforts[k] = r.effort
    }
    return { root, ...(stage === 'verify' ? { stage: 'verify' } : {}), labels: shortLabels, models, efforts }
  }
  for (const l of shortLabels) {
    const r = routeFor(raw, stage, syntheses.find(s => String(s.label) === l))
    models[l] = r.model
    efforts[l] = r.effort
  }
  return { root, stage, labels: shortLabels, models, efforts }
}

// ---------------------------------------------------------------- бриф

// Бриф отвечает на вопрос «какую работу делает база» до того, как тема режется на ТЗ.
// Его сердце — контрольные вопросы: на что готовая база обязана отвечать. По ним
// декомпозиция назначает темы (topics[].answers), ресерчер знает, ради чего копает,
// критик проверяет готовность, методика даёт адрес ответа. Методика брифа — references/BRIEF.md.

const BRIEF_LISTS = ['users', 'jobs', 'decisions', 'deliverables', 'assumptions', 'constraints', 'known', 'openQuestions']

export const strList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim()).filter(Boolean)

export const MISSION_STUB_RE = /^ЗАПОЛНИТЬ/i

export function normalizeBrief(raw) {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const out = {
    request: String(b.request || '').trim(),
    restated: String(b.restated || '').trim(),
    freshness: String(b.freshness || '').trim(),
  }
  for (const k of BRIEF_LISTS) out[k] = strList(b[k])
  // Контрольный вопрос — строка или { id, question, job }. Без id получает A<n> по порядку;
  // brief.mjs --write записывает выданные id обратно, чтобы topics[].answers не съехали.
  // Явные id занимаются первыми: иначе вопрос без id в начале списка забирал чужой A1,
  // и темы молча начинали отвечать не на тот вопрос. index — позиция в исходном массиве.
  const items = (Array.isArray(b.acceptance) ? b.acceptance : []).map((a, index) => {
    const obj = a && typeof a === 'object' && !Array.isArray(a) ? a : {}
    const question = String(typeof a === 'string' ? a : obj.question || obj.q || '').trim()
    return { index, question, job: String(obj.job || '').trim(), given: String(obj.id || '').trim() }
  }).filter(a => a.question)
  const used = new Set()
  for (const a of items) {
    if (a.given && !used.has(a.given)) { a.id = a.given; used.add(a.given) }
  }
  for (const a of items) {
    if (a.id) continue
    let n = a.index + 1
    while (used.has('A' + n)) n++
    a.id = 'A' + n
    used.add(a.id)
  }
  out.acceptance = items.map(a => ({ id: a.id, question: a.question, job: a.job, autoId: a.id !== a.given, index: a.index }))
  out.inputs = (Array.isArray(b.inputs) ? b.inputs : [])
    .map(x => (typeof x === 'string' ? { ref: x } : x))
    .filter(x => x && x.ref)
    .map(x => ({ ref: String(x.ref).trim(), kind: String(x.kind || '').trim(), use: String(x.use || '').trim(), trust: String(x.trust || '').trim() }))
  const src = b.sources && typeof b.sources === 'object' && !Array.isArray(b.sources) ? b.sources : {}
  out.sources = { must: strList(src.must), avoid: strList(src.avoid) }
  return out
}

// Закрепляет выданные id в исходном массиве brief.acceptance, сохраняя остальные поля
// вопроса (priority, source…): пересборка из нормализованных записей их теряла.
export function pinAcceptanceIds(rawList, normalized) {
  const byIndex = new Map(normalized.map(a => [a.index, a]))
  return (Array.isArray(rawList) ? rawList : []).map((a, i) => {
    const n = byIndex.get(i)
    if (!n) return a
    return a && typeof a === 'object' && !Array.isArray(a) ? { ...a, id: n.id } : { id: n.id, question: n.question }
  })
}

// Какие контрольные вопросы закрыты темами: topics[].answers — id вопросов, ради которых тема заведена.
export function acceptanceCoverage(brief, topics) {
  const ids = new Set(brief.acceptance.map(a => a.id))
  const map = Object.fromEntries(brief.acceptance.map(a => [a.id, []]))
  const unknown = []
  for (const t of topics) {
    for (const id of strList(t.answers)) {
      if (ids.has(id)) map[id].push(String(t.slug))
      else unknown.push({ topic: String(t.slug), id })
    }
  }
  return { map, uncovered: brief.acceptance.filter(a => !map[a.id].length).map(a => a.id), unknown }
}

// Готов ли бриф к декомпозиции. Блокер — без него темы режутся вслепую; предупреждение —
// бриф слабее, чем мог бы быть. root нужен, чтобы увидеть разведку на диске.
export function briefFindings(raw, root) {
  const e = raw && typeof raw === 'object' ? raw : {}
  const b = normalizeBrief(e.brief)
  const blockers = []
  const warnings = []
  const mission = String(e.mission || '').trim()
  const perim = e.perimeter || {}
  if (!e.brief) blockers.push('в engine.json нет брифа (поле brief) — работа базы и контрольные вопросы не заданы')
  if (!b.request && !b.restated) blockers.push('нет исходного запроса (brief.request) — не с чем сверять, туда ли ушла база')
  if (!b.jobs.length) blockers.push('не названа работа базы (brief.jobs): что по ней будут делать — без этого темы режутся по оглавлению учебника')
  if (!b.acceptance.length) blockers.push('нет контрольных вопросов (brief.acceptance) — нечем проверить, что база готова')
  else if (b.acceptance.length < 5) warnings.push('контрольных вопросов ' + b.acceptance.length + ' — норма 5–15: меньше пяти обычно значит, что работа базы описана слишком общо')
  else if (b.acceptance.length > 20) warnings.push('контрольных вопросов ' + b.acceptance.length + ' — больше двадцати: проверь, не смешаны ли две разные базы')
  if (!mission || MISSION_STUB_RE.test(mission)) blockers.push('миссия не написана (mission) — она уходит дословно в каждый промпт')
  if (!strList(perim.out).length) blockers.push('пустой perimeter.out — периметр без исключений не удерживает агентов от расползания')
  if (!strList(perim.in).length) blockers.push('пустой perimeter.in')
  if (!b.restated) warnings.push('нет переформулировки запроса (brief.restated) — заказчик не видел, как его поняли')
  if (!b.users.length) warnings.push('не названо, кто работает по базе (brief.users): человек, агент или оба — от этого зависит форма сводов')
  if (!b.inputs.length && !b.known.length) warnings.push('материалы заказчика не собраны (brief.inputs) и не записано, что он уже знает (brief.known) — спроси, что у него есть, прежде чем искать заново')
  if (!b.freshness) warnings.push('не задана свежесть (brief.freshness): на какую дату и как быстро портится предмет')
  if (b.openQuestions.length) warnings.push('открытых вопросов к заказчику: ' + b.openQuestions.length + ' — закрой их или явно прими допущением')
  if (root && ['M', 'L'].includes(String(e.profile || '').toUpperCase()) && !isFile(path.join(root, 'brief', 'RECON.md'))) {
    warnings.push('профиль ' + e.profile + ', а разведки нет (brief/RECON.md) — вопросы заказчику задаются вслепую; стадия recon')
  }
  for (const a of b.acceptance) {
    if (!a.job && b.jobs.length > 1) { warnings.push('контрольные вопросы не привязаны к работам (acceptance[].job) — не видно, какая работа без ответа'); break }
  }
  return { brief: b, blockers, warnings }
}

// ---------------------------------------------------------------- бриф в тексте промптов

const bullets = (list) => list.map(x => '- ' + x).join('\n')

export function jobsText(b, empty = 'работа базы в брифе не описана — опирайся на миссию') {
  const parts = []
  if (b.users.length) parts.push('- **Кто работает по базе:** ' + b.users.join('; '))
  if (b.jobs.length) parts.push('- **Работа, которую она обслуживает:**\n' + b.jobs.map(j => '  - ' + j).join('\n'))
  if (b.deliverables.length) parts.push('- **Что производят по базе:** ' + b.deliverables.join('; '))
  if (b.decisions.length) parts.push('- **Решения, которые по ней принимают:** ' + b.decisions.join('; '))
  return parts.length ? parts.join('\n') : '- ' + empty
}

export function acceptanceText(list, empty) {
  return list.length ? list.map(a => '- **' + a.id + '.** ' + a.question + (a.job ? ' _(работа: ' + a.job + ')_' : '')).join('\n') : '- ' + empty
}

export function inputsText(b, root) {
  if (!b.inputs.length) return '- материалов заказчика нет: всё ищется в открытых источниках'
  return b.inputs.map(x => {
    const r = expandHome(x.ref)
    const ref = /^[a-z]+:\/\//i.test(r) || path.isAbsolute(r) ? r : path.join(root, r)
    return '- `' + ref + '`' + (x.kind ? ' — ' + x.kind : '') + (x.use ? '; как использовать: ' + x.use : '') + (x.trust ? '; доверие: ' + x.trust : '')
  }).join('\n')
}

export function sourcesText(b) {
  const parts = []
  if (b.sources.must.length) parts.push('- **Открыть обязательно:** ' + b.sources.must.join('; '))
  if (b.sources.avoid.length) parts.push('- **Не опираться на:** ' + b.sources.avoid.join('; '))
  if (b.known.length) parts.push('- **Заказчик уже знает** (не пересказывай — проверь и углуби): ' + b.known.join('; '))
  if (b.freshness) parts.push('- **Свежесть:** ' + b.freshness)
  return parts.length ? parts.join('\n') : '- особых требований к источникам в брифе нет — работай по шкале доказательности'
}

// BRIEF.md — человеческий вид брифа. Собирается из engine.json целиком, руками не правится.
export function renderBriefMd(raw, root, topics) {
  const e = raw && typeof raw === 'object' ? raw : {}
  const b = normalizeBrief(e.brief)
  const perim = e.perimeter || {}
  const none = '— не задано'
  const list = (l) => (l.length ? bullets(l) : none)
  const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'
  const cov = acceptanceCoverage(b, topics || [])
  const out = []
  out.push('# Бриф движка «' + (e.title || e.slug || '') + '» (`' + (e.slug || '') + '`)', '')
  out.push('> Какую работу делает база и по каким вопросам проверяется её готовность. Машиночитаемая копия — `brief` в `engine.json`; этот файл собирает `brief.mjs --write`, руками его не правят. Бриф утверждает заказчик до декомпозиции.', '')
  out.push('## Исходный запрос', '', b.request ? b.request.split('\n').map(l => '> ' + l).join('\n') : none, '')
  out.push('## Как мы его поняли', '', b.restated || none, '')
  out.push('## Кто работает по базе', '', list(b.users), '')
  out.push('## Работа базы', '', list(b.jobs), '')
  out.push('**Что производят по базе:**', '', list(b.deliverables), '')
  out.push('**Решения, которые по ней принимают:**', '', list(b.decisions), '')
  out.push('## Контрольные вопросы', '')
  out.push('Готовая база обязана отвечать на каждый. По ним декомпозиция назначает темы, критик полноты проверяет готовность, методика даёт адрес ответа.', '')
  if (b.acceptance.length) {
    out.push('| ID | Вопрос | Работа | Темы |', '|---|---|---|---|')
    for (const a of b.acceptance) out.push('| ' + a.id + ' | ' + cell(a.question) + ' | ' + cell(a.job) + ' | ' + (cov.map[a.id].length ? cov.map[a.id].join(', ') : '—') + ' |')
  } else out.push(none)
  out.push('')
  out.push('## Периметр', '', '**Внутри:** ' + (strList(perim.in).join('; ') || none), '', '**Вне:** ' + (strList(perim.out).join('; ') || none), '')
  out.push('## Свежесть и рамки', '', '**Свежесть:** ' + (b.freshness || none), '', '**Ограничения:**', '', list(b.constraints), '')
  out.push('## Что заказчик уже знает', '', list(b.known), '')
  out.push('## Материалы заказчика', '')
  if (b.inputs.length) {
    out.push('| Материал | Что это | Как использовать | Доверие |', '|---|---|---|---|')
    for (const x of b.inputs) out.push('| `' + cell(x.ref) + '` | ' + cell(x.kind) + ' | ' + cell(x.use) + ' | ' + cell(x.trust) + ' |')
  } else out.push(none)
  out.push('')
  out.push('## Источники', '', '**Открыть обязательно:**', '', list(b.sources.must), '', '**Не опираться на:**', '', list(b.sources.avoid), '')
  out.push('## Допущения', '', list(b.assumptions), '')
  out.push('## Открытые вопросы', '', list(b.openQuestions), '')
  out.push('## Миссия', '', 'Уходит дословно в каждый промпт конвейера.', '', String(e.mission || '').trim() || none, '')
  out.push('## Профиль и финиш', '', 'Профиль `' + (e.profile || '?') + '`, финиш `' + (e.finish || DEFAULT_FINISH) + '`, язык `' + (e.language || 'ru') + '`.', '')
  return out.join('\n')
}

// ---------------------------------------------------------------- копии исполнителей

// engine-init кладёт в корень движка копии workflows/*.mjs и schemas/*.json, чтобы путь
// исполнителя был стабильным. После обновления плагина копии отстают: старый research.mjs
// не знает args.stage = 'verify' и вместо одной верификации заново пишет отчёт с нуля.
// Копии — производные файлы скилла, руками их не правят, поэтому их освежает render-tasks.
const TOOLCHAIN = [['workflows', '.mjs'], ['schemas', '.json']]

export function toolchainDrift(root, skillDir) {
  const out = []
  for (const [dir, ext] of TOOLCHAIN) {
    let files = []
    try { files = fs.readdirSync(path.join(skillDir, dir)).filter(f => f.endsWith(ext)).sort() } catch { continue }
    for (const f of files) {
      const src = path.join(skillDir, dir, f)
      const dst = path.join(root, dir, f)
      const want = readText(src)
      if (want == null) continue
      const have = readText(dst)
      if (have == null) out.push({ src, dst, rel: path.join(dir, f), state: 'missing', text: want })
      else if (have !== want) out.push({ src, dst, rel: path.join(dir, f), state: 'stale', text: want })
    }
  }
  return out
}

export function syncToolchain(root, skillDir) {
  const drift = toolchainDrift(root, skillDir)
  for (const d of drift) {
    fs.mkdirSync(path.dirname(d.dst), { recursive: true })
    fs.writeFileSync(d.dst, d.text, 'utf8')
  }
  return drift.map(d => d.rel + (d.state === 'missing' ? ' (добавлен)' : ' (обновлён)'))
}

// ---------------------------------------------------------------- журнал прогонов

const RUN_LOG_HEADER = ['| Дата | Стадия | Хост | Задачи | Итог | Заметка |', '|---|---|---|---|---|---|']
const logCell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '—'

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Эксклюзивная блокировка файла на время «прочитал — вставил строку — записал». Без неё
// два процесса, дописывающие журнал одновременно (fanout и status), теряли строки.
// В файле блокировки — pid владельца: блокировку убитого процесса забирают сразу, а не
// по таймауту; живую держат не дольше 5 с (запись строки занимает миллисекунды).
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function withLock(target, fn) {
  const lock = target + '.lock'
  const deadline = Date.now() + 10000
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx')
      try { fs.writeSync(fd, String(process.pid)) } finally { fs.closeSync(fd) }
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let owner = '', age = 0
      try { owner = fs.readFileSync(lock, 'utf8').trim(); age = Date.now() - fs.statSync(lock).mtimeMs } catch { continue }
      const pid = Number(owner)
      const dead = owner && Number.isInteger(pid) && pid > 0 && !alive(pid)
      if (dead || age > 5000) {
        // снимаем, только если это всё ещё та же блокировка, которую признали протухшей
        try { if (fs.readFileSync(lock, 'utf8').trim() === owner) fs.rmSync(lock, { force: true }) } catch { /* уже снята */ }
        continue
      }
      if (Date.now() > deadline) throw new Error('файл занят другим процессом дольше 10 с: ' + lock + ' — если процесса нет, удали блокировку')
      sleepSync(25)
    }
  }
  try { return fn() } finally { try { fs.rmSync(lock, { force: true }) } catch { /* уже снята */ } }
}

// Атомарная запись текста: временный файл и переименование.
function writeAtomic(p, text) {
  const tmp = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, p)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* нечего убирать */ }
    throw e
  }
}

// Строка журнала встаёт в конец таблицы, а не в конец файла: под таблицей в run-log.md
// стоит подвал, и дописанная после него строка выпадает из таблицы.
// cells: [дата, стадия, хост, задачи, итог, заметка]. Бросает исключение при ошибке записи.
export function appendRunLogRow(root, cells) {
  const p = path.join(root, 'state', 'run-log.md')
  const row = '| ' + cells.map(logCell).join(' | ') + ' |'
  fs.mkdirSync(path.dirname(p), { recursive: true })
  withLock(p, () => {
    const text = readText(p)
    let out
    if (text == null) {
      out = '# Журнал прогонов\n\n' + RUN_LOG_HEADER.join('\n') + '\n' + row + '\n'
    } else {
      const lines = text.split('\n')
      const head = lines.findIndex(l => /^\|\s*Дата\s*\|/.test(l))
      if (head < 0) {
        out = text.replace(/\n*$/, '\n\n') + RUN_LOG_HEADER.join('\n') + '\n' + row + '\n'
      } else {
        let end = head + 1
        while (end < lines.length && /^\|/.test(lines[end])) end++
        lines.splice(end, 0, row)
        out = lines.join('\n')
      }
    }
    writeAtomic(p, out)
  })
  return p
}

// ---------------------------------------------------------------- закон конвейера по стадиям

// Тексты закона — общие для fanout и Workflow-исполнителей: исполнители файловой системы не
// видят и держат копии, тест сверяет копии с этими строками. Навигаторы (банк-навигатор,
// METHOD.md, AGENT.md) короче корпуса по природе: для них закон звучит «ничего не теряй —
// адресуй», а не «ничего не сокращай», иначе он спорит с объёмом из файла задачи.
export const LAWS = {
  pipeline: 'Закон конвейера: ни один шаг не сжимает содержание. Отчёт полнее своего ТЗ, свод — надмножество относящихся к нему отчётов, методика — навигатор поверх сводов. Ступени, которая вернёт выброшенное, в конвейере нет: всё, что ты опустишь «для краткости», потеряно навсегда. Единственное допустимое сокращение — склейка дословных повторов между источниками с пометкой «подтверждено N отчётами».',
  navigator: 'Закон конвейера для навигатора: ты пишешь документ поверх полного корпуса, и короче корпуса он быть вправе, но ничего не теряя. Данные не переписываются и не пересказываются, а адресуются: каждое утверждение — со ссылкой на файл и раздел, где лежит полная версия; число — с адресом полной строки в банке фактов. Объём и форму держи по файлу задачи.',
  recon: 'Закон разведки: ширина важнее глубины, а точность важнее объёма. У каждого названного источника — URL, у каждой цифры — дата и URL; объём держи в рамках задачи: разведка — карта, а не отчёт, глубину даст конвейер.',
}
export function lawFor(stage) {
  if (stage === 'recon') return LAWS.recon
  if (stage === 'merge' || stage === 'method' || stage === 'agent-doc') return LAWS.navigator
  return LAWS.pipeline
}

// ---------------------------------------------------------------- проверка результата по схеме

// Минимальная проверка JSON по схемам движка (schemas/*.json): обязательные ключи, закрытый
// набор ключей, типы и enum первого уровня. Этого хватает схемам движка; общий валидатор
// JSON Schema скрипту без зависимостей не нужен. Возвращает список нарушений.
export function schemaProblems(obj, schema) {
  const out = []
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['результат не JSON-объект']
  const props = (schema && schema.properties) || {}
  for (const k of (schema && schema.required) || []) if (!(k in obj)) out.push('нет ключа ' + k)
  if (schema && schema.additionalProperties === false) {
    for (const k of Object.keys(obj)) if (!(k in props)) out.push('лишний ключ ' + k)
  }
  const typeOk = (v, t) => (t === 'array' ? Array.isArray(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
    : t === 'integer' ? Number.isInteger(v) : t === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === t)
  for (const [k, p] of Object.entries(props)) {
    if (!(k in obj) || !p) continue
    const v = obj[k]
    if (p.type && !typeOk(v, p.type)) { out.push(k + ': ждали ' + p.type); continue }
    if (Array.isArray(p.enum) && !p.enum.includes(v)) out.push(k + ': значение «' + v + '» не из ' + p.enum.join(' | '))
    if (p.type === 'array' && p.items && p.items.type && v.some(x => !typeOk(x, p.items.type))) out.push(k + ': элементы не ' + p.items.type)
  }
  return out
}

// ---------------------------------------------------------------- разбор markdown

export function codeFenceMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; mask[i] = true; continue }
    mask[i] = inFence
  }
  return mask
}

// Inline-код заменяется пробелами той же длины: позиции в строке сохраняются, а паттерны
// вида `[a-z](x)` внутри обратных кавычек перестают выглядеть как markdown-ссылки.
export const maskInlineCode = (line) => line.replace(/(`+)([^`]|[^`].*?[^`])\1/g, (m) => ' '.repeat(m.length))

export function headings(text, maxDepth = 6) {
  const lines = String(text).split('\n')
  const mask = codeFenceMask(lines)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (m && m[1].length <= maxDepth) out.push({ line: i + 1, level: m[1].length, title: m[2] })
  }
  return out
}

// Раздел верификации ищется по смыслу: живой прогон показал, что агент пишет и
// «## 8. Протокол верификации от <дата>», хотя шаблон требует «## Верификация (<дата>)».
// Только второй уровень: подраздел «### Верификация источников» в теле отчёта — не протокол.
// Из нескольких таких разделов берётся последний датированный, иначе последний: верификатор
// дописывает свой в конец, а раньше в отчёте может стоять раздел ресерчера.
export function findVerificationHeading(text) {
  const all = headings(text, 2).filter(h => h.level === 2 && /^(\d+[.)]\s*)?(протокол\s+)?верификаци/i.test(h.title))
  const dated = all.filter(h => /\d{4}-\d{2}-\d{2}/.test(h.title))
  return dated[dated.length - 1] || all[all.length - 1] || null
}

// Верификация засчитывается, если раздел подписан верификатором: есть его результат
// state/results/verify__<slug>.json или в заголовке дата проверки. Ресерчер, назвавший свой
// раздел «## Верификация источников», иначе сам переводил тему в verified, и стадия
// верификации пропускалась. head — найденный заголовок, signed — он же, если подписан.
// Результат верификатора, оставшийся от прогона до нового ресерча, отчёт не подписывает:
// он должен быть не старше результата ресерчера.
export function verificationOf(root, slug, text) {
  const head = text ? findVerificationHeading(text) : null
  if (!head) return { head: null, signed: null }
  const v = agentResult(root, 'verify__' + slug)
  const r = agentResult(root, 'research__' + slug)
  const fresh = Boolean(v) && (!r || v.mtimeMs >= r.mtimeMs)
  return { head, signed: fresh || /\d{4}-\d{2}-\d{2}/.test(head.title) ? head : null }
}

export const meta = {
  name: 'research-engine-research',
  description: 'Стадия ресерча движка: агент на тему пишет полный отчёт по файлу задачи, верификатор проверяет числа и достраивает тот же отчёт',
  whenToUse: 'После того как render-tasks.mjs отрендерил state/tasks/. args: { root: "/abs/path/<slug>-engine", labels: ["01-slug", "02-slug"], verify?: true, effort?: "high", schemas?: {} }. Партия — 3-4 темы за вызов: девять тяжёлых агентов разом выжигают лимит сессии.',
  phases: [
    { title: 'Research', detail: 'агент на тему читает state/tasks/research__<slug>.md и пишет полный отчёт в reports/' },
    { title: 'Verify', detail: 'верификатор читает state/tasks/verify__<slug>.md, перепроверяет числа и достраивает тот же отчёт' },
  ],
}

let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = null } }
A = A || {}

const RAW_ROOT = String(A.root || '').trim()
if (!RAW_ROOT) throw new Error('Не задан args.root — абсолютный путь корня движка, например /Users/me/Desktop/Projects/skills/foo-engine')
if (RAW_ROOT.charAt(0) !== '/') throw new Error('args.root обязан быть абсолютным путём со слэша в начале, пришло: ' + RAW_ROOT + '. Агент работает без гарантий рабочего каталога и относительный путь не найдёт.')
const ROOT = RAW_ROOT.replace(/\/+$/, '')
if (!ROOT) throw new Error('args.root = / — это не корень движка. Передай каталог движка, например /Users/me/Desktop/Projects/skills/foo-engine')

const labels = [...new Set((Array.isArray(A.labels) ? A.labels : []).map(x => String(x).trim().replace(/^(research|verify)__/, '')).filter(Boolean))]
if (!labels.length) {
  throw new Error('Пустой args.labels. Передай слаги тем из engine.json, например { root: "' + ROOT + '", labels: ["01-first-topic", "02-second-topic"] }. Файлы задач должны быть уже отрендерены: node scripts/render-tasks.mjs --root ' + ROOT + ' --stage research')
}

const WITH_VERIFY = A.verify !== false && A.verify !== 'false' && A.verify !== 0
const EFFORT = A.effort || 'high'
const OVERRIDE = A.schemas || {}

const RESEARCH_SCHEMA = OVERRIDE.research || {
  type: 'object',
  description: 'Возврат агента-ресерчера стадии research. Пишется агентом в state/results/research__<topic-slug>.json и возвращается тем же объектом.',
  additionalProperties: false,
  properties: {
    reportPath: { type: 'string', description: 'абсолютный путь записанного отчёта' },
    topic: { type: 'string', description: 'слаг темы, ровно как в engine.json' },
    headline: { type: 'string', description: 'главный вывод отчёта одним предложением' },
    keyFindings: { type: 'array', items: { type: 'string' }, description: '8-15 сильнейших выводов; каждый — развёрнутое предложение с цифрой и источником, а не заголовок раздела' },
    hardNumbers: { type: 'array', items: { type: 'string' }, description: 'ключевые числа в формате «показатель = значение (выборка и условия, кто измерял, дата, URL)»; пустой массив, если чисел в теме нет' },
    disputes: { type: 'array', items: { type: 'string' }, description: 'споры между источниками: позиция А против позиции Б, кто носитель каждой; пустой массив, если расхождений не найдено' },
    unverified: { type: 'array', items: { type: 'string' }, description: 'что не удалось подтвердить и что именно искалось; пустой массив, если всё подтверждено' },
    notCovered: { type: 'array', items: { type: 'string' }, description: 'вопросы ТЗ, оставшиеся без ответа, с причиной; пустой массив, если покрыты все' },
    sourceCount: { type: 'number', description: 'сколько отдельных источников реально открыто и использовано' },
    approxWords: { type: 'number', description: 'примерный объём отчёта в словах' },
  },
  required: ['reportPath', 'topic', 'headline', 'keyFindings', 'hardNumbers', 'disputes', 'unverified', 'notCovered', 'sourceCount', 'approxWords'],
}

const VERIFY_SCHEMA = OVERRIDE.verify || {
  type: 'object',
  description: 'Возврат верификатора стадии verify. Пишется агентом в state/results/verify__<topic-slug>.json и возвращается тем же объектом.',
  additionalProperties: false,
  properties: {
    topic: { type: 'string', description: 'слаг темы, ровно как в engine.json' },
    coverageVerdict: { type: 'string', enum: ['full', 'partial', 'weak'], description: 'покрытие вопросов ТЗ после достройки: full — отвечены все, partial — есть слабо покрытые, weak — остались вопросы без ответа' },
    checkedClaims: { type: 'array', items: { type: 'string' }, description: 'проверенные утверждения: утверждение → вердикт (подтверждено / исправлено на X / не подтверждено) → источник и дата проверки' },
    corrections: { type: 'array', items: { type: 'string' }, description: 'что исправлено в файле отчёта; пустой массив, если ошибок не нашлось' },
    additions: { type: 'array', items: { type: 'string' }, description: 'какие разделы, таблицы и факты дописаны и куда именно' },
    stillMissing: { type: 'array', items: { type: 'string' }, description: 'что осталось непокрытым и почему; пустой массив, если непокрытого нет' },
    wordsBefore: { type: 'number', description: 'объём отчёта в словах до верификации' },
    wordsAfter: { type: 'number', description: 'объём отчёта в словах после верификации; обязан быть больше wordsBefore' },
  },
  required: ['topic', 'coverageVerdict', 'checkedClaims', 'corrections', 'additions', 'stillMissing', 'wordsBefore', 'wordsAfter'],
}

const taskFile = (label) => ROOT + '/state/tasks/' + label + '.md'
const resultFile = (label) => ROOT + '/state/results/' + label + '.json'

const LAW = 'Закон конвейера: ни один шаг не сжимает содержание. Отчёт полнее своего ТЗ, свод — надмножество относящихся к нему отчётов. Ступени, которая вернёт выброшенное, в конвейере нет: всё, что ты опустишь «для краткости», потеряно навсегда. Единственное допустимое сокращение — склейка дословных повторов между источниками с пометкой «подтверждено N отчётами».'

const finish = (label) => 'Последним действием запиши результат в файл ' + resultFile(label) + ' (JSON, UTF-8) и верни тот же объект в ответе по схеме. Файл на диске обязателен: он читается независимо от того, каким хостом тебя запустили.'

const wrap = (label, head) => head + '\n\nФайл задачи: ' + taskFile(label) + '\n\nПорядок работы:\n1. Прочитай файл задачи целиком, от первой строки до последней. Он самодостаточен: миссия движка, периметр, дата сборки, ТЗ, требования к объёму и формат возврата — всё там.\n2. Выполни его буквально, сверху вниз. Файл задачи — контракт, а не вдохновение: пропущенный пункт считается браком. Ничего не додумывай про предмет сверх того, что написано в задаче и в файлах, на которые она ссылается.\n3. ' + LAW + '\n4. ' + finish(label)

const researchPrompt = (slug) => wrap('research__' + slug, 'Ты ресерчер движка. Тема прогона: ' + slug + '.')

const verifyPrompt = (slug) => wrap('verify__' + slug, 'Ты верификатор и достройщик отчёта по теме ' + slug + '. Твоя работа делает отчёт полнее и надёжнее, а не короче: объём после тебя обязан вырасти. Ничего не удаляй; опровергнутое утверждение переписывается с пометкой «опровергнуто» и источником опровержения, но остаётся в тексте.')

phase('Research')
log('Тем в партии: ' + labels.length + ' — ' + labels.join(', ') + (WITH_VERIFY ? ' · с верификацией' : ' · без верификации (args.verify = false)'))
if (labels.length > 4) log('Внимание: партия больше четырёх тем. Прошлый прогон девяти тяжёлых агентов разом сжёг лимит сессии за пять минут; безопасная партия — 3-4 темы.')

const results = await pipeline(
  labels,

  (slug) => agent(researchPrompt(slug), { label: 'research__' + slug, phase: 'Research', schema: RESEARCH_SCHEMA, effort: EFFORT }),

  (res, slug) => {
    if (!res) return null
    if (!WITH_VERIFY) return { slug, research: res, verify: null }
    return agent(verifyPrompt(slug), { label: 'verify__' + slug, phase: 'Verify', schema: VERIFY_SCHEMA, effort: EFFORT })
      .then(v => ({ slug, research: res, verify: v || null }))
  }
)

const done = (results || []).filter(Boolean)
const failed = labels.filter(s => !done.some(d => d.slug === s))
const verifyFailed = WITH_VERIFY ? done.filter(d => !d.verify).map(d => d.slug) : []
const notGrown = done.filter(d => d.verify && d.verify.wordsAfter && d.verify.wordsBefore && d.verify.wordsAfter <= d.verify.wordsBefore).map(d => d.slug)

log('Отчётов собрано: ' + done.length + ' из ' + labels.length + (failed.length ? ' · не собрались: ' + failed.join(', ') : '') + (verifyFailed.length ? ' · без верификации: ' + verifyFailed.join(', ') : ''))
if (notGrown.length) log('Отчёт после верификации не вырос: ' + notGrown.join(', ') + '. Это брак по закону конвейера — перезапусти verify по этим темам.')

return {
  stage: 'research',
  root: ROOT,
  verify: WITH_VERIFY,
  reports: done.map(d => ({
    topic: d.slug,
    path: d.research.reportPath,
    result: resultFile('research__' + d.slug),
    headline: d.research.headline,
    sources: d.research.sourceCount,
    words: (d.verify && d.verify.wordsAfter) || d.research.approxWords,
    coverage: (d.verify && d.verify.coverageVerdict) || 'unverified',
    keyFindings: d.research.keyFindings || [],
    disputes: d.research.disputes || [],
    unverified: d.research.unverified || [],
    stillMissing: (d.verify && d.verify.stillMissing) || d.research.notCovered || [],
    corrections: (d.verify && d.verify.corrections) || [],
  })),
  failed,
  verifyFailed,
  notGrown,
  next: (failed.length || verifyFailed.length || notGrown.length)
    ? 'Сначала добей провалы: перезапусти research.mjs с args.labels из failed, verifyFailed и notGrown. Потом — проверка: node scripts/audit.mjs --root ' + ROOT + ' --stage research'
    : 'Дальше: node scripts/audit.mjs --root ' + ROOT + ' --stage research, затем следующая партия тем, а когда темы закончатся — node scripts/render-tasks.mjs --root ' + ROOT + ' --stage synth и synthesis.mjs со stage synth',
}

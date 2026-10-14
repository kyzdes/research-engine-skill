export const meta = {
  name: 'research-engine-research',
  description: 'Стадия ресерча движка: агент на тему пишет полный отчёт по файлу задачи, верификатор проверяет числа и достраивает тот же отчёт',
  whenToUse: 'После того как render-tasks.mjs отрендерил state/tasks/. args: { root: "/abs/path/<slug>-engine", labels: ["01-slug", "02-slug"], stage?: "research" | "verify", verify?: true, models?: { research: "sonnet", verify: "opus" }, efforts?: { research: "high", verify: "high" }, model?: "<id>", effort?: "high", schemas?: {} }. models и efforts — маршрут по ролям, его печатают render-tasks.mjs и status.mjs из engine.json; model и effort — одно значение на обе роли. stage "verify" — только верификатор поверх готового отчёта: так добиваются verifyFailed и notGrown, не переписывая отчёт заново. Партия — 3-4 темы за вызов: девять тяжёлых агентов разом выжигают лимит сессии.',
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

// research — ресерчер, следом верификатор (по умолчанию); verify — только верификатор поверх
// готового отчёта. Повтор верификации через research заново пишет отчёт с нуля: это час
// работы и полмиллиона токенов на тему ради того, что стоило одного верификатора.
const STAGE = String(A.stage || 'research')
if (STAGE !== 'research' && STAGE !== 'verify') {
  throw new Error('args.stage принимает "research" (ресерч, следом верификация) или "verify" (только верификатор поверх готового отчёта), пришло: ' + STAGE)
}

const labels = [...new Set((Array.isArray(A.labels) ? A.labels : []).map(x => String(x).trim().replace(/^(research|verify)__/, '')).filter(Boolean))]
if (!labels.length) {
  throw new Error('Пустой args.labels. Передай слаги тем из engine.json, например { root: "' + ROOT + '", labels: ["01-first-topic", "02-second-topic"] }. Файлы задач должны быть уже отрендерены: node $SKILL/scripts/render-tasks.mjs --root ' + ROOT + ' --stage ' + STAGE + ' ($SKILL — каталог скилла research-engine)')
}

const ONLY_VERIFY = STAGE === 'verify'
const WITH_VERIFY = ONLY_VERIFY || (A.verify !== false && A.verify !== 'false' && A.verify !== 0)
// Маршрут по ролям: ресерчеру — объём с веб-поиском, верификатору — суждение. Значения приходят
// в args.models / args.efforts из engine.json (исполнитель файлов не видит); args.model и
// args.effort — одно значение на обе роли. Модели нет нигде — агент наследует модель сессии.
const pick = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {})
const MODELS = pick(A.models)
const EFFORTS = pick(A.efforts)
const routeOf = (role) => ({ model: String(MODELS[role] || A.model || ''), effort: String(EFFORTS[role] || A.effort || 'high') })
const OVERRIDE = A.schemas || {}

const agentOpts = (label, phase, schema, role) => {
  const r = routeOf(role)
  return Object.assign({ label, phase, schema, effort: r.effort }, r.model ? { model: r.model } : {})
}

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

const verifyAgent = (slug) => agent(verifyPrompt(slug), agentOpts('verify__' + slug, 'Verify', VERIFY_SCHEMA, 'verify'))

phase(ONLY_VERIFY ? 'Verify' : 'Research')
log('Тем в партии: ' + labels.length + ' — ' + labels.join(', ') +
  (ONLY_VERIFY ? ' · только верификация (args.stage = verify), отчёты не переписываются'
    : WITH_VERIFY ? ' · с верификацией' : ' · без верификации (args.verify = false)') +
  ' · модели: ' + (ONLY_VERIFY ? '' : 'ресерчер ' + (routeOf('research').model || 'сессии') + ', ') + 'верификатор ' + (routeOf('verify').model || 'сессии'))
if (labels.length > 4) log('Внимание: партия больше четырёх тем. Прошлый прогон девяти тяжёлых агентов разом сжёг лимит сессии за пять минут; безопасная партия — 3-4 темы.')

const results = ONLY_VERIFY
  ? await parallel(labels.map(slug => () => verifyAgent(slug).then(v => (v ? { slug, research: null, verify: v } : null))))
  : await pipeline(
      labels,

      (slug) => agent(researchPrompt(slug), agentOpts('research__' + slug, 'Research', RESEARCH_SCHEMA, 'research')),

      (res, slug) => {
        if (!res) return null
        if (!WITH_VERIFY) return { slug, research: res, verify: null }
        return verifyAgent(slug).then(v => ({ slug, research: res, verify: v || null }))
      }
    )

const done = (results || []).filter(Boolean)
// В режиме verify «не собрался» значит «верификатор упал»: отчёт на месте, переписывать его не надо.
const failed = ONLY_VERIFY ? [] : labels.filter(s => !done.some(d => d.slug === s))
const verifyFailed = ONLY_VERIFY
  ? labels.filter(s => !done.some(d => d.slug === s))
  : WITH_VERIFY ? done.filter(d => !d.verify).map(d => d.slug) : []
const notGrown = done.filter(d => d.verify && d.verify.wordsAfter && d.verify.wordsBefore && d.verify.wordsAfter <= d.verify.wordsBefore).map(d => d.slug)

log((ONLY_VERIFY ? 'Верифицировано: ' + done.length : 'Отчётов собрано: ' + done.length) + ' из ' + labels.length +
  (failed.length ? ' · не собрались: ' + failed.join(', ') : '') + (verifyFailed.length ? ' · без верификации: ' + verifyFailed.join(', ') : ''))
if (notGrown.length) log('Отчёт после верификации не вырос: ' + notGrown.join(', ') + '. Это брак по закону конвейера — перезапусти верификацию по этим темам (args.stage = verify).')

// Workflow не видит файловой системы: статусы в engine.json и строку журнала ставит status.mjs.
const after = 'node $SKILL/scripts/status.mjs --root ' + ROOT + ' --write (статусы и журнал), затем node $SKILL/scripts/audit.mjs --root ' + ROOT + ' --stage research. $SKILL — каталог скилла research-engine.'
const retry = []
if (failed.length) retry.push('ресерч заново: research.mjs с args.labels ' + JSON.stringify(failed))
const reverify = [...new Set([...verifyFailed, ...notGrown])]
if (reverify.length) retry.push('только верификация, без повторного ресерча: research.mjs с args.stage "verify" и args.labels ' + JSON.stringify(reverify))

return {
  stage: STAGE,
  root: ROOT,
  verify: WITH_VERIFY,
  models: { research: ONLY_VERIFY ? null : routeOf('research').model || 'модель сессии', verify: WITH_VERIFY ? routeOf('verify').model || 'модель сессии' : null },
  reports: done.map(d => ({
    topic: d.slug,
    path: d.research ? d.research.reportPath : ROOT + '/reports/' + d.slug + '.md',
    result: resultFile((d.research ? 'research__' : 'verify__') + d.slug),
    headline: d.research ? d.research.headline : '',
    sources: d.research ? d.research.sourceCount : null,
    words: (d.verify && d.verify.wordsAfter) || (d.research && d.research.approxWords) || null,
    coverage: (d.verify && d.verify.coverageVerdict) || 'unverified',
    keyFindings: (d.research && d.research.keyFindings) || [],
    disputes: (d.research && d.research.disputes) || [],
    unverified: (d.research && d.research.unverified) || [],
    stillMissing: (d.verify && d.verify.stillMissing) || (d.research && d.research.notCovered) || [],
    corrections: (d.verify && d.verify.corrections) || [],
  })),
  failed,
  verifyFailed,
  notGrown,
  next: retry.length
    ? 'Сначала добей провалы — ' + retry.join('; ') + '. Потом: ' + after
    : 'Дальше: ' + after + ' Затем следующая партия тем; когда темы кончатся — render-tasks.mjs --stage synth и synthesis.mjs со stage synth.',
}

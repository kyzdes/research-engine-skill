export const meta = {
  name: 'research-engine-synthesis',
  description: 'Стадии свода движка: своды по отчётам, навигатор банка фактов, критик полноты, METHOD.md и AGENT.md — каждая партия агентов работает по своим файлам задач',
  whenToUse: 'После того как отчёты собраны и верифицированы, а render-tasks.mjs отрендерил задачи нужной стадии. args: { root: "/abs/path/<slug>-engine", labels: ["field-spec", "verdicts"], stage?: "synth" | "merge" | "critique" | "method" | "agent-doc", effort?: "high", schemas?: {} }. Стадия выбирает и вид задачи, и схему возврата. Партия — 3-4 задачи за вызов.',
  phases: [
    { title: 'Synthesize', detail: 'своды в synthesis/: каждый агент читает state/tasks/synth__<label>.md и полные отчёты' },
    { title: 'Merge', detail: 'навигатор поверх частей банка фактов; части остаются данными' },
    { title: 'Critique', detail: 'критик полноты сверяет отчёты со сводами и пишет GAPS.md' },
    { title: 'Method', detail: 'METHOD.md и AGENT.md — финиш method' },
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

const OVERRIDE = A.schemas || {}

const FILE_SCHEMA = OVERRIDE.file || {
  type: 'object',
  description: 'Возврат агента, который пишет один файл движка: свод, навигатор банка фактов, METHOD.md, AGENT.md. Пишется агентом в state/results/<label>.json и возвращается тем же объектом.',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'абсолютный путь записанного файла' },
    summary: { type: 'string', description: '3-5 предложений: что внутри, как устроено, на что опирается' },
    sections: { type: 'array', items: { type: 'string' }, description: 'список разделов файла в порядке следования' },
    factsCarried: { type: 'number', description: 'сколько отдельных фактов с цифрами перенесено из отчётов' },
    approxWords: { type: 'number', description: 'примерный объём файла в словах' },
    openIssues: { type: 'array', items: { type: 'string' }, description: 'чего в отчётах не хватило для этого документа; пустой массив, если хватило всего' },
  },
  required: ['path', 'summary', 'sections', 'factsCarried', 'approxWords', 'openIssues'],
}

const GAPS_SCHEMA = OVERRIDE.gaps || {
  type: 'object',
  description: 'Возврат критика полноты стадии critique. Пишется агентом в state/results/critique__gaps.json и возвращается тем же объектом.',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'абсолютный путь записанного файла GAPS.md' },
    verdict: { type: 'string', enum: ['ready', 'ready-with-fixes', 'not-ready'], description: 'можно ли писать методику по этой базе: ready — можно, ready-with-fixes — можно после перечисленных правок, not-ready — нельзя, пока не закрыты блокеры' },
    losses: { type: 'array', items: { type: 'string' }, description: 'потери конвейера: факты, таблицы и примеры из отчётов, не доехавшие ни в один свод; что потеряно, из какого отчёта, в какой свод дописать' },
    holes: { type: 'array', items: { type: 'string' }, description: 'дыры фактуры: вопросы, на которые ресерч не ответил; каждый — с формулировкой follow-up запроса' },
    risks: { type: 'array', items: { type: 'string' }, description: 'риски: где движок может навредить пользователю или увести к ложному выводу' },
    blockers: { type: 'array', items: { type: 'string' }, description: 'блокеры финиша: что обязано быть закрыто до METHOD.md; пустой массив при вердикте ready' },
  },
  required: ['path', 'verdict', 'losses', 'holes', 'risks', 'blockers'],
}

const STAGES = {
  synth: {
    prefix: 'synth__',
    phase: 'Synthesize',
    example: 'field-spec',
    alias: {},
    role: 'Ты сводчик движка. Твой свод — надмножество относящихся к нему отчётов, а не их пересказ: таблицы, цифры и дословные примеры переносятся целиком. Дедупликация допустима только для дословных повторов между источниками и всегда с пометкой «подтверждено N отчётами». Метод чтения корпуса задан в файле задачи — держись его: свои отчёты читаются целиком, чужие точечно.',
    next: 'Дальше: следующая партия сводов (synthesis.mjs с другими args.labels), потом node scripts/audit.mjs --root ROOT --stage synthesis, потом стадия merge или сразу critique.',
  },
  merge: {
    prefix: 'merge__',
    phase: 'Merge',
    example: 'facts-bank',
    alias: { merge: 'facts-bank', bank: 'facts-bank' },
    role: 'Ты собираешь навигатор поверх частей, которые уже лежат на диске. Переписывать части в один файл нельзя: ручной перенос тысяч строк таблиц гарантированно теряет данные, и агент начинает сокращать. Части остаются самими данными, твой файл — вход в них: как читать, карта разделов с объёмами, опорные числа со ссылкой на полную строку, сводный список противоречий.',
    next: 'Дальше: node scripts/render-tasks.mjs --root ROOT --stage critique и synthesis.mjs со stage critique.',
  },
  critique: {
    prefix: 'critique__',
    phase: 'Critique',
    example: 'gaps',
    alias: { critique: 'gaps' },
    role: 'Ты критик полноты, ревизор, а не редактор. Читай корпус по правилам ревизии: оглавления через grep по строкам-заголовкам, вводные правила и разделы про пробелы — целиком, вглубь ныряй точечно под конкретную претензию. Ищи то, где движок слабее, чем кажется: потери конвейера, дыры фактуры, места, где агент по этим документам встанет, риски и честную границу применимости. Придирчивость здесь — работа, а не грубость.',
    next: 'Дальше: прочитать GAPS.md и закрыть блокеры. При finish base на этом стоп; при finish method — render-tasks.mjs --stage method и synthesis.mjs со stage method.',
  },
  method: {
    prefix: 'method__',
    phase: 'Method',
    example: 'method',
    alias: { 'METHOD.md': 'method' },
    role: 'Ты пишешь главный документ движка: навигатор и свод законов, а не пересказ сводов. Закон формулируется как правило действия, а не наблюдение, и снабжается ссылкой на файл свода, где лежит доказательство. Своды целиком не читай — метод чтения задан в файле задачи. Тон плотный и инструктивный, без канцелярита и общих слов.',
    next: 'Дальше: render-tasks.mjs --stage agent-doc и synthesis.mjs со stage agent-doc.',
  },
  'agent-doc': {
    prefix: 'method__',
    phase: 'Method',
    example: 'agent',
    alias: { 'agent-doc': 'agent', 'AGENT.md': 'agent' },
    role: 'Ты пишешь вход для агента, который будет работать по движку: что прочитать и когда, в каком порядке действовать, где остановиться и спросить человека, чего не делать никогда. Коротко и операционно. Содержание живёт в методике и сводах — дублировать его сюда не надо, надо дать точную навигацию по ним.',
    next: 'Дальше: node scripts/build-index.mjs --root ROOT и финальный node scripts/audit.mjs --root ROOT --stage all.',
  },
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

const STAGE = String(A.stage || 'synth')
const CFG = has(STAGES, STAGE) ? STAGES[STAGE] : null
if (!CFG) throw new Error('Неизвестная стадия: ' + STAGE + '. Ожидается одна из: ' + Object.keys(STAGES).join(', '))

const SCHEMA = STAGE === 'critique' ? GAPS_SCHEMA : FILE_SCHEMA
const EFFORT = A.effort || 'high'

const raw = (Array.isArray(A.labels) ? A.labels : []).map(x => String(x).trim()).filter(Boolean)
if (!raw.length) {
  throw new Error('Пустой args.labels. Передай метки задач стадии ' + STAGE + ', например { root: "' + ROOT + '", stage: "' + STAGE + '", labels: ["' + CFG.example + '"] }. Метки стадии synth — поле label каждого свода в engine.json; у остальных стадий метка одна и канонична: merge → facts-bank, critique → gaps, method → method, agent-doc → agent. Файлы задач должны быть уже отрендерены: node scripts/render-tasks.mjs --root ' + ROOT + ' --stage ' + STAGE)
}

const seen = {}
const tasks = []
for (const x of raw) {
  const short = has(CFG.alias, x) ? CFG.alias[x] : x
  const label = short.indexOf('__') >= 0 ? short : CFG.prefix + short
  if (has(seen, label)) continue
  seen[label] = true
  tasks.push({ short, label })
}

const taskFile = (label) => ROOT + '/state/tasks/' + label + '.md'
const resultFile = (label) => ROOT + '/state/results/' + label + '.json'

const LAW = 'Закон конвейера: ни один шаг не сжимает содержание. Отчёт полнее своего ТЗ, свод — надмножество относящихся к нему отчётов, методика — навигатор поверх сводов. Ступени, которая вернёт выброшенное, в конвейере нет: всё, что ты опустишь «для краткости», потеряно навсегда. Единственное допустимое сокращение — склейка дословных повторов между источниками с пометкой «подтверждено N отчётами».'

const prompt = (label) => CFG.role + '\n\nФайл задачи: ' + taskFile(label) + '\n\nПорядок работы:\n1. Прочитай файл задачи целиком, от первой строки до последней. Он самодостаточен: миссия движка, периметр, список источников с путями, требуемые разделы, объём и формат возврата — всё там.\n2. Выполни его буквально, сверху вниз. Файл задачи — контракт, а не вдохновение: пропущенный пункт считается браком. Ничего не додумывай про предмет сверх того, что написано в задаче и в файлах, на которые она ссылается.\n3. ' + LAW + '\n4. Последним действием запиши результат в файл ' + resultFile(label) + ' (JSON, UTF-8) и верни тот же объект в ответе по схеме. Файл на диске обязателен: он читается независимо от того, каким хостом тебя запустили.'

phase(CFG.phase)
log('Стадия ' + STAGE + ' · задач в партии: ' + tasks.length + ' — ' + tasks.map(t => t.label).join(', '))
if (tasks.length > 4) log('Внимание: партия больше четырёх задач. Прошлый прогон девяти тяжёлых агентов разом сжёг лимит сессии за пять минут; безопасная партия — 3-4 задачи.')

const out = await parallel(tasks.map(t => () => agent(prompt(t.label), { label: t.label, phase: CFG.phase, schema: SCHEMA, effort: EFFORT })))

const pairs = tasks.map((t, i) => ({ task: t, res: (out || [])[i] || null }))
const done = pairs.filter(p => p.res)
const failed = pairs.filter(p => !p.res).map(p => p.task.label)

const view = (p) => STAGE === 'critique'
  ? {
      label: p.task.label,
      path: p.res.path,
      result: resultFile(p.task.label),
      verdict: p.res.verdict,
      losses: p.res.losses || [],
      holes: p.res.holes || [],
      risks: p.res.risks || [],
      blockers: p.res.blockers || [],
    }
  : {
      label: p.task.label,
      path: p.res.path,
      result: resultFile(p.task.label),
      summary: p.res.summary,
      sections: p.res.sections || [],
      facts: p.res.factsCarried,
      words: p.res.approxWords,
      open: p.res.openIssues || [],
    }

const built = done.map(view)

log('Готово файлов: ' + built.length + ' из ' + tasks.length + (failed.length ? ' · не собрались: ' + failed.join(', ') : ''))

const tail = CFG.next.replace(/ROOT/g, ROOT).replace(/^Дальше: /, '')

return {
  stage: STAGE,
  root: ROOT,
  built,
  failed,
  next: failed.length
    ? 'Сначала перезапусти упавшие задачи: synthesis.mjs со stage ' + STAGE + ' и args.labels из failed. Потом — ' + tail
    : 'Дальше: ' + tail,
}

export const meta = {
  name: 'research-engine-synthesis',
  description: 'Стадии движка, где агент пишет один файл: разведка предмета для брифа, своды по отчётам, навигатор банка фактов, критик полноты, METHOD.md и AGENT.md — каждая партия агентов работает по своим файлам задач',
  whenToUse: 'После того как отчёты собраны и верифицированы, а render-tasks.mjs отрендерил задачи нужной стадии. args: { root: "/abs/path/<slug>-engine", labels: ["field-spec", "verdicts"], stage?: "recon" | "synth" | "merge" | "critique" | "method" | "agent-doc", models?: { "<label>": "opus" }, efforts?: { "<label>": "high" }, model?: "<id>", effort?: "high", schemas?: {} }. models и efforts — маршрут по задачам партии из engine.json (части банка фактов дешевле плейбуков), их печатают render-tasks.mjs и status.mjs. Стадия выбирает и вид задачи, и схему возврата. Партия — 3-4 задачи за вызов.',
  phases: [
    { title: 'Recon', detail: 'разведка предмета до второго круга вопросов заказчику: brief/RECON.md' },
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
// Кавычки для пути в печатаемой команде (копия shq из scripts/lib/engine.mjs: исполнитель
// файловой системы не видит и импортировать не может). Каталог с пробелом иначе ломает строку.
const shq = (v) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(String(v)) ? String(v) : "'" + String(v).replace(/'/g, "'\\''") + "'")
const Q = shq(ROOT)

const OVERRIDE = A.schemas || {}

const FILE_SCHEMA = OVERRIDE.file || {
  type: 'object',
  description: 'Возврат агента, который пишет один файл движка: разведку brief/RECON.md, свод, навигатор банка фактов, METHOD.md, AGENT.md. Пишется агентом в state/results/<label>.json и возвращается тем же объектом. Что именно класть в каждое поле, уточняет файл задачи.',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'абсолютный путь записанного файла' },
    summary: { type: 'string', description: '3-5 предложений: что внутри, как устроено, на что опирается' },
    sections: { type: 'array', items: { type: 'string' }, description: 'список разделов файла в порядке следования' },
    factsCarried: { type: 'number', description: 'сколько отдельных фактов с цифрами в файле: перенесено из корпуса, вынесено с адресом или найдено (разведка); как считать — в файле задачи' },
    approxWords: { type: 'number', description: 'примерный объём файла в словах' },
    openIssues: { type: 'array', items: { type: 'string' }, description: 'открытые вопросы: чего не хватило для документа, а у разведки — вопросы заказчику; пустой массив, если открытого нет' },
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
    acceptance: { type: 'array', items: { type: 'string' }, description: 'контрольные вопросы брифа: по строке на вопрос — «A1 — отвечено | частично | нет — адрес ответа или чего не хватает»; пустой массив, если вопросов в брифе нет' },
  },
  required: ['path', 'verdict', 'losses', 'holes', 'risks', 'blockers', 'acceptance'],
}

// Навигаторы (банк-навигатор, METHOD.md, AGENT.md) короче корпуса по природе, и это не сжатие,
// пока ничего не теряется: данные остаются на месте, документ даёт к ним адрес. Тексты законов —
// копии LAWS из scripts/lib/engine.mjs (исполнитель файловой системы не видит), тест сверяет их.
const NAV_LAW = 'Закон конвейера для навигатора: ты пишешь документ поверх полного корпуса, и короче корпуса он быть вправе, но ничего не теряя. Данные не переписываются и не пересказываются, а адресуются: каждое утверждение — со ссылкой на файл и раздел, где лежит полная версия; число — с адресом полной строки в банке фактов. Объём и форму держи по файлу задачи.'

const STAGES = {
  recon: {
    prefix: 'recon__',
    phase: 'Recon',
    example: 'field',
    alias: { recon: 'field', 'RECON.md': 'field' },
    law: 'Закон разведки: ширина важнее глубины, а точность важнее объёма. У каждого названного источника — URL, у каждой цифры — дата и URL; объём держи в рамках задачи: разведка — карта, а не отчёт, глубину даст конвейер.',
    role: 'Ты разведчик движка на стадии брифа. Движок ещё не собран: тема не разрезана, миссия не написана. Твоя работа — за один проход карта предмета с первоисточниками, кандидаты в работы базы и в контрольные вопросы и вопросы заказчику, ответ на которые меняет сборку. Ширина и точные названия важнее глубины: глубину даст конвейер. Тебе нужен веб-поиск.',
    next: 'Дальше: прочитай brief/RECON.md, задай заказчику второй круг вопросов (references/BRIEF.md §4), заполни brief в engine.json и node $SKILL/scripts/brief.mjs --root ROOT --write.',
  },
  synth: {
    prefix: 'synth__',
    phase: 'Synthesize',
    example: 'field-spec',
    alias: {},
    role: 'Ты сводчик движка. Твой свод — надмножество относящихся к нему отчётов, а не их пересказ: таблицы, цифры и дословные примеры переносятся целиком. Дедупликация допустима только для дословных повторов между источниками и всегда с пометкой «подтверждено N отчётами». Метод чтения корпуса задан в файле задачи — держись его: свои отчёты читаются целиком, чужие точечно.',
    next: 'Дальше: следующая партия сводов (synthesis.mjs с другими args.labels); после последней — node $SKILL/scripts/audit.mjs --root ROOT --stage synthesis, потом стадия merge, если банк фактов собран частями, иначе сразу critique.',
  },
  merge: {
    prefix: 'merge__',
    phase: 'Merge',
    example: 'facts-bank',
    alias: { merge: 'facts-bank', bank: 'facts-bank', 'FACTS-BANK.md': 'facts-bank' },
    law: NAV_LAW,
    role: 'Ты собираешь навигатор поверх частей, которые уже лежат на диске. Переписывать части в один файл нельзя: ручной перенос тысяч строк таблиц гарантированно теряет данные, и агент начинает сокращать. Части остаются самими данными, твой файл — вход в них: как читать, карта разделов с объёмами, опорные числа со ссылкой на полную строку, сводный список противоречий.',
    next: 'Дальше: node $SKILL/scripts/render-tasks.mjs --root ROOT --stage critique и synthesis.mjs со stage critique.',
  },
  critique: {
    prefix: 'critique__',
    phase: 'Critique',
    example: 'gaps',
    alias: { critique: 'gaps', 'GAPS.md': 'gaps' },
    role: 'Ты критик полноты, ревизор, а не редактор. Читай корпус по правилам ревизии: оглавления через grep по строкам-заголовкам, вводные правила и разделы про пробелы — целиком, вглубь ныряй точечно под конкретную претензию. Ищи то, где движок слабее, чем кажется: потери конвейера, дыры фактуры, места, где агент по этим документам встанет, риски и честную границу применимости. Придирчивость здесь — работа, а не грубость.',
    next: 'Дальше: прочитать GAPS.md и закрыть блокеры. При finish base на этом стоп; при finish method — node $SKILL/scripts/render-tasks.mjs --root ROOT --stage method и synthesis.mjs со stage method.',
  },
  method: {
    prefix: 'method__',
    phase: 'Method',
    example: 'method',
    alias: { 'METHOD.md': 'method' },
    law: NAV_LAW,
    role: 'Ты пишешь главный документ движка: навигатор и свод законов, а не пересказ сводов. Закон формулируется как правило действия, а не наблюдение, и снабжается ссылкой на файл свода, где лежит доказательство. Своды целиком не читай — метод чтения задан в файле задачи. Тон плотный и инструктивный, без канцелярита и общих слов.',
    next: 'Дальше: node $SKILL/scripts/build-index.mjs --root ROOT (карта сводов с номерами строк — на неё ссылается AGENT.md), затем node $SKILL/scripts/render-tasks.mjs --root ROOT --stage agent-doc и synthesis.mjs со stage agent-doc.',
  },
  'agent-doc': {
    prefix: 'method__',
    phase: 'Method',
    example: 'agent',
    alias: { 'agent-doc': 'agent', 'AGENT.md': 'agent' },
    law: NAV_LAW,
    role: 'Ты пишешь вход для агента, который будет работать по движку: что прочитать и когда, в каком порядке действовать, где остановиться и спросить человека, чего не делать никогда. Коротко и операционно. Содержание живёт в методике и сводах — дублировать его сюда не надо, надо дать точную навигацию по ним.',
    next: 'Дальше: node $SKILL/scripts/build-index.mjs --root ROOT (пересобрать карту после финиша) и финальный node $SKILL/scripts/audit.mjs --root ROOT --stage all.',
  },
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

const STAGE = String(A.stage || 'synth')
const CFG = has(STAGES, STAGE) ? STAGES[STAGE] : null
if (!CFG) throw new Error('Неизвестная стадия: ' + STAGE + '. Ожидается одна из: ' + Object.keys(STAGES).join(', '))

const SCHEMA = STAGE === 'critique' ? GAPS_SCHEMA : FILE_SCHEMA
// Маршрут по задачам: args.models / args.efforts — объекты «короткая метка → значение» из
// engine.json (их печатают render-tasks и status). Явные args.model / args.effort — одно значение
// на всю партию и сильнее маршрута, как флаг --model у fanout. Нет ни того ни другого — агент
// наследует модель сессии.
const pick = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {})
const MODELS = pick(A.models)
const EFFORTS = pick(A.efforts)
const routeOf = (t) => ({
  model: String(A.model || MODELS[t.short] || MODELS[t.label] || ''),
  effort: String(A.effort || EFFORTS[t.short] || EFFORTS[t.label] || 'high'),
})

const raw = (Array.isArray(A.labels) ? A.labels : typeof A.labels === 'string' ? A.labels.split(',') : []).map(x => String(x).trim()).filter(Boolean)
if (!raw.length) {
  throw new Error('Пустой args.labels. Передай метки задач стадии ' + STAGE + ', например { root: "' + ROOT + '", stage: "' + STAGE + '", labels: ["' + CFG.example + '"] }. Метки стадии synth — поле label каждого свода в engine.json; у остальных стадий метка одна и канонична: recon → field, merge → facts-bank, critique → gaps, method → method, agent-doc → agent. Файлы задач должны быть уже отрендерены: node $SKILL/scripts/render-tasks.mjs --root ' + Q + ' --stage ' + STAGE + ' ($SKILL — каталог скилла research-engine)')
}

const seen = {}
const tasks = []
for (const x of raw) {
  const aliased = has(CFG.alias, x) ? CFG.alias[x] : x
  // Полная метка допустима только своей стадии: synth__x на стадии critique запустил бы свод
  // со схемой критика, method__agent на стадии method — AGENT.md в роли автора методики.
  if (aliased.indexOf('__') >= 0 && !aliased.startsWith(CFG.prefix)) {
    throw new Error('Метка ' + x + ' не относится к стадии ' + STAGE + ' (её префикс — ' + CFG.prefix + ').')
  }
  const short = aliased.startsWith(CFG.prefix) ? aliased.slice(CFG.prefix.length) : aliased
  if (STAGE !== 'synth' && short !== CFG.example) {
    throw new Error('У стадии ' + STAGE + ' одна метка — ' + CFG.example + ', пришло: ' + x + '.')
  }
  const label = CFG.prefix + short
  if (has(seen, label)) continue
  seen[label] = true
  tasks.push({ short, label })
}
const unusedRoutes = [...Object.keys(MODELS), ...Object.keys(EFFORTS)].filter(k => !tasks.some(t => t.short === k || t.label === k))
if (unusedRoutes.length) log('Внимание: в args.models / args.efforts есть ключи без задачи в партии: ' + [...new Set(unusedRoutes)].join(', ') + ' — ключ должен быть меткой задачи (например field-spec), а не стадией.')

const taskFile = (label) => ROOT + '/state/tasks/' + label + '.md'
const resultFile = (label) => ROOT + '/state/results/' + label + '.json'

const LAW = 'Закон конвейера: ни один шаг не сжимает содержание. Отчёт полнее своего ТЗ, свод — надмножество относящихся к нему отчётов, методика — навигатор поверх сводов. Ступени, которая вернёт выброшенное, в конвейере нет: всё, что ты опустишь «для краткости», потеряно навсегда. Единственное допустимое сокращение — склейка дословных повторов между источниками с пометкой «подтверждено N отчётами».'

// Нет файла задачи — работы нет: агент без контракта импровизирует, и брак не виден по схеме.
const MISSING = 'Если файла задачи нет на диске, ничего не делай и не пиши его сам: верни объект по схеме с пустыми строками, пустыми массивами и нулями — исполнитель засчитает это как провал и подскажет, что отрендерить.'

const prompt = (label) => CFG.role + '\n\nФайл задачи: ' + taskFile(label) + '\n\nПорядок работы:\n1. Прочитай файл задачи целиком, от первой строки до последней. Это главный контракт: роль, источники с путями, требуемые разделы, объём и формат возврата — в нём или по путям, которые он называет. ' + MISSING + '\n2. Выполни его буквально, сверху вниз. Файл задачи — контракт, а не вдохновение: пропущенный пункт считается браком. Ничего не додумывай сверх задачи и файлов, на которые она ссылается; где нужен факт — бери его из корпуса или источника, а не из памяти.\n3. ' + (CFG.law || LAW) + '\n4. Последним действием запиши результат в файл ' + resultFile(label) + ' (JSON, UTF-8) и верни тот же объект в ответе по схеме. Файл на диске обязателен: он читается независимо от того, каким хостом тебя запустили.'

phase(CFG.phase)
log('Стадия ' + STAGE + ' · задач в партии: ' + tasks.length + ' — ' + tasks.map(t => t.label + ' (' + (routeOf(t).model || 'модель сессии') + ')').join(', '))
if (tasks.length > 4) log('Внимание: партия больше четырёх задач. Прошлый прогон девяти тяжёлых агентов разом сжёг лимит сессии за пять минут; безопасная партия — 3-4 задачи.')

const out = await parallel(tasks.map(t => () => {
  const r = routeOf(t)
  return agent(prompt(t.label), Object.assign({ label: t.label, phase: CFG.phase, schema: SCHEMA, effort: r.effort }, r.model ? { model: r.model } : {}))
}))

// Пустой путь — агент не нашёл файла задачи или ничего не записал: это провал, а не результат.
const pairs = tasks.map((t, i) => {
  const r = (out || [])[i] || null
  return { task: t, res: r && String(r.path || '').trim() ? r : null }
})
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
      acceptance: p.res.acceptance || [],
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

// Workflow не видит файловой системы: статусы сводов в engine.json и строку журнала ставит status.mjs.
const status = 'node $SKILL/scripts/status.mjs --root ' + Q + ' (статусы по диску и следующая команда; расход партии — --record ' + STAGE + ' --agents <N> --tokens <T> --minutes <M>). $SKILL — каталог скилла research-engine.'
// Готовые args для повтора: тот же корень, стадия и маршрут, только упавшие метки.
// Маршрут — только для этих меток: лишние ключи дали бы ложное предупреждение «ключ без задачи».
const only = (o, ls) => Object.fromEntries(Object.entries(o).filter(([k]) => ls.includes(k) || ls.includes(k.replace(/^[a-z]+__/, ''))))
const retryArgs = (ls) => JSON.stringify(Object.assign({ root: ROOT, stage: STAGE, labels: ls },
  Object.keys(only(MODELS, ls)).length ? { models: only(MODELS, ls) } : {}, Object.keys(only(EFFORTS, ls)).length ? { efforts: only(EFFORTS, ls) } : {},
  A.model ? { model: A.model } : {}, A.effort ? { effort: A.effort } : {}))
const tail = CFG.next.replace(/ROOT/g, () => Q).replace(/^Дальше: /, '')

return {
  stage: STAGE,
  root: ROOT,
  models: Object.fromEntries(tasks.map(t => [t.short, routeOf(t).model || 'модель сессии'])),
  built,
  failed,
  // у разведки статусов нет: тем и сводов ещё не существует, status.mjs ей не нужен
  next: failed.length
    ? 'Сначала перезапусти упавшие задачи: synthesis.mjs с args ' + retryArgs(failed.map(l => l.replace(/^[a-z]+__/, ''))) + ' (пустой возврат значит, что файла задачи нет — отрендерь: node $SKILL/scripts/render-tasks.mjs --root ' + Q + ' --stage ' + STAGE + '). Потом — ' + (STAGE === 'recon' ? '' : status + ' Дальше: ') + tail
    : (STAGE === 'recon' ? 'Дальше: ' : 'Сначала ' + status + ' Дальше: ') + tail,
}

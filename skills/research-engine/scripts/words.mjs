#!/usr/bin/env node
// Объём файла в словах тем же счётчиком, которым меряют аудит и статус.
// Агенту нужен ровно он: `wc -w` и `str.split()` режут по пробелам и на отчёте с кодом
// и URL расходятся со счётчиком движка на треть — аудит принимает это за правку не того файла.
import path from 'node:path'
import { die, isFile, readText, countWords } from './lib/engine.mjs'

const USAGE = `words.mjs — объём файлов в словах счётчиком движка (тем же, что у audit.mjs и status.mjs).

  node words.mjs <файл> [<файл> ...] [--json]

  Слово — непрерывная серия букв и цифр с апострофами и дефисами внутри: «output-schema» —
  одно слово, а URL «https://platform.openai.com/docs» — пять, по буквенно-цифровым кускам.
  Таблицы, код и ссылки поэтому весят больше, чем у wc -w.
  --json   вывести {"<путь>": <слов>, ...} вместо строк «<слов>  <путь>»`

const files = []
let json = false
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0) }
  else if (a === '--json') json = true
  else if (a.startsWith('--')) die('неизвестный аргумент ' + a + '\n\n' + USAGE)
  else files.push(a)
}
if (!files.length) die('не задан файл\n\n' + USAGE)

const out = {}
for (const f of files) {
  const abs = path.resolve(f)
  if (!isFile(abs)) die('нет файла ' + abs)
  out[f] = countWords(readText(abs))
}
if (json) console.log(JSON.stringify(out))
else for (const [f, n] of Object.entries(out)) console.log(n + '  ' + f)

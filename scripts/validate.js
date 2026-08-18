#!/usr/bin/env node
/**
 * Валидатор спецификации Funora.
 *
 * Проверяет не синтаксис, а те инварианты, нарушение которых разводит реализации
 * на разных языках молча. Три группы проверок:
 *
 *   1. Скаляры. Сырые `number` и `string` в доменных полях запрещены: без
 *      `x-funora-type` шесть SDK выберут шесть разных представлений совершенно
 *      законно, а conformance сравнивает нормализованный JSON и расхождение поймает
 *      уже на пользовательских данных.
 *   2. Перечисления. У каждого перечисления, значения которого приходят со стороны
 *      площадки, обязан быть запасной вариант: иначе новый статус ломает пользователей
 *      без нашего участия.
 *   3. Ошибки. Уникальность `stable_id` и `abi_code`, разрешимость родителей,
 *      отсутствие циклов. `abi_code` попадает в бинарный интерфейс C-SDK, поэтому
 *      повторное использование числа недопустимо даже после удаления ошибки.
 *
 * Запуск: node scripts/validate.js
 * Код возврата: 0 - нарушений нет, 1 - есть.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const ROOT = path.resolve(__dirname, '..')
const SPEC = path.join(ROOT, 'spec')

/** Типы, объявленные в spec/types.yaml. Заполняется при загрузке. */
let KNOWN_TYPES = new Set()

/** Накопленные нарушения. */
const problems = []

/**
 * Регистрирует нарушение инварианта.
 *
 * @param {string} where Путь к файлу или логическое место, где найдено нарушение.
 * @param {string} what Описание нарушения на русском языке.
 * @returns {void}
 */
function fail(where, what) {
  problems.push({ where, what })
}

/**
 * Читает и разбирает YAML-файл спецификации.
 *
 * @param {string} file Абсолютный путь к файлу.
 * @returns {object} Разобранный документ.
 * @throws {Error} Если файл не читается или не является корректным YAML.
 */
function readYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'))
}

/**
 * Рекурсивно собирает все файлы с указанным расширением.
 *
 * @param {string} dir Каталог, с которого начинается обход.
 * @param {string} ext Расширение с точкой, например `.schema.json`.
 * @returns {string[]} Массив абсолютных путей, отсортированный по алфавиту.
 */
function walk(dir, ext) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, ext))
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out.sort()
}

/**
 * Загружает словарь скалярных типов предметной области.
 *
 * @returns {Set<string>} Множество имён типов, допустимых в `x-funora-type`.
 */
function loadTypes() {
  const doc = readYaml(path.join(SPEC, 'types.yaml'))
  const names = Object.keys(doc.types || {})
  if (names.length === 0) fail('spec/types.yaml', 'словарь типов пуст')
  return new Set(names)
}

/**
 * Проверяет одно свойство схемы на соответствие правилам скаляров и перечислений.
 *
 * @param {string} file Относительный путь к файлу схемы, для сообщения об ошибке.
 * @param {string} pointer JSON-указатель на свойство, например `properties.stock`.
 * @param {object} prop Тело свойства из JSON Schema.
 * @returns {void}
 */
function checkProperty(file, pointer, prop) {
  if (!prop || typeof prop !== 'object') return

  const declared = prop['x-funora-type']
  if (declared && !KNOWN_TYPES.has(declared)) {
    fail(file, `${pointer}: неизвестный x-funora-type «${declared}»`)
  }

  // Ссылка на другую модель и объявленный доменный тип снимают требование к скаляру.
  const delegated = Boolean(prop.$ref || declared)

  if (prop.type === 'number') {
    fail(file, `${pointer}: тип number запрещён - представление с плавающей точкой ` +
      `не воспроизводится одинаково в шести языках; используйте integer или x-funora-type`)
  }

  if (prop.type === 'string' && !delegated) {
    const constrained = Array.isArray(prop.enum) || typeof prop.pattern === 'string'
    const justified = prop['x-funora-sensitivity'] || prop['x-funora-plain'] === true
    if (!constrained && !justified) {
      fail(file, `${pointer}: сырой string без x-funora-type, enum, pattern или явного ` +
        `обоснования - доменное поле обязано иметь объявленное представление`)
    }
  }

  if (prop.type === 'integer' && !delegated && !prop.description) {
    fail(file, `${pointer}: integer без description - единица измерения не выводится из типа`)
  }

  if (Array.isArray(prop.enum)) {
    const hasFallback = typeof prop['x-funora-unknown-fallback'] === 'string'
    const closed = prop['x-funora-closed'] === true
    if (!hasFallback && !closed) {
      fail(file, `${pointer}: перечисление без x-funora-unknown-fallback и без ` +
        `x-funora-closed - новое значение на стороне площадки сломает пользователей`)
    }
    if (hasFallback && !prop.enum.includes(prop['x-funora-unknown-fallback'])) {
      fail(file, `${pointer}: запасное значение «${prop['x-funora-unknown-fallback']}» ` +
        `отсутствует среди вариантов перечисления`)
    }
  }

  if (prop.type === 'object' && prop.properties) {
    for (const [k, v] of Object.entries(prop.properties)) {
      checkProperty(file, `${pointer}.${k}`, v)
    }
  }
}

/**
 * Проверяет все файлы моделей.
 *
 * @returns {number} Количество проверенных схем.
 */
function checkModels() {
  const files = walk(path.join(SPEC, 'models'), '.schema.json')
  if (files.length === 0) fail('spec/models', 'не найдено ни одной схемы')

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      fail(rel, `не разбирается как JSON: ${e.message}`)
      continue
    }

    if (!doc.$id) fail(rel, 'отсутствует $id')
    if (!doc.title) fail(rel, 'отсутствует title')
    if (!doc.description) fail(rel, 'отсутствует description')
    if (doc.additionalProperties !== false) {
      fail(rel, 'additionalProperties должно быть false - иначе схема не описывает ' +
        'форму объекта, а лишь его минимум, и реализации разойдутся на лишних полях')
    }

    for (const [name, prop] of Object.entries(doc.properties || {})) {
      checkProperty(rel, `properties.${name}`, prop)
    }

    // Поле, которое может не наблюдаться, обязано быть необязательным: иначе схема
    // требует значение, которого у площадки может не быть, и парсер вынужден
    // подставить умолчание - ровно тот случай, ради которого флаг и введён.
    const required = new Set(doc.required || [])
    for (const [name, prop] of Object.entries(doc.properties || {})) {
      if (prop['x-funora-observability'] === 'unobserved-possible' && required.has(name)) {
        fail(rel, `properties.${name}: помечено как «может не наблюдаться», но входит в required`)
      }
    }
  }
  return files.length
}

/**
 * Проверяет таксономию ошибок.
 *
 * @returns {number} Количество проверенных записей об ошибках.
 */
function checkErrors() {
  const file = path.join(SPEC, 'errors', 'errors.yaml')
  if (!fs.existsSync(file)) {
    fail('spec/errors/errors.yaml', 'файл отсутствует')
    return 0
  }
  const doc = readYaml(file)
  const errors = doc.errors || {}
  const names = Object.keys(errors)
  const rel = 'spec/errors/errors.yaml'

  const ids = new Map()
  const codes = new Map()
  let roots = 0

  for (const [name, e] of Object.entries(errors)) {
    for (const field of ['stable_id', 'abi_code', 'retryable', 'side_effects_possible', 'since_spec', 'summary']) {
      if (e[field] === undefined) fail(rel, `${name}: отсутствует обязательное поле ${field}`)
    }

    if (ids.has(e.stable_id)) fail(rel, `${name}: stable_id «${e.stable_id}» уже занят записью ${ids.get(e.stable_id)}`)
    else ids.set(e.stable_id, name)

    if (codes.has(e.abi_code)) fail(rel, `${name}: abi_code ${e.abi_code} уже занят записью ${codes.get(e.abi_code)} - ` +
      `числовой код попадает в бинарный интерфейс C-SDK и не переиспользуется никогда`)
    else codes.set(e.abi_code, name)

    if (e.parent === null || e.parent === undefined) roots++
    else if (!names.includes(e.parent)) fail(rel, `${name}: родитель «${e.parent}» не определён`)

    // Ошибка, допускающая автоматический повтор при возможных побочных эффектах,
    // обязана объяснить это в summary: молчаливое сочетание приводит к дублированию
    // операций с деньгами.
    if (e.retryable === true && e.side_effects_possible === true) {
      const s = String(e.summary || '')
      if (!/повтор|идемпотент|сверк|неизвест/i.test(s)) {
        fail(rel, `${name}: retryable вместе с side_effects_possible, но summary не оговаривает ` +
          `условие безопасного повтора`)
      }
    }
  }

  if (roots !== 1) fail(rel, `корней дерева должно быть ровно 1, найдено ${roots}`)

  // Циклы: поднимаемся к корню от каждой записи.
  for (const name of names) {
    const seen = new Set()
    let cur = name
    while (cur) {
      if (seen.has(cur)) { fail(rel, `${name}: цикл в цепочке родителей`); break }
      seen.add(cur)
      cur = errors[cur] && errors[cur].parent
    }
  }

  return names.length
}

/**
 * Проверяет согласованность файла версий.
 *
 * @returns {void}
 */
function checkVersion() {
  const file = path.join(SPEC, 'version.yaml')
  const rel = 'spec/version.yaml'
  if (!fs.existsSync(file)) { fail(rel, 'файл отсутствует'); return }
  const v = readYaml(file)

  if (!/^\d+\.\d+\.\d+$/.test(String(v.spec_version || ''))) {
    fail(rel, 'spec_version должен иметь вид MAJOR.MINOR.PATCH')
  }
  if (!['draft', 'released'].includes(v.status)) {
    fail(rel, 'status должен быть draft или released')
  }
  if (!Number.isInteger(v.canonical_form_version)) {
    fail(rel, 'canonical_form_version должен быть целым числом')
  }
  if (!Array.isArray(v.supported_locales) || v.supported_locales.length === 0) {
    fail(rel, 'supported_locales не может быть пустым - парсер, завязанный на текст, ' +
      'обязан объявить, на каких локалях он проверен')
  }

  // Версия в моделях не должна опережать объявленную.
  for (const file of walk(path.join(SPEC, 'models'), '.schema.json')) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const declared = doc['x-funora-spec-version']
    if (declared && declared !== v.spec_version) {
      fail(path.relative(ROOT, file).replace(/\\/g, '/'),
        `x-funora-spec-version «${declared}» не совпадает с spec_version «${v.spec_version}»`)
    }
  }
}

/**
 * Точка входа. Выполняет все проверки и печатает отчёт.
 *
 * @returns {void}
 */
function main() {
  KNOWN_TYPES = loadTypes()
  checkVersion()
  const models = checkModels()
  const errors = checkErrors()

  console.log(`типов: ${KNOWN_TYPES.size} | схем: ${models} | ошибок в таксономии: ${errors}`)

  if (problems.length === 0) {
    console.log('нарушений не найдено')
    process.exit(0)
  }

  console.log(`\nнарушений: ${problems.length}\n`)
  const byFile = new Map()
  for (const p of problems) {
    if (!byFile.has(p.where)) byFile.set(p.where, [])
    byFile.get(p.where).push(p.what)
  }
  for (const [where, list] of byFile) {
    console.log(`  ${where}`)
    for (const w of list) console.log(`    - ${w}`)
  }
  process.exit(1)
}

main()

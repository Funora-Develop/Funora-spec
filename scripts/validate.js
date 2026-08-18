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
 * Загружает идентификаторы объявленных возможностей.
 *
 * @returns {Set<string>} Множество идентификаторов из spec/capabilities.yaml.
 */
function loadCapabilities() {
  const file = path.join(SPEC, 'capabilities.yaml')
  if (!fs.existsSync(file)) {
    fail('spec/capabilities.yaml', 'файл отсутствует')
    return new Set()
  }
  const doc = readYaml(file)
  const ids = Object.keys(doc.capabilities || {})
  const rel = 'spec/capabilities.yaml'

  // Пять состояний обязаны быть объявлены целиком: реализация, знающая только про
  // supported и unsupported, молча схлопнет остальные три в одно из двух.
  const required = ['supported', 'unsupported', 'experimental', 'degraded', 'unknown']
  for (const s of required) {
    if (!doc.states || !doc.states[s]) fail(rel, `не объявлено состояние «${s}»`)
  }
  // unknown обязан быть usable: иначе вызов блокируется до пробы, и молчаливый
  // уход в else-ветку становится возможен.
  if (doc.states && doc.states.unknown && doc.states.unknown.usable !== true) {
    fail(rel, 'состояние unknown обязано быть usable - иначе неудачная проба ' +
      'блокирует вызов и пользовательский код тихо идёт по ветке «не поддерживается»')
  }
  if (doc.states && doc.states.unsupported && doc.states.unsupported.usable !== false) {
    fail(rel, 'состояние unsupported обязано быть не usable')
  }

  for (const [id, c] of Object.entries(doc.capabilities || {})) {
    if (!c.summary) fail(rel, `${id}: отсутствует summary`)
    if (!['static', 'probe', 'derived'].includes(c.source)) {
      fail(rel, `${id}: source должен быть static, probe или derived`)
    }
    if (c.source === 'derived' && !c.derived_from) {
      fail(rel, `${id}: source=derived требует derived_from`)
    }
    if (c.derived_from && !ids.includes(c.derived_from)) {
      fail(rel, `${id}: derived_from ссылается на несуществующую возможность «${c.derived_from}»`)
    }
    if (c.source === 'probe' && c.initial !== 'unknown') {
      fail(rel, `${id}: возможность, зависящая от аккаунта, обязана стартовать с unknown, ` +
        `а не с «${c.initial}» - до пробы её состояние неизвестно`)
    }
  }
  return new Set(ids)
}

/**
 * Проверяет описания операций сервисов.
 *
 * @param {Set<string>} caps Идентификаторы объявленных возможностей.
 * @param {Set<string>} errIds Идентификаторы объявленных ошибок.
 * @returns {number} Количество проверенных операций.
 */
function checkServices(caps, errIds) {
  const dir = path.join(SPEC, 'services')
  const files = walk(dir, '.yaml')
  if (files.length === 0) { fail('spec/services', 'не найдено ни одного сервиса'); return 0 }

  const SAFETY = ['safe', 'idempotent', 'unsafe']
  const CLASS = ['interactive', 'poll', 'automation', 'monitoring']
  // Формулировки, которыми в прозе прячут необязательность функции. Каждая обязана
  // быть привязана к идентификатору возможности, иначе шесть реализаций разрешат
  // её по-своему, а conformance этого не увидит.
  const CONDITIONAL = /если|там,? где|при наличии|когда доступн|если удаётся|если интерфейс/i

  let count = 0
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const doc = readYaml(file)
    for (const [id, op] of Object.entries(doc.operations || {})) {
      count++
      if (!op.summary) fail(rel, `${id}: отсутствует summary`)
      if (!SAFETY.includes(op.safety)) {
        fail(rel, `${id}: safety должен быть safe, idempotent или unsafe - от него ` +
          `зависит решение о повторе`)
      }
      if (!CLASS.includes(op.request_class)) {
        fail(rel, `${id}: request_class должен быть interactive, poll, automation или monitoring`)
      }
      if (op.capability && !caps.has(op.capability)) {
        fail(rel, `${id}: ссылается на необъявленную возможность «${op.capability}»`)
      }
      if (!op.capability) fail(rel, `${id}: не привязана ни к одной возможности`)

      if (op.safety === 'idempotent' && !Array.isArray(op.idempotency_key_from)) {
        fail(rel, `${id}: operation объявлена idempotent, но не задан idempotency_key_from - ` +
          `без ключа она ведёт себя как unsafe`)
      }
      if (op.safety === 'unsafe' && op.requires_reconciliation !== true) {
        fail(rel, `${id}: небезопасная операция обязана объявить requires_reconciliation - ` +
          `при неоднозначном исходе повтор недопустим, нужна сверка состояния`)
      }
      if (op.safety === 'safe' && op.idempotency_key_from) {
        fail(rel, `${id}: у операции чтения не может быть ключа идемпотентности`)
      }

      for (const e of op.errors || []) {
        if (!errIds.has(e)) fail(rel, `${id}: ссылается на несуществующий код ошибки «${e}»`)
      }

      if (CONDITIONAL.test(op.summary || '') && !op.capability) {
        fail(rel, `${id}: описание содержит условную формулировку, но возможность не указана`)
      }
    }
  }
  return count
}

/**
 * Проверяет политику повторов на связность с таксономией ошибок.
 *
 * @param {Map<string, object>} errByStableId Ошибки, проиндексированные по stable_id.
 * @returns {number} Количество проверенных политик.
 */
function checkRetryPolicy(errByStableId) {
  const file = path.join(SPEC, 'protocol', 'retry-policy.yaml')
  const rel = 'spec/protocol/retry-policy.yaml'
  if (!fs.existsSync(file)) { fail(rel, 'файл отсутствует'); return 0 }
  const doc = readYaml(file)

  const cap = doc.limits && doc.limits.max_retry_after_ms && doc.limits.max_retry_after_ms.value
  if (!Number.isInteger(cap)) {
    fail(rel, 'не задан limits.max_retry_after_ms - без верхней границы битое или ' +
      'враждебное значение Retry-After вешает цикл опроса на сутки')
  }

  let count = 0
  for (const [id, p] of Object.entries(doc.policies || {})) {
    count++
    if (!errByStableId.has(id)) {
      fail(rel, `политика для «${id}» не соответствует ни одной ошибке в таксономии`)
      continue
    }
    const err = errByStableId.get(id)
    if (!Number.isInteger(p.max_attempts) || p.max_attempts < 1) {
      fail(rel, `${id}: max_attempts должен быть целым не меньше 1`)
    }
    if (err.retryable === false && p.max_attempts > 1) {
      fail(rel, `${id}: ошибка помечена как неповторяемая, но политика разрешает ` +
        `${p.max_attempts} попытки`)
    }
    if (err.retryable === true && p.max_attempts > 1) {
      for (const f of ['base_ms', 'multiplier', 'cap_ms', 'jitter']) {
        if (p[f] === undefined) fail(rel, `${id}: отсутствует параметр ${f}`)
      }
      if (p.jitter && p.jitter !== 'full') {
        fail(rel, `${id}: разброс обязан быть полным - детерминированный backoff ` +
          `синхронизирует несколько клиентов на одном адресе в согласованную волну`)
      }
    }
    if (p.respect_retry_after === true && !Number.isInteger(p.max_retry_after_ms)) {
      fail(rel, `${id}: respect_retry_after без max_retry_after_ms`)
    }
  }

  // Каждая повторяемая ошибка обязана иметь политику: отсутствие записи нельзя
  // истолковать как «политика не определена, попробуем ещё раз».
  for (const [stableId, err] of errByStableId) {
    if (err.retryable === true && !doc.policies[stableId]) {
      fail(rel, `для повторяемой ошибки «${stableId}» не задана политика`)
    }
  }
  return count
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

  const caps = loadCapabilities()
  const errDoc = readYaml(path.join(SPEC, 'errors', 'errors.yaml'))
  const errByStableId = new Map(
    Object.values(errDoc.errors || {}).map(e => [e.stable_id, e])
  )
  const ops = checkServices(caps, new Set(errByStableId.keys()))
  const policies = checkRetryPolicy(errByStableId)

  console.log(`типов: ${KNOWN_TYPES.size} | схем: ${models} | ошибок: ${errors} | ` +
    `возможностей: ${caps.size} | операций: ${ops} | политик повтора: ${policies}`)

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

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

/** Накопленные предупреждения: не блокируют, но требуют внимания. */
const warnings = []

/**
 * Регистрирует предупреждение.
 *
 * @param {string} where Путь к файлу или логическое место.
 * @param {string} what Описание на русском языке.
 * @returns {void}
 */
function warn(where, what) {
  warnings.push({ where, what })
}

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
 * Проверяет схемы событий и их согласованность с контрактом доставки.
 *
 * @returns {number} Количество проверенных типов событий.
 */
function checkEvents() {
  const dir = path.join(SPEC, 'events')
  const rel = 'spec/events/delivery.yaml'
  const files = walk(dir, '.schema.json')
  if (files.length === 0) { fail('spec/events', 'не найдено ни одной схемы события'); return 0 }

  // Конверт: ключ упорядочивания обязателен. Опциональный ключ означает, что часть
  // событий не имеет порядка ни с чем и может быть обработана в любой момент,
  // в том числе после события, которое логически следует за ней.
  const envFile = path.join(dir, 'envelope.schema.json')
  if (!fs.existsSync(envFile)) {
    fail('spec/events/envelope.schema.json', 'конверт события отсутствует')
  } else {
    const env = JSON.parse(fs.readFileSync(envFile, 'utf8'))
    const req = new Set(env.required || [])
    for (const f of ['id', 'type', 'account_id', 'ordering_key', 'observed_at', 'origin', 'payload']) {
      if (!req.has(f)) {
        fail('spec/events/envelope.schema.json', `поле ${f} обязано входить в required`)
      }
    }
    const ar = (env.properties || {}).adapter_revision
    if (ar && !/диагностик/i.test(ar.description || '')) {
      fail('spec/events/envelope.schema.json',
        'adapter_revision обязан быть помечен как исключительно диагностический - ' +
        'адаптер обновляется при каждом исправлении разметки, и его участие в ' +
        'идентичности события обнулит ключи идемпотентности у пользователей')
    }
  }

  if (!fs.existsSync(path.join(SPEC, 'events', 'delivery.yaml'))) {
    fail(rel, 'контракт доставки отсутствует')
    return files.length
  }
  const d = readYaml(path.join(SPEC, 'events', 'delivery.yaml'))

  if (!d.guarantee || !['at_least_once', 'at_most_once'].includes(d.guarantee.kind)) {
    fail(rel, 'не зафиксирована гарантия доставки - без неё обе реализации законны, ' +
      'и одна теряет оплаченный заказ, а другая выдаёт товар дважды')
  }
  if (d.ordering && d.ordering.key_required !== true) {
    fail(rel, 'ordering.key_required обязано быть true')
  }
  if (d.deduplication && d.deduplication.durability_required !== true) {
    fail(rel, 'кэш дедупликации обязан переживать рестарт - иначе после каждого ' +
      'перезапуска повторно приходит всё, что успело прийти до него')
  }

  // Каждому типу события ровно одно правило вывода ключа, и наоборот.
  const declared = new Set()
  for (const file of files) {
    if (path.basename(file) === 'envelope.schema.json') continue
    const r = path.relative(ROOT, file).replace(/\\/g, '/')
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const t = doc['x-funora-event-type']
    if (!t) { fail(r, 'отсутствует x-funora-event-type'); continue }
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(t)) {
      fail(r, `идентификатор типа «${t}» не соответствует форме область.действие`)
    }
    if (declared.has(t)) fail(r, `тип события «${t}» объявлен повторно`)
    declared.add(t)
  }

  const derivation = new Set(Object.keys((d.ordering && d.ordering.derivation) || {}))
  for (const t of declared) {
    if (!derivation.has(t)) fail(rel, `для типа «${t}» не задано правило вывода ключа упорядочивания`)
  }
  for (const t of derivation) {
    if (!declared.has(t)) fail(rel, `правило вывода ключа задано для несуществующего типа «${t}»`)
  }

  // Полосы обслуживания ссылаются только на существующие типы, и каждый тип
  // отнесён ровно к одной полосе: иначе политика переполнения для него не определена.
  const lanes = (d.backpressure && d.backpressure.lanes) || {}
  const seen = new Map()
  for (const [lane, cfg] of Object.entries(lanes)) {
    for (const t of cfg.carries || []) {
      if (!declared.has(t)) fail(rel, `полоса ${lane} ссылается на несуществующий тип «${t}»`)
      if (seen.has(t)) fail(rel, `тип «${t}» отнесён и к полосе ${seen.get(t)}, и к ${lane}`)
      seen.set(t, lane)
    }
  }
  for (const t of declared) {
    if (!seen.has(t)) fail(rel, `тип «${t}» не отнесён ни к одной полосе - политика ` +
      `переполнения для него не определена`)
  }

  return declared.size
}

/**
 * Проверяет бюджет запросов и расписание опроса.
 *
 * @returns {void}
 */
function checkBudget() {
  const file = path.join(SPEC, 'runtime', 'budget.yaml')
  const rel = 'spec/runtime/budget.yaml'
  if (!fs.existsSync(file)) { fail(rel, 'файл отсутствует'); return }
  const d = readYaml(file)

  if (!d.scope || d.scope.primary !== 'outbound_identity') {
    fail(rel, 'область бюджета обязана быть outbound_identity - ограничение накладывает ' +
      'площадка на сетевую идентичность, а не на объект Client. Пять клиентов в одном ' +
      'процессе, каждый со своим бюджетом, дают пятикратную нагрузку с одного адреса')
  }

  for (const b of ['host', 'account', 'write']) {
    const v = (d.buckets || {})[b]
    if (!v) { fail(rel, `не задано ведро ${b}`); continue }
    for (const f of ['capacity', 'refill_per_second', 'burst']) {
      if (typeof v[f] !== 'number') fail(rel, `ведро ${b}: отсутствует числовой ${f}`)
    }
  }

  if (d.counting && d.counting.counts_retries !== true) {
    fail(rel, 'повторы обязаны расходовать бюджет - иначе шторм повторов бесплатен ' +
      'ровно в тот момент, когда площадке хуже всего')
  }

  const s = d.scheduling || {}
  for (const f of ['active_interval_ms', 'idle_step_multiplier', 'max_interval_ms',
    'activity_window_ms', 'min_floor_ms']) {
    if (typeof s[f] !== 'number') fail(rel, `scheduling: отсутствует числовой ${f}`)
  }
  if (typeof s.min_floor_ms === 'number' && typeof s.active_interval_ms === 'number' &&
      s.min_floor_ms > s.active_interval_ms) {
    fail(rel, 'min_floor_ms больше active_interval_ms - активный интервал недостижим')
  }

  const classes = d.classes || {}
  const sum = Object.values(classes).reduce((a, c) => a + (c.floor_share || 0), 0)
  if (Math.abs(sum - 1) > 0.001) {
    fail(rel, `сумма гарантированных долей классов равна ${sum.toFixed(3)}, а должна быть 1`)
  }
  const mon = classes.monitoring
  if (mon && mon.preemptible !== 'cancellable') {
    fail(rel, 'мониторинг обязан быть отменяемым - иначе наблюдение за рынком вытесняет ' +
      'ответы покупателям, потому что создаёт больше запросов и выигрывает очередь')
  }
}

/**
 * Проверяет идентификаторы спецификации на соответствие правилам именования.
 *
 * @returns {{checked: number, collisions: number}} Число проверенных имён и коллизий.
 */
function checkNaming() {
  const file = path.join(SPEC, 'naming.yaml')
  const rel = 'spec/naming.yaml'
  if (!fs.existsSync(file)) { fail(rel, 'файл отсутствует'); return { checked: 0, collisions: 0 } }
  const n = readYaml(file)

  /**
   * Приводит идентификатор спецификации к стилю конкретного языка.
   *
   * Сравнивать с ключевыми словами нужно именно приведённое имя. Иначе `event`
   * ложно срабатывает для C#, хотя в PascalCase станет `Event` и никакого
   * столкновения не будет.
   *
   * @param {string} name Идентификатор в snake_case, как он записан в спецификации.
   * @param {string} style Стиль языка из раздела casing.
   * @param {string} prefix Префикс для C.
   * @returns {string} Идентификатор в стиле языка.
   */
  function toStyle(name, style, prefix) {
    const parts = name.split('_').filter(Boolean)
    if (style === 'camelCase') {
      return parts[0] + parts.slice(1).map(p => p[0].toUpperCase() + p.slice(1)).join('')
    }
    if (style === 'PascalCase') {
      return parts.map(p => p[0].toUpperCase() + p.slice(1)).join('')
    }
    if (style === 'snake_case_with_prefix') return (prefix || '') + name
    return name
  }

  const casing = n.casing || {}
  const prefix = n.c_prefix || ''
  const keywords = {}
  for (const [lang, words] of Object.entries(n.reserved || {})) keywords[lang] = new Set(words)
  const shadows = {}
  for (const [lang, words] of Object.entries(n.shadows || {})) shadows[lang] = new Set(words)

  const idPattern = new RegExp((n.form && n.form.spec_identifiers && n.form.spec_identifiers.pattern) || '^[a-z][a-z0-9_]*$')
  const maxLen = n.max_identifier_length || 48
  const badPrefix = (n.forbidden_prefixes || []).map(p => p.value)
  const badSuffix = (n.forbidden_suffixes || []).map(p => p.value)

  /** Собранные идентификаторы: имя -> список мест, где встречается. */
  const found = new Map()
  const add = (name, where) => {
    if (!found.has(name)) found.set(name, [])
    found.get(name).push(where)
  }

  for (const f of walk(path.join(SPEC, 'models'), '.schema.json')) {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'))
    const base = path.basename(f, '.schema.json')
    for (const [k, v] of Object.entries(doc.properties || {})) {
      add(k, `models/${base}`)
      for (const e of v.enum || []) add(e, `models/${base}.${k}`)
    }
  }
  for (const f of walk(path.join(SPEC, 'events'), '.schema.json')) {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'))
    const base = path.basename(f, '.schema.json')
    for (const [k, v] of Object.entries(doc.properties || {})) {
      add(k, `events/${base}`)
      for (const e of v.enum || []) add(e, `events/${base}.${k}`)
    }
    const t = doc['x-funora-event-type']
    if (t) for (const seg of t.split('.')) add(seg, `events/${base}#type`)
  }
  const caps = readYaml(path.join(SPEC, 'capabilities.yaml'))
  for (const id of Object.keys(caps.capabilities || {})) {
    for (const seg of id.split('.')) add(seg, 'capabilities')
  }
  for (const f of walk(path.join(SPEC, 'services'), '.yaml')) {
    const doc = readYaml(f)
    for (const id of Object.keys(doc.operations || {})) {
      for (const seg of id.split('.')) add(seg, `services/${doc.service}`)
    }
  }

  let collisions = 0
  let softCollisions = 0
  for (const [name, places] of found) {
    const where = rel + ' <- ' + [...new Set(places)].slice(0, 2).join(', ')

    if (!/^[\x20-\x7E]*$/.test(name)) {
      fail(where, `идентификатор «${name}» содержит не-ASCII - экспортируемые символы C ` +
        `не могут стабильно быть не-ASCII, а conformance сравнивает идентификаторы как строки`)
      continue
    }
    if (!idPattern.test(name)) {
      fail(where, `идентификатор «${name}» не соответствует форме snake_case`)
    }
    if (name.length > maxLen) {
      fail(where, `идентификатор «${name}» длиннее ${maxLen} символов`)
    }
    for (const p of badPrefix) {
      if (name.startsWith(p)) fail(where, `идентификатор «${name}» начинается с запрещённого «${p}»`)
    }
    for (const s of badSuffix) {
      if (name.endsWith(s)) fail(where, `идентификатор «${name}» оканчивается запрещённым «${s}»`)
    }
    // Ключевое слово: код с таким именем не собирается вообще. Экранирование
    // спасает поле или параметр, но имя операции экранировать некуда - вызов
    // client.lots.raise() не разберёт интерпретатор.
    const hard = []
    const soft = []
    for (const lang of Object.keys(casing)) {
      const styled = toStyle(name, casing[lang], prefix)
      if (keywords[lang] && keywords[lang].has(styled)) hard.push(lang)
      else if (shadows[lang] && shadows[lang].has(styled)) soft.push(lang)
    }

    const isOperationSegment = places.some(p => p.startsWith('services/'))
    if (hard.length && isOperationSegment) {
      fail(where, `«${name}» - ключевое слово в ${hard.join(', ')}, и это сегмент имени ` +
        `операции. Экранировать его некуда: вызов с таким именем не разбирается. Переименуйте.`)
    } else if (hard.length) {
      warn(where, `«${name}» - ключевое слово в ${hard.join(', ')}; будет сгенерировано «${name}_»`)
      collisions++
    }
    if (soft.length) softCollisions++
  }

  if (softCollisions) {
    warn(rel, `имён, затеняющих встроенные: ${softCollisions}. Затенение легально ` +
      `и экранирования не требует, переименование не нужно.`)
  }

  return { checked: found.size, collisions }
}

/**
 * Точка входа. Выполняет все проверки и печатает отчёт.
 *
 * @returns {void}
 */
/**
 * Проверяет правила извлечения данных из разметки.
 *
 * Инвариант здесь один, и он самый важный во всём файле: правило, помеченное
 * как наблюдённое, обязано ссылаться на снимок. Придуманный селектор хуже
 * отсутствующего - отсутствующий виден сразу, придуманный тихо ломает разбор у
 * всех шести реализаций. Само существование селектора в снимке проверяется в
 * Funora-python, где лежат фикстуры и есть чем их разобрать; здесь
 * проверяется, что ссылка вообще проставлена.
 *
 * @returns {{files: number, rules: number, selectors: Array<{selector: string, evidence: string[]}>}}
 *   Число проверенных файлов, число правил с пометкой уверенности и перечень
 *   наблюдённых селекторов с указанием снимков.
 */
function checkExtraction() {
  const dir = path.join(SPEC, 'extraction')
  if (!fs.existsSync(dir)) return { files: 0, rules: 0, selectors: [] }

  const LEVELS = new Set(['observed', 'inferred', 'assumed'])
  const selectors = []
  let files = 0
  let rules = 0

  for (const file of walk(dir, '.yaml')) {
    files += 1
    const rel = path.relative(ROOT, file)
    const doc = readYaml(file)
    if (!doc) continue

    if (!doc.version) fail(rel, 'нет поля version')

    // Ссылка на снимок наследуется от ближайшего предка, который её объявил.
    // Иначе evidence пришлось бы повторять у каждого поля, а повторение в таком
    // месте приводит к тому, что копии расходятся и перестают что-либо значить.
    const visit = (node, pointer, inherited) => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => visit(item, `${pointer}[${i}]`, inherited))
        return
      }
      if (!node || typeof node !== 'object') return

      const own = node.evidence
      const evidence = own
        ? (Array.isArray(own) ? own : [own])
        : inherited

      if (typeof node.confidence === 'string') {
        rules += 1
        if (!LEVELS.has(node.confidence)) {
          fail(rel, `${pointer}: неизвестная пометка уверенности "${node.confidence}"`)
        }
        if (node.confidence === 'assumed') {
          fail(rel, `${pointer}: правило с пометкой assumed не может быть в контракте, ` +
            'предположение даёт молчаливый отказ')
        }
        if (node.confidence === 'observed' && !evidence) {
          fail(rel, `${pointer}: пометка observed без ссылки на снимок ни в самом ` +
            'правиле, ни у любого из его предков')
        }
        const sel = node.selector || node.selectors
        if (node.confidence === 'observed' && sel && evidence) {
          const list = Array.isArray(sel) ? sel : [sel]
          for (const one of list) {
            if (one.startsWith('self')) continue
            // Разделитель приводится к косой черте: иначе файл перестраивается
            // по-разному на Windows и на Linux, и проверка свежести падает в CI
            // на ровном месте.
            const where = `${rel.split(path.sep).join('/')}:${pointer}`
            selectors.push({ selector: one, evidence, where })
          }
        }
      }

      if (node.enum_is_closed === false && node.unknown_fallback !== 'required') {
        fail(rel, `${pointer}: открытое перечисление обязано требовать запасное значение ` +
          'для незнакомого, иначе незнакомое состояние станет ошибкой')
      }

      for (const key of Object.keys(node)) visit(node[key], `${pointer}.${key}`, evidence)
    }

    visit(doc, path.basename(file, '.yaml'), null)
  }

  const inventory = path.join(dir, 'observed-selectors.json')
  const body = JSON.stringify(
    selectors.sort((a, b) => a.selector.localeCompare(b.selector)), null, 2) + '\n'
  const previous = fs.existsSync(inventory) ? fs.readFileSync(inventory, 'utf8') : ''
  if (previous !== body) {
    if (process.env.FUNORA_WRITE_INVENTORY === '1') {
      fs.writeFileSync(inventory, body)
    } else {
      fail(path.relative(ROOT, inventory),
        'перечень наблюдённых селекторов устарел. Перестройте его командой ' +
        'FUNORA_WRITE_INVENTORY=1 node scripts/validate.js')
    }
  }

  return { files, rules, selectors }
}

/**
 * Проверяет таблицу соответствия вердиктов ошибкам.
 *
 * Таблица связывает два файла, которые правятся порознь: классы ответа и
 * каталог ошибок. Ссылка на несуществующую ошибку не видна ни при чтении, ни
 * при разборе YAML, а проявляется отказом в момент, когда реализация пытается
 * поднять ошибку по вердикту - то есть ровно тогда, когда что-то уже пошло не
 * так.
 *
 * @param {Set<string>} errIds Устойчивые идентификаторы из каталога ошибок.
 * @returns {number} Число проверенных записей таблицы.
 */
function checkResponseClasses(errIds) {
  const file = path.join(SPEC, 'protocol', 'response-classes.yaml')
  if (!fs.existsSync(file)) return 0
  const rel = path.relative(ROOT, file).split(path.sep).join('/')
  const doc = readYaml(file)
  if (!doc) return 0

  const classes = new Set(Object.keys(doc.classes || {}))
  const table = doc.verdict_errors || {}
  let checked = 0

  for (const [cls, rows] of Object.entries(table)) {
    if (!classes.has(cls)) {
      fail(rel, `verdict_errors.${cls}: класс ответа не объявлен в classes`)
    }
    for (const [reason, stableId] of Object.entries(rows || {})) {
      checked += 1
      if (stableId === null) continue
      if (!errIds.has(stableId)) {
        fail(rel, `verdict_errors.${cls}.${reason}: ошибки ${stableId} нет в каталоге`)
      }
    }
  }

  for (const cls of classes) {
    if (!(cls in table)) {
      fail(rel, `класс ответа ${cls} объявлен, но не имеет ни одной записи в ` +
        'verdict_errors: реализации выберут ошибку сами и разойдутся')
    }
  }

  if (!doc.pipeline || doc.pipeline.order_is_normative !== true) {
    fail(rel, 'порядок шагов обязан быть объявлен нормативным: без этого ' +
      'реализации проверят условия в разном порядке')
  }

  return checked
}

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
  const events = checkEvents()
  checkBudget()
  const naming = checkNaming()
  const extraction = checkExtraction()
  const responseRows = checkResponseClasses(new Set(errByStableId.keys()))

  console.log(`типов: ${KNOWN_TYPES.size} | схем: ${models} | ошибок: ${errors} | ` +
    `возможностей: ${caps.size} | операций: ${ops} | политик: ${policies} | ` +
    `событий: ${events} | идентификаторов: ${naming.checked} | ` +
    `правил извлечения: ${extraction.rules} в ${extraction.files} файлах, ` +
    `наблюдённых селекторов: ${extraction.selectors.length} | ` +
    `вердиктов: ${responseRows}`)

  if (warnings.length) {
    console.log('')
    console.log('предупреждений: ' + warnings.length)
    for (const w of warnings) console.log('  ' + w.what)
  }

  if (problems.length === 0) {
    console.log('')
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

#!/usr/bin/env node
/**
 * Классификатор изменений спецификации.
 *
 * Сравнивает рабочее дерево с базовой точкой в git, определяет класс каждого
 * изменения по spec/compat-rules.yaml и вычисляет минимально необходимый bump
 * версии. Затем сверяет его с тем, что фактически объявлено в spec/version.yaml.
 *
 * Зачем это нужно. Правила эволюции, записанные прозой, не соблюдаются: человек
 * не помнит наизусть семнадцать классов изменений, а самый опасный из них -
 * ослабление поля с required до optional - выглядит как безобидное послабление и
 * классифицируется неверно чаще всего. Проверка снимает это с человека.
 *
 * Запуск:
 *   node scripts/compat.js                 сравнить с origin/main
 *   node scripts/compat.js --base HEAD~1   сравнить с предыдущим коммитом
 *   node scripts/compat.js --strict        падать даже в статусе draft
 *
 * Код возврата: 0 - объявленный bump достаточен, 1 - нет.
 */

'use strict'

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const ROOT = path.resolve(__dirname, '..')
const SPEC = 'spec'

/** Порядок строгости. Больше - строже. */
const RANK = { none: 0, patch: 1, minor: 2, major: 3, forbidden: 4 }

/** Найденные изменения. */
const changes = []

/**
 * Сообщает, расширился ли набор допустимых типов.
 *
 * @param {string|string[]|undefined} was Тип до изменения.
 * @param {string|string[]|undefined} now Тип после изменения.
 * @returns {boolean} true, если новый набор содержит весь прежний и ещё что-то.
 */
function widens(was, now) {
  const before = new Set(was === undefined ? [] : [].concat(was))
  const after = new Set(now === undefined ? [] : [].concat(now))
  if (after.size <= before.size) return false
  for (const item of before) {
    if (!after.has(item)) return false
  }
  return true
}

/**
 * Сравнивает объявления типа, учитывая массивы.
 *
 * @param {string|string[]|undefined} was Тип до изменения.
 * @param {string|string[]|undefined} now Тип после изменения.
 * @returns {boolean} true, если типы совпадают по содержимому.
 */
function sameType(was, now) {
  const left = was === undefined ? [] : [].concat(was)
  const right = now === undefined ? [] : [].concat(now)
  if (left.length !== right.length) return false
  const l = [...left].sort()
  const r = [...right].sort()
  return l.every((item, index) => item === r[index])
}

/**
 * Показывает объявление типа человеку.
 *
 * @param {string|string[]|undefined} value Тип.
 * @returns {string} Читаемое представление.
 */
function showType(value) {
  if (value === undefined) return 'нет'
  return [].concat(value).join('|')
}

/**
 * Регистрирует изменение спецификации.
 *
 * @param {string} kind Класс изменения из spec/compat-rules.yaml.
 * @param {string} where Место, где изменение обнаружено.
 * @param {string} what Человекочитаемое описание на русском языке.
 * @returns {void}
 */
function change(kind, where, what) {
  changes.push({ kind, where, what })
}

/**
 * Выполняет команду git и возвращает её вывод.
 *
 * @param {string[]} args Аргументы команды.
 * @returns {string|null} Вывод команды или null, если команда завершилась ошибкой.
 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    return null
  }
}

/**
 * Определяет базовую точку сравнения.
 *
 * @param {string|null} explicit Значение, переданное через --base.
 * @returns {string} Ссылка git, пригодная для git show.
 */
function resolveBase(explicit) {
  if (explicit) return explicit
  const tag = git(['describe', '--tags', '--abbrev=0', '--match', 'spec-v*'])
  if (tag) return tag.trim()
  if (git(['rev-parse', '--verify', 'origin/main'])) return 'origin/main'
  return 'HEAD'
}

/**
 * Читает файл из базовой точки.
 *
 * @param {string} ref Ссылка git.
 * @param {string} rel Путь относительно корня репозитория.
 * @returns {string|null} Содержимое файла или null, если файла там нет.
 */
function readAt(ref, rel) {
  return git(['show', `${ref}:${rel}`])
}

/**
 * Список файлов спецификации в базовой точке.
 *
 * @param {string} ref Ссылка git.
 * @returns {string[]} Пути относительно корня репозитория.
 */
function listAt(ref) {
  const out = git(['ls-tree', '-r', '--name-only', ref, SPEC])
  return out ? out.split('\n').filter(Boolean) : []
}

/**
 * Список файлов спецификации в рабочем дереве.
 *
 * @returns {string[]} Пути относительно корня репозитория.
 */
function listNow() {
  const out = []
  const walk = (d) => {
    const abs = path.join(ROOT, d)
    if (!fs.existsSync(abs)) return
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = d + '/' + e.name
      if (e.isDirectory()) walk(rel)
      else out.push(rel)
    }
  }
  walk(SPEC)
  return out.sort()
}

/**
 * Разбирает содержимое файла спецификации.
 *
 * @param {string} rel Путь к файлу, нужен для выбора парсера.
 * @param {string|null} text Содержимое или null.
 * @returns {object|null} Разобранный документ или null.
 */
function parse(rel, text) {
  if (text === null || text === undefined) return null
  try {
    return rel.endsWith('.json') ? JSON.parse(text) : yaml.load(text)
  } catch (e) {
    return null
  }
}

/**
 * Сравнивает объявленные возможности.
 *
 * Файл не сравнивался вовсе: смена начального состояния возможности с supported
 * на unsupported превращала работающий код в отказ ещё до запроса, и
 * классификация об этом молчала.
 *
 * @param {object} was Прежнее содержимое spec/capabilities.yaml.
 * @param {object} now Нынешнее содержимое.
 * @returns {void}
 */
function diffCapabilities(was, now) {
  const rel = 'spec/capabilities.yaml'
  const before = was.capabilities || {}
  const after = now.capabilities || {}

  for (const name of Object.keys(after)) {
    if (!(name in before)) {
      change('add_capability', rel, `возможность ${name} объявлена`)
      continue
    }
    if (before[name].initial !== after[name].initial) {
      change('change_capability_initial', rel,
        `возможность ${name}: начальное состояние ${before[name].initial} -> ${after[name].initial}`)
    }
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) change('remove_capability', rel, `возможность ${name} удалена`)
  }
}

/**
 * Сравнивает политики повторов и их пределы.
 *
 * @param {object} was Прежнее содержимое spec/protocol/retry-policy.yaml.
 * @param {object} now Нынешнее содержимое.
 * @returns {void}
 */
function diffRetry(was, now) {
  const rel = 'spec/protocol/retry-policy.yaml'
  const before = was.policies || {}
  const after = now.policies || {}
  const fields = ['max_attempts', 'base_ms', 'multiplier', 'cap_ms', 'jitter',
                  'respect_retry_after', 'fail_closed', 'account_scoped']

  for (const name of Object.keys(after)) {
    if (!(name in before)) continue
    for (const field of fields) {
      if (before[name][field] !== after[name][field]) {
        change('change_retry_policy', rel,
          `политика ${name}: ${field} ${before[name][field]} -> ${after[name][field]}`)
      }
    }
  }
}

/**
 * Сравнивает числа бюджета.
 *
 * @param {object} was Прежнее содержимое spec/runtime/budget.yaml.
 * @param {object} now Нынешнее содержимое.
 * @returns {void}
 */
function diffBudget(was, now) {
  const rel = 'spec/runtime/budget.yaml'

  for (const bucket of Object.keys(now.buckets || {})) {
    const before = (was.buckets || {})[bucket]
    const after = now.buckets[bucket]
    if (!before) continue
    for (const field of ['capacity', 'refill_per_second', 'burst']) {
      if (before[field] !== after[field]) {
        change('change_budget_numbers', rel,
          `ведро ${bucket}: ${field} ${before[field]} -> ${after[field]}`)
      }
    }
  }

  for (const key of Object.keys(now.limits || {})) {
    const before = (was.limits || {})[key]
    if (before !== undefined && before !== now.limits[key]) {
      change('change_budget_numbers', rel, `предел ${key}: ${before} -> ${now.limits[key]}`)
    }
  }
}

/**
 * Сравнивает таблицу «вердикт - ошибка».
 *
 * От таблицы зависит, повторит клиент запрос или остановится навсегда.
 *
 * @param {object} was Прежнее содержимое spec/protocol/response-classes.yaml.
 * @param {object} now Нынешнее содержимое.
 * @returns {void}
 */
function diffVerdicts(was, now) {
  const rel = 'spec/protocol/response-classes.yaml'
  const flatten = (doc) => {
    const out = {}
    for (const [cls, rows] of Object.entries(doc.verdict_errors || {})) {
      for (const [reason, error] of Object.entries(rows || {})) {
        out[`${cls}/${reason}`] = error
      }
    }
    return out
  }
  const before = flatten(was)
  const after = flatten(now)

  for (const key of Object.keys(after)) {
    if (!(key in before)) {
      change('add_verdict_mapping', rel, `пара ${key} описана`)
    } else if (before[key] !== after[key]) {
      change('change_verdict_mapping', rel,
        `пара ${key}: ${before[key] || 'null'} -> ${after[key] || 'null'}`)
    }
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) change('remove_verdict_mapping', rel, `пара ${key} удалена`)
  }
}

/**
 * Сравнивает словарь доменных типов.
 *
 * @param {object} was Прежнее содержимое spec/types.yaml.
 * @param {object} now Нынешнее содержимое.
 * @returns {void}
 */
function diffTypes(was, now) {
  const rel = 'spec/types.yaml'
  const before = Object.keys(was.types || {})
  const after = Object.keys(now.types || {})

  for (const name of after) {
    if (!before.includes(name)) change('add_domain_type', rel, `тип ${name} объявлен`)
  }
  for (const name of before) {
    if (!after.includes(name)) change('remove_domain_type', rel, `тип ${name} удалён`)
  }
}

/**
 * Сравнивает одну схему модели или события.
 *
 * @param {string} rel Путь к файлу.
 * @param {object} was Схема в базовой точке.
 * @param {object} now Схема в рабочем дереве.
 * @returns {void}
 */
function diffSchema(rel, was, now) {
  const wasProps = was.properties || {}
  const nowProps = now.properties || {}
  const wasReq = new Set(was.required || [])
  const nowReq = new Set(now.required || [])

  for (const name of Object.keys(nowProps)) {
    if (!(name in wasProps)) {
      change(nowReq.has(name) ? 'add_required_field' : 'add_optional_field', rel,
        `добавлено поле ${name}`)
      continue
    }
    const a = wasProps[name]
    const b = nowProps[name]

    if (wasReq.has(name) && !nowReq.has(name)) {
      change('required_to_optional', rel,
        `поле ${name} перестало быть обязательным. Для парсера это послабление, ` +
        `для пользователя SDK - сужение гарантии: было T, стало T?`)
    }
    if (!wasReq.has(name) && nowReq.has(name)) {
      change('optional_to_required', rel, `поле ${name} стало обязательным`)
    }
    // Тип может быть строкой либо массивом: ["string", "null"] означает поле,
    // допускающее пустоту. Сравнение через !== для массивов сравнивает ссылки,
    // а не содержимое, и объявляло изменением каждое поле с пустотой - на
    // пустом диффе классификатор требовал major.
    //
    // Хуже самой ошибки её последствие: классификатор, кричащий всегда, не
    // отличается от молчащего. Настоящее ломающее изменение тонуло бы среди
    // четырнадцати выдуманных.
    if (!sameType(a.type, b.type)) {
      // Сужение и расширение различаются, и различие не косметическое.
      // Расширение - было T, стало T либо U - ломает читателя: его разбор знает
      // только T. Сужение ломает писателя. Оба major, но причина разная, и по
      // ней решают, кого предупреждать.
      const kind = widens(a.type, b.type) ? 'widen_type' : 'narrow_type'
      change(kind, rel,
        `поле ${name}: тип изменился с ${showType(a.type)} на ${showType(b.type)}`)
    }
    if (a['x-funora-type'] !== b['x-funora-type']) {
      change('change_x_funora_type', rel,
        `поле ${name}: доменный тип изменился с ${a['x-funora-type'] || 'нет'} на ${b['x-funora-type'] || 'нет'}`)
    }
    const wasEnum = new Set(a.enum || [])
    const nowEnum = new Set(b.enum || [])
    for (const v of nowEnum) if (!wasEnum.has(v)) change('add_enum_value', rel, `поле ${name}: добавлено значение ${v}`)
    for (const v of wasEnum) if (!nowEnum.has(v)) change('remove_enum_value', rel, `поле ${name}: удалено значение ${v}`)
  }

  for (const name of Object.keys(wasProps)) {
    if (!(name in nowProps)) change('remove_field', rel, `удалено поле ${name}`)
  }
}

/**
 * Сравнивает таксономию ошибок.
 *
 * @param {object} was Документ в базовой точке.
 * @param {object} now Документ в рабочем дереве.
 * @returns {void}
 */
function diffErrors(was, now) {
  const rel = 'spec/errors/errors.yaml'
  const a = was.errors || {}
  const b = now.errors || {}

  const wasCodes = new Map()
  for (const [n, e] of Object.entries(a)) wasCodes.set(e.abi_code, n)

  for (const [name, e] of Object.entries(b)) {
    if (!(name in a)) {
      const prev = wasCodes.get(e.abi_code)
      if (prev && prev !== name) {
        change('reuse_abi_code', rel,
          `${name} занял abi_code ${e.abi_code}, ранее принадлежавший ${prev}. ` +
          `Числовой код попадает в бинарный интерфейс C-SDK и не переиспользуется никогда`)
      } else {
        change('add_error_code', rel, `добавлена ошибка ${name}`)
      }
      continue
    }
    const o = a[name]
    if (o.parent !== e.parent) {
      change('change_error_parent', rel,
        `${name}: родитель изменился с ${o.parent} на ${e.parent} - меняет то, какой ` +
        `except или catch перехватит ошибку у пользователя`)
    }
    if (o.retryable !== e.retryable) {
      change('change_error_retryable', rel, `${name}: retryable изменился на ${e.retryable}`)
    }
    if (o.stable_id !== e.stable_id) {
      change('rename_field', rel, `${name}: stable_id изменился - идентификатор не переименовывается`)
    }
  }
  for (const name of Object.keys(a)) {
    if (!(name in b)) change('remove_field', rel, `удалена ошибка ${name}`)
  }
}

/**
 * Сравнивает описания операций сервисов.
 *
 * @param {string} rel Путь к файлу сервиса.
 * @param {object} was Документ в базовой точке.
 * @param {object} now Документ в рабочем дереве.
 * @returns {void}
 */
function diffService(rel, was, now) {
  const a = was.operations || {}
  const b = now.operations || {}
  // Поля сравниваются по явному перечню, а не общим обходом. Общий обход поднял
  // бы шум на каждое добавленное пояснение, а перечень заставляет осознанно
  // решить судьбу нового поля в тот момент, когда оно появляется.
  //
  // Перечень появился после того, как классификатор пропустил смену типа
  // возврата операции с Order[] на OrderListEntry[]: сравнивалась только
  // safety, всё остальное менялось молча.
  const SCALAR_FIELDS = [
    ['safety', 'change_operation_safety',
      'меняет решение о повторе на стороне транспорта'],
    ['returns', 'change_operation_returns',
      'у потребителя меняется тип результата'],
    ['capability', 'change_operation_capability',
      'операция стала зависеть от другой возможности'],
    ['pagination', 'change_operation_pagination',
      'меняется ответ на вопрос, полон ли результат'],
    ['request_class', 'change_operation_request_class',
      'меняется распределение бюджета и очерёдность'],
  ]

  for (const [id, op] of Object.entries(b)) {
    if (!(id in a)) { change('add_operation', rel, `добавлена операция ${id}`); continue }

    for (const [field, kind, why] of SCALAR_FIELDS) {
      if (a[id][field] === op[field]) continue
      change(kind, rel,
        `${id}: ${field} изменилось с ${JSON.stringify(a[id][field])} на ` +
        `${JSON.stringify(op[field])} - ${why}`)
    }

    const wasErrors = new Set(a[id].errors || [])
    const nowErrors = new Set(op.errors || [])
    for (const e of nowErrors) {
      if (!wasErrors.has(e)) {
        change('add_operation_error', rel, `${id}: объявлен новый вид отказа ${e}`)
      }
    }
    for (const e of wasErrors) {
      if (!nowErrors.has(e)) {
        change('remove_operation_error', rel, `${id}: вид отказа ${e} больше не объявлен`)
      }
    }
  }
  for (const id of Object.keys(a)) {
    if (!(id in b)) change('remove_operation', rel, `удалена операция ${id}`)
  }
}

/**
 * Сравнивает контракт доставки событий.
 *
 * @param {object} was Документ в базовой точке.
 * @param {object} now Документ в рабочем дереве.
 * @returns {void}
 */
function diffDelivery(was, now) {
  const rel = 'spec/events/delivery.yaml'
  const a = (was.ordering && was.ordering.derivation) || {}
  const b = (now.ordering && now.ordering.derivation) || {}
  for (const [t, k] of Object.entries(b)) {
    if (t in a && a[t] !== k) {
      change('change_ordering_key_derivation', rel,
        `${t}: правило вывода ключа изменилось с ${a[t]} на ${k} - меняет то, какие ` +
        `события пользователь получает последовательно, а какие параллельно`)
    }
  }
  if (was.guarantee && now.guarantee && was.guarantee.kind !== now.guarantee.kind) {
    change('change_ordering_key_derivation', rel,
      `гарантия доставки изменилась с ${was.guarantee.kind} на ${now.guarantee.kind}`)
  }
}

/**
 * Сравнивает версии и канонический формат.
 *
 * @param {object} was Документ версии в базовой точке.
 * @param {object} now Документ версии в рабочем дереве.
 * @returns {{was: string, now: string, bump: string}} Версии и объявленный bump.
 */
function diffVersion(was, now) {
  if (was && now && was.canonical_form_version !== now.canonical_form_version) {
    change('canonical_form_change', 'spec/version.yaml',
      `версия канонической формы изменилась с ${was.canonical_form_version} на ` +
      `${now.canonical_form_version} - обнуляет сохранённые снимки, курсоры и ключи ` +
      `идемпотентности у всех пользователей`)
  }
  const w = (was && was.spec_version) || '0.0.0'
  const n = (now && now.spec_version) || '0.0.0'
  const [wa, wb, wc] = w.split('.').map(Number)
  const [na, nb, nc] = n.split('.').map(Number)
  let bump = 'none'
  if (na > wa) bump = 'major'
  else if (nb > wb) bump = 'minor'
  else if (nc > wc) bump = 'patch'

  // Нулевой мажор. Пока первая часть версии - ноль, контракт объявлен
  // неустоявшимся, и ломающее изменение выражается второй частью: 0.1.0 ->
  // 0.2.0. Иначе первое же ломающее изменение требовало бы 1.0.0, то есть
  // объявляло бы контракт устоявшимся ровно тогда, когда он ломается.
  //
  // Правило нужно было завести: четыре захода подряд меняли контракт ломающе,
  // и объявить это было нечем - классификатор требовал major, а major в нуле
  // означал бы совсем не то.
  if (wa === 0 && na === 0 && bump === 'minor') bump = 'major'

  return { was: w, now: n, bump }
}

/**
 * Собирает плоскую карту правил извлечения.
 *
 * Файлы в spec/extraction устроены по-разному, и общей схемы у них нет. Зато у
 * всякого правила есть узел с ключом selector, и именно он описывает, откуда
 * берётся значение. Обход собирает такие узлы по пути в дереве - этого хватает,
 * чтобы заметить исчезновение правила, переезд селектора и смену условий, при
 * которых поле вообще выдаётся значением.
 *
 * @param {any} node Узел дерева спецификации.
 * @param {string} trail Путь до узла, точками.
 * @param {Object<string, any>} out Накопитель. Ключ - путь, значение - правило.
 * @returns {Object<string, any>} Тот же накопитель.
 */
function collectExtraction(node, trail, out) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectExtraction(item, `${trail}[${i}]`, out))
    return out
  }
  if (typeof node.selector === 'string') {
    out[trail] = {
      selector: node.selector,
      confidence: node.confidence || null,
      // Односторонность и нормативная приписка вместе описывают одно: при
      // каких условиях поле выдаётся значением, а при каких - ненаблюдённым.
      observability: `${node.one_sided ? 'one_sided' : 'plain'}:${node.normative ? 'normative' : 'free'}`,
    }
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'selector') continue
    collectExtraction(v, trail ? `${trail}.${k}` : k, out)
  }
  return out
}

/**
 * Сравнивает правила извлечения двух версий файла.
 *
 * Раздел extraction не описывает сигнатур, и потому долго оставался невидимым
 * для этой проверки. Видимым он должен быть: правило извлечения решает, какие
 * данные шесть SDK отдадут вызывающему, и поменять его молча - значит поменять
 * поведение всех реализаций, не тронув ни одной сигнатуры.
 *
 * @param {string} rel Путь файла относительно корня репозитория.
 * @param {any} was Разобранное содержимое базовой версии.
 * @param {any} now Разобранное содержимое текущей версии.
 * @returns {void}
 */
function diffExtraction(rel, was, now) {
  const a = collectExtraction(was, '', {})
  const b = collectExtraction(now, '', {})

  for (const key of Object.keys(a)) {
    if (!(key in b)) {
      change('remove_extraction_field', rel, `правило извлечения исчезло: ${key}`)
      continue
    }
    if (a[key].selector !== b[key].selector) {
      change('change_extraction_selector', rel,
        `селектор ${key}: "${a[key].selector}" -> "${b[key].selector}"`)
    }
    if (a[key].confidence !== b[key].confidence) {
      change('change_extraction_confidence', rel,
        `уверенность ${key}: ${a[key].confidence} -> ${b[key].confidence}`)
    }
    if (a[key].observability !== b[key].observability) {
      change('change_field_observability', rel,
        `условия выдачи значения ${key}: ${a[key].observability} -> ${b[key].observability}`)
    }
  }

  for (const key of Object.keys(b)) {
    if (!(key in a)) change('add_extraction_field', rel, `новое правило извлечения: ${key}`)
  }
}

/**
 * Точка входа.
 *
 * @returns {void}
 */
function main() {
  const argv = process.argv.slice(2)
  const strict = argv.includes('--strict')
  const bi = argv.indexOf('--base')
  const base = resolveBase(bi >= 0 ? argv[bi + 1] : null)

  const rules = yaml.load(fs.readFileSync(path.join(ROOT, SPEC, 'compat-rules.yaml'), 'utf8'))
  const bumpOf = (kind) => {
    const r = (rules.changes || {})[kind]
    return r ? r.bump : 'major'
  }

  const oldFiles = new Set(listAt(base))
  const newFiles = listNow()

  if (oldFiles.size === 0) {
    console.log(`базовая точка ${base} не содержит spec - сравнивать не с чем`)
    process.exit(0)
  }

  for (const rel of oldFiles) {
    if (newFiles.includes(rel)) continue
    if (rel.includes('/events/') && rel.endsWith('.schema.json')) {
      change('remove_event_type', rel, 'вид события удалён')
    } else if (rel.includes('/models/')) {
      change('remove_operation', rel, 'модель удалена')
    }
  }

  for (const rel of newFiles) {
    const now = parse(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    const was = parse(rel, readAt(base, rel))
    if (!now) continue

    if (!was) {
      if (rel.includes('/events/') && rel.endsWith('.schema.json')) {
        // Именно вид события, а не операция. Прежде оба случая шли одним
        // классом, и перечень классов изменений содержал add_event_type,
        // которым никто не пользовался: класс объявлен и не действует.
        change('add_event_type', rel, 'новый вид события')
      } else if (rel.includes('/models/')) {
        change('add_operation', rel, 'новая модель')
      }
      continue
    }

    if (rel.includes('/models/') || (rel.includes('/events/') && rel.endsWith('.schema.json'))) {
      diffSchema(rel, was, now)
    } else if (rel.endsWith('errors/errors.yaml')) {
      diffErrors(was, now)
    } else if (rel.includes('/services/')) {
      diffService(rel, was, now)
    } else if (rel.endsWith('events/delivery.yaml')) {
      diffDelivery(was, now)
    } else if (rel.includes('/extraction/') && rel.endsWith('.yaml')) {
      diffExtraction(rel, was, now)
    } else if (rel.endsWith('capabilities.yaml')) {
      diffCapabilities(was, now)
    } else if (rel.endsWith('protocol/retry-policy.yaml')) {
      diffRetry(was, now)
    } else if (rel.endsWith('protocol/response-classes.yaml')) {
      diffVerdicts(was, now)
    } else if (rel.endsWith('runtime/budget.yaml')) {
      diffBudget(was, now)
    } else if (rel.endsWith('spec/types.yaml')) {
      diffTypes(was, now)
    }
  }

  for (const rel of oldFiles) {
    if (!newFiles.includes(rel)) change('remove_field', rel, 'файл удалён')
  }

  const vWas = parse('spec/version.yaml', readAt(base, 'spec/version.yaml'))
  const vNow = parse('spec/version.yaml', fs.readFileSync(path.join(ROOT, SPEC, 'version.yaml'), 'utf8'))
  const v = diffVersion(vWas, vNow)

  console.log(`базовая точка: ${base}`)
  console.log(`версия: ${v.was} -> ${v.now} (объявленный bump: ${v.bump})`)
  console.log(`статус спецификации: ${(vNow && vNow.status) || 'неизвестен'}`)

  if (changes.length === 0) {
    console.log('')
    console.log('изменений контракта не обнаружено')
    process.exit(0)
  }

  let required = 'none'
  const byKind = new Map()
  for (const c of changes) {
    const b = bumpOf(c.kind)
    if (RANK[b] > RANK[required]) required = b
    if (!byKind.has(c.kind)) byKind.set(c.kind, [])
    byKind.get(c.kind).push(c)
  }

  console.log('')
  console.log(`изменений: ${changes.length}`)
  for (const [kind, list] of [...byKind.entries()].sort((a, b) => RANK[bumpOf(b[0])] - RANK[bumpOf(a[0])])) {
    console.log('')
    console.log(`  ${kind} -> ${bumpOf(kind)}  (${list.length})`)
    for (const c of list.slice(0, 6)) console.log(`    ${c.where}: ${c.what}`)
    if (list.length > 6) console.log(`    ... ещё ${list.length - 6}`)
  }

  console.log('')
  console.log(`минимально необходимый bump: ${required}`)

  if (required === 'forbidden') {
    console.log('')
    console.log('ОТКАЗ: изменение относится к запрещённому классу и не может быть выпущено')
    process.exit(1)
  }

  const enforced = strict || (vNow && vNow.status === 'released')
  if (RANK[v.bump] < RANK[required]) {
    console.log('')
    console.log(`объявленный bump «${v.bump}» меньше необходимого «${required}»`)
    if (enforced) {
      console.log('проверка обязательна: статус released или передан --strict')
      process.exit(1)
    }
    console.log('статус draft - проверка носит информационный характер')
    process.exit(0)
  }

  console.log('объявленный bump достаточен')
  process.exit(0)
}

main()

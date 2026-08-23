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
 * Проверяет таблицу «знак валюты - код ISO 4217».
 *
 * Сама она не проверялась ничем: про types.yaml здесь знали ровно одно - что
 * имена типов используются как значения x-funora-type. Таблицу можно было
 * дописать пустой, с кодом строчными буквами либо с двумя знаками одной валюты,
 * и спецификация осталась бы «без нарушений».
 *
 * Проверка живёт здесь, а не только в кодогенераторе питона: кодогенератор
 * защищает одну реализацию из шести, а спецификацию читают все.
 *
 * @returns {number} Сколько записей в таблице.
 */
function checkCurrencySymbols() {
  const doc = readYaml(path.join(SPEC, 'types.yaml'))
  const money = (doc.types || {}).money || {}
  const table = money.symbol_table
  if (!table || Object.keys(table).length === 0) {
    fail('spec/types.yaml', 'types.money.symbol_table пуст либо не объявлен. '
      + 'Страница показывает знак и не показывает кода; без таблицы сумму собрать '
      + 'нельзя, а угадать соответствие - значит приписать чужую валюту чужому '
      + 'заказу молча')
    return 0
  }

  const byCode = new Map()
  for (const [symbol, entry] of Object.entries(table)) {
    if (!symbol.trim()) {
      fail('spec/types.yaml', 'в таблице знаков есть пустой ключ')
      continue
    }
    if (!entry || !entry.evidence) {
      fail('spec/types.yaml', `у знака «${symbol}» нет поля evidence. Таблица стоит `
        + 'на наблюдении, и запись без ссылки на него неотличима от выдуманной')
    }
    if (entry && entry.ambiguous) {
      if (entry.currency) {
        fail('spec/types.yaml', `знак «${symbol}» объявлен и неоднозначным, и имеющим `
          + 'код. Одно из двух: либо он решает, либо нет')
      }
      continue
    }
    const code = entry && entry.currency
    if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code)) {
      fail('spec/types.yaml', `у знака «${symbol}» код ${JSON.stringify(code)} не по `
        + 'ISO 4217. Три заглавные латинские буквы либо ambiguous: true')
      continue
    }
    if (byCode.has(code)) {
      fail('spec/types.yaml', `код ${code} стоит и у «${byCode.get(code)}», и у `
        + `«${symbol}». Соответствие объявлено односторонним, и два знака одной `
        + 'валюты означают, что один из них наблюдён неверно')
    }
    byCode.set(code, symbol)
  }
  return Object.keys(table).length
}

/**
 * Ищет в текстах спецификации имена классов ошибок, которых нет.
 *
 * Класс убирают из errors.yaml, а имя остаётся в чужом описании, в правиле
 * извлечения, в поле why вектора - и читается как обещание. Сегодня так
 * осталось четыре ссылки на давно переименованную запись, и нашлись они
 * разбором, а не сборкой.
 *
 * Ищется по форме имени, а не по перечню мест: перечень мест устаревает первым.
 *
 * @param {Set<string>} known Имена объявленных классов ошибок.
 * @returns {number} Сколько упоминаний проверено.
 */
function checkErrorNamesResolve(known) {
  const NAME = /\b([A-Z][A-Za-z0-9]*Error)\b/g
  let checked = 0

  const files = [...walk(SPEC, '.yaml'), ...walk(SPEC, '.json')]
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    // errors.yaml объявляет их сам, и там имя не ссылка, а определение.
    if (rel.endsWith('spec/errors/errors.yaml')) continue

    const text = fs.readFileSync(file, 'utf8')
    const seen = new Set()
    let hit = NAME.exec(text)
    while (hit !== null) {
      seen.add(hit[1])
      hit = NAME.exec(text)
    }
    for (const name of seen) {
      checked += 1
      if (!known.has(name)) {
        fail(rel, `упомянут класс ошибки «${name}», которого в errors.yaml нет. ` +
          `Имя убранного класса читается как обещание: вызывающий напишет except ` +
          `и будет ждать того, чего не бывает`)
      }
    }
  }
  return checked
}

/**
 * Проверяет одно свойство схемы на соответствие правилам скаляров и перечислений.
 *
 * @param {string} file Относительный путь к файлу схемы, для сообщения об ошибке.
 * @param {string} pointer JSON-указатель на свойство, например `properties.stock`.
 * @param {object} prop Тело свойства из JSON Schema.
 * @returns {void}
 */
function checkProperty(file, pointer, prop, options) {
  if (!prop || typeof prop !== 'object') return
  const kind = (options && options.kind) || 'model'

  const declared = prop['x-funora-type']
  if (declared && !KNOWN_TYPES.has(declared)) {
    fail(file, `${pointer}: неизвестный x-funora-type «${declared}»`)
  }

  // Ссылка на другую модель и объявленный доменный тип снимают требование к скаляру.
  const delegated = Boolean(prop.$ref || declared)

  // Поле, допускающее отсутствие значения, объявляется массивом типов:
  // ["string", "null"]. Прежде все проверки ниже сравнивали prop.type со
  // строкой и на таком поле не срабатывали ни одна - то есть любое правило
  // обходилось дописыванием "null" в тип. Проверки идут по объявленным типам,
  // а не по одному.
  const types = Array.isArray(prop.type) ? prop.type : (prop.type ? [prop.type] : [])
  const nullable = types.includes('null')

  // Пустота обязана объявить, ЧТО она означает. Смыслов ровно два, и они
  // приводят к разным решениям вызывающего:
  //
  //   unobserved-possible - «не наблюдали». Значение на странице, возможно,
  //   есть, а прочитать его не удалось. Вызывающий не вправе считать, что его
  //   нет.
  //
  //   not_applicable - «неприменимо». В этом состоянии сущности поля не бывает
  //   вовсе: у повреждения уровня страницы нет строки, у ненаблюдённого
  //   значения нет уверенности. Вызывающий вправе не искать его.
  //
  // Прежде правило знало только первый смысл и требовало его от всякой
  // пустоты. Это заставляло помечать «не наблюдали» там, где наблюдать нечего,
  // - то есть врать ровно тем полем, которое заведено против вранья.
  const observability = prop['x-funora-observability']
  const nullMeaning = prop['x-funora-nullable']
  const saysUnobserved = observability === 'unobserved-possible'
  const saysNotApplicable = nullMeaning === 'not_applicable'

  if (saysUnobserved && saysNotApplicable) {
    fail(file, `${pointer}: пустота объявлена сразу и «не наблюдали», и ` +
      `«неприменимо». Это разные ответы, и вызывающий обязан знать, какой из них ` +
      `перед ним`)
  }

  if (nullable && !saysUnobserved && !saysNotApplicable) {
    fail(file, `${pointer}: тип допускает null, но не сказано, что null означает. ` +
      `Пометьте x-funora-observability: unobserved-possible либо ` +
      `x-funora-nullable: not_applicable - шесть SDK иначе разойдутся в том, ` +
      `означает ли пустота «не наблюдали» или «здесь этого не бывает»`)
  }

  if (!nullable && (saysUnobserved || saysNotApplicable) && kind === 'event') {
    fail(file, `${pointer}: пустота объявлена, но тип её не допускает. В нагрузке ` +
      `события ненаблюдённое и неприменимое - это null, а не отсутствующий ключ: ` +
      `отсутствие неотличимо от потери по дороге`)
  }

  if (types.includes('number')) {
    fail(file, `${pointer}: тип number запрещён - представление с плавающей точкой ` +
      `не воспроизводится одинаково в шести языках; используйте integer или x-funora-type`)
  }

  if (types.includes('string') && !delegated) {
    const constrained = Array.isArray(prop.enum) || typeof prop.pattern === 'string'
    const justified = prop['x-funora-sensitivity'] || prop['x-funora-plain'] === true
    if (!constrained && !justified) {
      fail(file, `${pointer}: сырой string без x-funora-type, enum, pattern или явного ` +
        `обоснования - доменное поле обязано иметь объявленное представление`)
    }
  }

  if (types.includes('integer') && !delegated && !prop.description) {
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
      // Только «не наблюдали». «Неприменимо» обязано быть в required и
      // допускать null: отсутствие ключа не отличается от потери, а null - это
      // ответ «здесь этого не бывает».
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

  // Штамп версии обязан стоять В КАЖДОЙ схеме и совпадать с объявленной.
  //
  // Прежде обходились только spec/models, а схем со штампом тридцать четыре:
  // семнадцать событийных не проверял никто. Подъём версии правится вручную во
  // всех файлах сразу, и забытая половина разошлась бы молча - именно тот
  // случай, ради которого штамп и стоит.
  //
  // Отсутствие штампа - тоже нарушение. Прежнее условие пропускало схему без
  // него: она выглядела бы вечно совместимой.
  const stamped = [
    ...walk(path.join(SPEC, 'models'), '.schema.json'),
    ...walk(path.join(SPEC, 'events'), '.schema.json'),
  ]
  for (const file of stamped) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const declared = doc['x-funora-spec-version']
    if (!declared) {
      fail(rel, 'нет x-funora-spec-version. Схема без штампа выглядит вечно '
        + 'совместимой: подъём версии её не касается, и расхождение молчит')
      continue
    }
    if (declared !== v.spec_version) {
      fail(rel, `x-funora-spec-version «${declared}» не совпадает с `
        + `spec_version «${v.spec_version}»`)
    }
  }
}

/**
 * Проверяет машиночитаемый состав версии события.
 *
 * Состав входит в отпечаток, а отпечаток - идентичность события. Объявление
 * прозой сверить было нечем, и два объявления из восьми разошлись с реализацией
 * молча: watch.primed обещал константу primed при настоящей cold_start, а
 * snapshot.incomplete обещал три части при четырёх.
 *
 * Здесь проверяется ФОРМА объявления. Что реализация вправду складывает
 * объявленное, проверяется поведенчески на её стороне: версия в событие не
 * кладётся, и сверить состав можно только пересчётом отпечатка.
 *
 * @param {object} doc Разобранный spec/events/delivery.yaml.
 * @returns {number} Сколько видов объявили состав.
 */
function checkRevisionParts(doc) {
  const rel = 'spec/events/delivery.yaml'
  const block = doc.revision_parts || {}
  const sources = (doc.revision_source || {}).sources || {}
  let declared = 0

  if (!String(block.every_producible_kind_declares_one || '').trim()) {
    fail(rel, 'revision_parts не объявляет правила о том, что состав обязан ' +
      'быть у каждого порождаемого вида. Без правила вид заведут без состава, ' +
      'и его версию не будет сверять никто')
  }

  for (const [kind, entry] of Object.entries(block)) {
    if (kind === 'every_producible_kind_declares_one') continue
    declared += 1

    if (!(kind in sources)) {
      fail(rel, `revision_parts объявляет состав для вида «${kind}», которого ` +
        'нет в revision_source.sources. Состав без источника - объявление о ' +
        'виде, которого контракт не знает')
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(rel, `revision_parts[${kind}]: ожидалось отображение`)
      continue
    }

    const hasParts = Array.isArray(entry.parts)
    const hasExcuse = String(entry.not_in_payload || '').trim().length > 0
    if (hasParts === hasExcuse) {
      fail(rel, `revision_parts[${kind}]: обязано быть ровно одно из parts и ` +
        'not_in_payload. Оба сразу означают два объявления одного состава, ни ' +
        'одного - что состав не сверяет никто')
      continue
    }
    if (!hasParts) continue

    if (entry.parts.length === 0) {
      fail(rel, `revision_parts[${kind}]: перечень частей пуст. Пустая версия ` +
        'даёт один отпечаток всем событиям вида, и все они, кроме первого, ' +
        'исчезнут как повторы')
      continue
    }

    entry.parts.forEach((part, i) => {
      const at = `revision_parts[${kind}].parts[${i}]`
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        fail(rel, `${at}: ожидалось отображение`)
        return
      }
      const isConstant = 'constant' in part
      const isFrom = 'from' in part
      if (isConstant === isFrom) {
        fail(rel, `${at}: часть обязана быть либо constant, либо from`)
        return
      }
      if (isConstant) {
        if (typeof part.constant !== 'string' || !part.constant.trim()) {
          fail(rel, `${at}: constant обязан быть непустой строкой`)
        }
        if ('joined_by' in part) {
          fail(rel, `${at}: joined_by у константы бессмыслен - склеивать нечего`)
        }
        return
      }
      const from = [].concat(part.from)
      if (from.length === 0 || from.some((one) => typeof one !== 'string' || !one.trim())) {
        fail(rel, `${at}: from обязан называть ключ нагрузки либо непустой ` +
          'перечень ключей')
        return
      }
      if (from.length > 1 && !String(part.joined_by || '').length) {
        fail(rel, `${at}: несколько ключей нагрузки без joined_by. Склеить их ` +
          'без объявленного знака каждая реализация склеит по-своему, и ' +
          'отпечатки разойдутся')
      }
      if (from.length === 1 && 'joined_by' in part) {
        fail(rel, `${at}: joined_by при единственном ключе бессмыслен`)
      }
      const sep = String(part.joined_by || '')
      if (sep && (sep.includes('\u001e') || sep.includes('\u001f'))) {
        fail(rel, `${at}: joined_by содержит разделитель частей либо полей ` +
          'отпечатка. Внутренний знак, совпавший с внешним, даёт двум разным ' +
          'событиям один отпечаток, и второе исчезает молча')
      }
    })
  }
  return declared
}

/**
 * Запрещает второе объявление версии события.
 *
 * Нормативный перечень один - revision_source.sources: там все виды сразу, и
 * там их сверяют ворота. Раздел, объявляющий версию своего вида отдельно, - это
 * второе объявление той же вещи, и расходятся такие молча: правит их разный
 * человек в разное время, а прозу с прозой не сличает никакая проверка.
 *
 * Так и было у snapshot.incomplete: слово в слово о том же в двух местах.
 *
 * @returns {number} Сколько разделов проверено.
 */
function checkNoSecondRevisionDeclaration() {
  const rel = 'spec/events/delivery.yaml'
  const doc = readYaml(path.join(SPEC, 'events', 'delivery.yaml')) || {}
  let checked = 0

  for (const [name, section] of Object.entries(doc)) {
    if (name === 'revision_source') continue
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue
    checked += 1
    if ('revision' in section) {
      fail(rel, `раздел ${name} объявляет revision вторым объявлением. ` +
        'Нормативный перечень один - revision_source.sources. Два объявления ' +
        'одной вещи расходятся молча: прозу с прозой не сличает никакая ' +
        'проверка. Поставьте указатель revision_declared_in')
    }
    if ('revision_declared_in' in section) {
      const target = String(section.revision_declared_in || '')
      const m = /^revision_source\.sources\[(.+)\]$/.exec(target)
      if (!m) {
        fail(rel, `раздел ${name}: указатель revision_declared_in «${target}» ` +
          'не разбирается. Ожидается вид revision_source.sources[имя.вида]')
      } else if (!((doc.revision_source || {}).sources || {})[m[1]]) {
        fail(rel, `раздел ${name}: указатель ведёт на вид «${m[1]}», ` +
          'которого в revision_source.sources нет. Указатель в пустоту хуже ' +
          'дубля: дубль хотя бы что-то говорит')
      }
    }
  }
  return checked
}

/**
 * Требует единственной оси версий.
 *
 * Двадцать два файла объявляли в шапке собственную version, все двадцать две
 * стояли на 0.1.0 при spec_version 0.3.0, и не читал их никто: проверка
 * требовала, чтобы поле БЫЛО, и не требовала, чтобы оно что-нибудь значило.
 * Отставание на три минора молчало.
 *
 * Вторая ось на одну вещь хуже отсутствия оси: она выглядит как обещание, что
 * файл версионируется отдельно, и читающий рассчитывает по ней на
 * совместимость, которой никто не поддерживает.
 *
 * @returns {number} Сколько файлов проверено.
 */
function checkSingleVersionAxis() {
  const version = readYaml(path.join(SPEC, 'version.yaml')) || {}
  const rule = version.single_version_axis
  if (!rule || !rule.rule) {
    fail('spec/version.yaml', 'не объявлено правило единственной оси версий. ' +
      'Без него поле version снова заведётся в шапке каждого файла и снова ' +
      'отстанет молча')
  }

  let checked = 0
  for (const file of walk(SPEC, '.yaml')) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    if (rel === 'spec/version.yaml') continue
    checked += 1
    const doc = readYaml(file)
    if (!doc || typeof doc !== 'object') continue
    if ('version' in doc) {
      fail(rel, 'поле version верхнего уровня. Ось версий одна и живёт в ' +
        'spec/version.yaml. Своя версия у файла - обещание отдельной ' +
        'совместимости, которой никто не поддерживает: прежние двадцать две ' +
        'отстали на три минора, и отставание молчало')
    }
  }
  return checked
}

/**
 * Требует у каждого перечисления объявленной открытости.
 *
 * Перечисление либо закрыто - значения придумываем мы, - либо открыто, и тогда
 * значения зеркалят площадку и растут без нашего участия. Разница не
 * косметическая: у открытого обязано быть запасное значение, иначе новый статус
 * на стороне площадки ломает исчерпывающий разбор У ПОЛЬЗОВАТЕЛЯ.
 *
 * Пометка стояла у двадцати одного перечисления из двадцати двух. Требовать её
 * было нечему, и двадцать второе - как раз открытое - осталось без неё.
 *
 * @returns {number} Сколько перечислений проверено.
 */
function checkEnumOpenness() {
  const CLOSED = 'x-funora-closed'
  const FALLBACK = 'x-funora-unknown-fallback'
  let checked = 0

  /**
   * Обходит узел схемы вглубь.
   *
   * @param {string} rel Файл.
   * @param {string} at Путь до узла.
   * @param {*} node Узел.
   * @returns {void}
   */
  const visit = (rel, at, node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(rel, `${at}[${i}]`, item))
      return
    }
    if (Array.isArray(node.enum)) {
      checked += 1
      const closed = node[CLOSED]
      if (closed !== true && closed !== false) {
        fail(rel, `${at}: перечисление без пометки ${CLOSED}. Закрыто оно или ` +
          'открыто - решает, ломает ли пользователя новое значение, и решать ' +
          'это каждой из шести реализаций по-своему нельзя')
      } else if (closed === false) {
        const fallback = node[FALLBACK]
        if (!fallback) {
          fail(rel, `${at}: открытое перечисление не называет запасного ` +
            `значения в ${FALLBACK}. Новое значение площадки станет ошибкой ` +
            'разбора у пользователя, и случится это без нашего участия')
        } else if (!node.enum.includes(fallback)) {
          fail(rel, `${at}: запасным названо «${fallback}», а в enum его нет. ` +
            'Запасное значение, которого не существует, не запасное')
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      visit(rel, at ? `${at}.${key}` : key, value)
    }
  }

  const files = [
    ...walk(path.join(SPEC, 'models'), '.schema.json'),
    ...walk(path.join(SPEC, 'events'), '.schema.json'),
  ]
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    visit(rel, '', JSON.parse(fs.readFileSync(file, 'utf8')))
  }
  return checked
}

/**
 * Проверяет пометки устаревшего.
 *
 * Пометка - предусловие удаления: классификатор отклоняет удаление
 * непомеченного. Значит бессмысленная пометка не безобидна, она РАЗРЕШАЕТ
 * удаление. Пометка без since не даёт отсчитать миноры; пометка на значении,
 * которого в перечислении нет, не защищает ничего и уйдёт вместе с опечаткой.
 *
 * @param {string} version Объявленная версия спецификации.
 * @returns {number} Сколько пометок найдено.
 */
function checkDeprecationMarks(version) {
  const MARK = 'x-funora-deprecated'
  const VALUES = 'x-funora-deprecated-values'
  const parse = (value) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const now = parse(version)
  let found = 0

  /**
   * Проверяет одну пометку.
   *
   * @param {string} rel Файл, где она стоит.
   * @param {string} at Место внутри файла.
   * @param {*} mark Содержимое пометки.
   * @returns {void}
   */
  const one = (rel, at, mark) => {
    found += 1
    if (!mark || typeof mark !== 'object' || Array.isArray(mark)) {
      fail(rel, `${at}: пометка ${MARK} обязана быть отображением с полем since`)
      return
    }
    const since = parse(mark.since)
    if (!since) {
      fail(rel, `${at}: пометка ${MARK} без разбираемого since (стоит ` +
        `«${mark.since === undefined ? 'ничего' : mark.since}»). Без него не ` +
        'отсчитать миноры, а именно их требует min_deprecation_minors - и ' +
        'удаление пройдёт, ничего не предупредив')
      return
    }
    if (now && (since[0] > now[0] || (since[0] === now[0] && since[1] > now[1]))) {
      fail(rel, `${at}: пометка ${MARK} объявляет since «${mark.since}», а ` +
        `версия спецификации «${version}». Помечено будущим - значит не ` +
        'помечено ни в одной выпущенной версии')
    }
    if ('replaced_by' in mark && !String(mark.replaced_by || '').trim()) {
      fail(rel, `${at}: у пометки ${MARK} поле replaced_by пусто. Либо назовите ` +
        'замену, либо не объявляйте поле')
    }
  }

  /**
   * Обходит узел схемы вглубь.
   *
   * @param {string} rel Файл.
   * @param {string} at Путь до узла.
   * @param {*} node Узел.
   * @returns {void}
   */
  const walkNode = (rel, at, node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((item, i) => walkNode(rel, `${at}[${i}]`, item))
      return
    }
    if (MARK in node) one(rel, at, node[MARK])
    if (VALUES in node) {
      const marks = node[VALUES]
      if (!marks || typeof marks !== 'object' || Array.isArray(marks)) {
        fail(rel, `${at}: ${VALUES} обязано быть отображением значение -> пометка`)
      } else {
        const values = new Set(node.enum || [])
        for (const [value, mark] of Object.entries(marks)) {
          if (!values.has(value)) {
            fail(rel, `${at}: ${VALUES} помечает значение «${value}», которого ` +
              'в enum нет. Пометка не защищает ничего и уйдёт вместе с опечаткой')
          }
          one(rel, `${at}.${value}`, mark)
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === MARK || key === VALUES) continue
      walkNode(rel, at ? `${at}.${key}` : key, value)
    }
  }

  const files = [
    ...walk(path.join(SPEC, 'models'), '.schema.json'),
    ...walk(path.join(SPEC, 'events'), '.schema.json'),
    ...walk(path.join(SPEC, 'services'), '.yaml'),
  ]
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const doc = file.endsWith('.yaml')
      ? readYaml(file)
      : JSON.parse(fs.readFileSync(file, 'utf8'))
    walkNode(rel, '', doc)
  }
  return found
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

  // Описательная таблица состояний сверяется с нормативными предикатами.
  //
  // Проверялись до сих пор два значения из десяти: unknown.usable и
  // unsupported.usable. Сами предикаты не смотрел никто, при том что раздел
  // predicates прямо рассказывает, как порождённый ИЗ ТАБЛИЦЫ код оказался
  // неверным: у experimental признак usable равен true, а звать без включения
  // нельзя. Значит расхождение таблицы с предикатами уже случалось однажды - и
  // повториться ему ничто не мешало.
  //
  // Реализация обязана выводить решение из предикатов. Но таблицу читают
  // глазами, и лгущая таблица уводит автора второго SDK ровно туда же.
  const st = doc.states || {}
  const pr = doc.predicates || {}
  if (pr.normative !== true) {
    fail(rel, 'predicates обязаны быть помечены normative: иначе решение о ' +
      'вызове выводится из описательных признаков таблицы, а это уже давало ' +
      'неверный код')
  }
  const usable = new Set((pr.is_usable || {}).true_for || [])
  const optIn = new Set((pr.requires_opt_in || {}).true_for || [])

  for (const name of [...usable, ...optIn]) {
    if (!st[name]) fail(rel, `предикаты называют состояние «${name}», которого нет в states`)
  }

  // Признак opt_in_required в таблице обязан совпасть со списком предиката
  // ТОЧНО. Разойдись они - таблица обещает включение там, где реализация его не
  // спросит, либо молчит там, где спросит.
  const flagged = new Set(Object.keys(st).filter((name) => st[name].opt_in_required === true))
  for (const name of flagged) {
    if (!optIn.has(name)) {
      fail(rel, `у состояния «${name}» в таблице стоит opt_in_required, но ` +
        'предикат requires_opt_in его не называет. Таблица обещает явное ' +
        'включение, которого реализация не спросит')
    }
  }
  for (const name of optIn) {
    if (!flagged.has(name)) {
      fail(rel, `предикат requires_opt_in называет «${name}», а в таблице у ` +
        'него нет opt_in_required. Читающий таблицу не узнает, что вызов ' +
        'требует включения')
    }
  }

  // Состояние, которое не работает, звать нельзя. Обратное неверно нарочно:
  // experimental работает, но в is_usable его нет.
  for (const name of usable) {
    if (st[name] && st[name].usable !== true) {
      fail(rel, `предикат is_usable называет «${name}», у которого в таблице ` +
        'usable не true. Вызов разрешён у состояния, объявленного неработающим')
    }
  }

  // Два списка обязаны не пересекаться: состояние в обоих проходит по первой
  // же ветке правила допуска, и требование включения не спрашивается никогда.
  for (const name of usable) {
    if (optIn.has(name)) {
      fail(rel, `состояние «${name}» стоит и в is_usable, и в requires_opt_in. ` +
        'По правилу допуска первая ветка срабатывает раньше, и включение не ' +
        'спросится ни разу - предикат мёртв')
    }
  }

  // Состояние, не названное ни одним предикатом, звать запрещено всегда. Такое
  // состояние ровно одно, и это unsupported: остальные завели затем, чтобы
  // вызов шёл.
  for (const name of Object.keys(st)) {
    if (usable.has(name) || optIn.has(name)) continue
    if (name === 'unsupported') continue
    fail(rel, `состояние «${name}» не названо ни одним предикатом, значит ` +
      'вызов при нём запрещён всегда - как при unsupported. Либо его забыли в ' +
      'предикатах, либо оно не нужно')
  }
  if (usable.has('unsupported') || optIn.has('unsupported')) {
    fail(rel, 'unsupported назван предикатом. Это состояние - позитивное ' +
      'свидетельство отсутствия функции, и вызов при нём обязан отклоняться')
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
    // Перечень - пол, а не потолок: схема вправе требовать больше, но не меньше.
    // Прежде здесь стояло семь полей, а схема требовала восемь, и контракт
    // говорил о своей обязательности двумя голосами разное. Автор второго SDK,
    // взявший перечень из валидатора как список обязательного - а он на то и
    // выглядит, - не отдал бы delivery и не нарушил бы ни одной проверки.
    for (const f of ['id', 'type', 'account_id', 'entity_id', 'ordering_key',
                     'observed_at', 'origin', 'delivery', 'payload']) {
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
    // Тело схемы события проверяется теми же правилами, что и тело модели.
    // Прежде не проверялось ничем: checkProperty применялся только к моделям, и
    // схема события могла нести сырой number, неизвестный x-funora-type или
    // перечисление без запасного значения - валидатор сказал бы «нарушений не
    // найдено». Шестой SDK повторил бы за схемой.
    if (!doc.$id) fail(r, 'отсутствует $id')
    if (!doc.title) fail(r, 'отсутствует title')
    if (!doc.description) fail(r, 'отсутствует description')
    if (doc.additionalProperties !== false) {
      fail(r, 'additionalProperties должно быть false - иначе схема не описывает ' +
        'форму нагрузки, а лишь её минимум, и реализации разойдутся на лишних полях')
    }
    for (const [name, prop] of Object.entries(doc.properties || {})) {
      checkProperty(r, `properties.${name}`, prop, { kind: 'event' })
    }

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

  // Каждый тип объявляет, что служит его версией в отпечатке. Отпечаток -
  // ключ идемпотентности, общий для всех реализаций, и три его поля выбора не
  // оставляют. Четвёртое оставляет: разойдясь в нём, две реализации перестают
  // гасить повторы друг друга, и подключивший обе получает каждое событие
  // дважды.
  //
  // До этой проверки поле описывалось только словарём типов - «хэш
  // нормализованного состояния», - и правило было неверным опасно: хэш всего
  // состояния меняется от посторонней правки, и событие о статусе заказа
  // пришло бы второй раз после того, как покупатель сменил имя.
  const sources = (d.revision_source && d.revision_source.sources) || {}
  if (Object.keys(sources).length === 0) {
    fail(rel, 'не объявлено, что служит версией событий в отпечатке')
  }
  for (const t of declared) {
    if (!(t in sources)) {
      fail(rel, `для типа «${t}» не объявлено, что служит его версией в ` +
        `отпечатке: реализации выведут это поле сами и разойдутся в ключе ` +
        `идемпотентности`)
    }
  }
  for (const t of Object.keys(sources)) {
    if (!declared.has(t)) {
      fail(rel, `версия в отпечатке объявлена для несуществующего типа «${t}»`)
    }
  }
  for (const [t, source] of Object.entries(sources)) {
    if (typeof source !== 'string' || source.trim().length < 3) {
      fail(rel, `у типа «${t}» источник версии пуст`)
    }
    if (/observed_at|наблюдени|время|момент/i.test(String(source))) {
      fail(rel, `у типа «${t}» версией служит момент наблюдения: он различается ` +
        `у каждого чтения, и гашение повторов не сработает ни разу`)
    }
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
 * Проверяет, что ссылка на реестр неисполненного разрешается.
 *
 * Запись покрытия вправе сказать «этого нет, и это записано в
 * not-implemented.yaml». Такая ссылка - обещание, и висячая ссылка хуже
 * отсутствия ссылки: она выглядит выполненным обещанием.
 *
 * Так и было. Запись про spec/extraction/updates.yaml ссылалась на реестр
 * неисполненного, а записи про канал обновлений там не было вовсе.
 *
 * @returns {number} Число проверенных ссылок.
 */
function checkNotImplementedLinks() {
  const rel = 'spec/conformance/coverage.yaml'
  const coverage = readYaml(path.join(SPEC, 'conformance', 'coverage.yaml'))
  const registry = readYaml(path.join(SPEC, 'conformance', 'not-implemented.yaml'))
  const items = registry.items || {}

  const declared = new Set()
  for (const body of Object.values(items)) {
    const where = String((body || {}).declared_in || '')
    if (where) declared.add(where.split('#')[0])
  }

  let checked = 0
  for (const [file, body] of Object.entries(coverage.files || {})) {
    const note = String((body || {}).note || '')
    if (!note.includes('not-implemented.yaml')) continue
    checked += 1
    if (!declared.has(file)) {
      fail(rel, `запись «${file}» ссылается на реестр неисполненного, а записи ` +
        `с declared_in: ${file} там нет. Ссылка на несуществующее выглядит ` +
        `выполненным обещанием`)
    }
  }

  // Связь в ОБЕ стороны, и вторая половина важнее первой. Пока ссылок не было,
  // запись реестра можно было вырезать, и не замечал этого никто: проверки
  // перебирают items, а удалённая запись не перебирается. Обещание исчезало
  // вместе с обещанием о нём.
  //
  // Ссылка машиночитаемая, а не прозой в note. Проза разрешается только в
  // сторону «файл -> реестр»: по ней нельзя спросить, названа ли ЭТА запись.
  const named = new Map()
  for (const [file, body] of Object.entries(coverage.files || {})) {
    for (const key of (body || {}).not_implemented || []) {
      if (!items[key]) {
        fail(rel, `запись покрытия «${file}» называет неисполненным «${key}», ` +
          `которого в реестре нет. Либо запись сняли и ссылку забыли, либо ` +
          `ссылка написана с опечаткой`)
        continue
      }
      const where = String(items[key].declared_in || '').split('#')[0]
      if (where !== file) {
        fail(rel, `«${key}» назван в покрытии файла «${file}», а объявлен в ` +
          `«${where}». Ссылка обязана стоять там, где механизм объявлен`)
      }
      if (named.has(key)) {
        fail(rel, `«${key}» назван дважды: в «${named.get(key)}» и в «${file}»`)
      }
      named.set(key, file)
    }
  }

  for (const key of Object.keys(items)) {
    if (named.has(key)) continue
    const where = String(items[key].declared_in || '').split('#')[0]
    fail('spec/conformance/not-implemented.yaml',
      `запись «${key}» не держится ничем: в покрытии файла «${where}» её имени ` +
      `нет. Такую запись можно вырезать, и ни одна проверка этого не заметит - ` +
      `обещание исчезнет вместе с обещанием о нём`)
  }

  return checked
}

/**
 * Проверяет пометки уверенности по объявленным уровням.
 *
 * spec/extraction/rules.yaml объявляет три уровня и говорит, какие из них
 * допустимы в контракте: observed и inferred - да, assumed - нет. Своими же
 * словами файл объясняет почему: «придуманный селектор хуже отсутствующего -
 * отсутствующий виден сразу, придуманный тихо ломает разбор у всех шести SDK».
 *
 * Проверять это было нечем. Файл значился в реестре покрытия как verified и
 * назывался тремя наборами тестов, но не читался НИ ОДНИМ: проверялось
 * поведение, которое он описывает, а не он сам. Пометка assumed прошла бы
 * молча, и запрет остался бы словами.
 *
 * @returns {number} Число проверенных пометок.
 */
function checkConfidence() {
  const rulesRel = 'spec/extraction/rules.yaml'
  const rules = readYaml(path.join(SPEC, 'extraction', 'rules.yaml'))
  const levels = rules.confidence_levels || {}

  if (Object.keys(levels).length === 0) {
    fail(rulesRel, 'уровни уверенности не объявлены')
    return 0
  }

  const allowed = new Set()
  for (const [name, body] of Object.entries(levels)) {
    if ((body || {}).allowed_in_contract === true) allowed.add(name)
    if (!(body || {}).meaning) {
      fail(rulesRel, `уровень «${name}» не объясняет, что означает`)
    }
  }
  if (allowed.size === 0) {
    fail(rulesRel, 'ни один уровень уверенности не допущен в контракт')
  }

  let checked = 0
  const seen = (node, where, rel) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => seen(item, `${where}[${index}]`, rel))
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'confidence' && typeof value === 'string') {
        checked += 1
        if (!(value in levels)) {
          fail(rel, `${where}: уровень уверенности «${value}» не объявлен в ` +
            `${rulesRel}. Реализации истолкуют его каждая по-своему`)
        } else if (!allowed.has(value)) {
          fail(rel, `${where}: уровень «${value}» объявлен недопустимым в ` +
            `контракте. ${rulesRel} говорит прямо: придуманный селектор хуже ` +
            `отсутствующего - отсутствующий виден сразу, придуманный тихо ` +
            `ломает разбор`)
        }
        continue
      }
      seen(value, where ? `${where}.${key}` : key, rel)
    }
  }

  for (const name of fs.readdirSync(path.join(SPEC, 'extraction'))) {
    if (!name.endsWith('.yaml')) continue
    const rel = `spec/extraction/${name}`
    seen(readYaml(path.join(SPEC, 'extraction', name)), '', rel)
  }

  return checked
}

/**
 * Проверяет, что каждый объявленный класс изменений применяется классификатором.
 *
 * Та же болезнь, что и в реализации: объявление, которым никто не пользуется,
 * выглядит работающим. Класс изменений, записанный в правилах и не применяемый
 * скриптом, обещает, что такое изменение будет замечено, - а оно проходит молча.
 *
 * Проверка идёт в обе стороны. Класс, применяемый скриптом и не объявленный в
 * правилах, хуже вдвойне: у него нет объявленного bump, и классификация выдаст
 * undefined там, где должна выдать major.
 *
 * @returns {number} Число объявленных классов изменений.
 */
function checkChangeClasses() {
  const rel = 'spec/compat-rules.yaml'
  const rules = readYaml(path.join(SPEC, 'compat-rules.yaml'))
  const declared = Object.keys(rules.changes || {})
  if (declared.length === 0) {
    fail(rel, 'классы изменений не объявлены')
    return 0
  }

  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'compat.js'), 'utf8')
  const used = new Set()
  // Имя класса ищется как строка где угодно в скрипте, а не только внутри
  // вызова change(): часть классов подставляется из таблицы полей, и поиск по
  // вызову объявлял бы их неприменяемыми.
  const pattern = /'([a-z_]+)'/g
  let match
  while ((match = pattern.exec(script)) !== null) used.add(match[1])

  for (const name of declared) {
    if (!used.has(name)) {
      fail(rel, `класс изменений «${name}» объявлен, но классификатор его не ` +
        `применяет: правила обещают, что такое изменение будет замечено, а оно ` +
        `проходит молча`)
    }
  }
  // Обратная сторона смотрит ТОЛЬКО прямые вызовы change('...'). Широкий поиск
  // здесь давал бы ложные срабатывания на всякой строке в snake_case - именами
  // модулей Node, ключами полей, - и проверка, кричащая на 'child_process',
  // перестала бы читаться.
  const calls = new Set()
  const direct = /change\(\s*'([a-z_]+)'/g
  let call
  while ((call = direct.exec(script)) !== null) calls.add(call[1])

  for (const name of calls) {
    if (!declared.includes(name)) {
      fail('scripts/compat.js', `классификатор применяет класс «${name}», которого ` +
        `нет в правилах: у него нет объявленного bump, и классификация выдаст ` +
        `undefined там, где должна выдать major`)
    }
  }

  // Сторона классификации. Объявление говорит, ЧЬИМИ глазами смотрят на
  // изменение, и от него зависит знак у половины таблицы. Читателя не было, и
  // объявление могло разойтись с таблицей молча.
  const SIDES = ['sdk_consumer', 'sdk_author']
  const side = rules.classification_side
  if (!SIDES.includes(side)) {
    fail(rel, `classification_side «${side}» вне перечня ${SIDES.join(', ')}. ` +
      'Значение вне перечня проходило любое, а от стороны зависит знак у ' +
      'половины классов')
  }
  // Знаки объявлены для ОБЕИХ сторон, а не только для нынешней. Проверка,
  // срабатывающая при одном значении, обходится сменой этого значения: объяви
  // сторону авторской - и таблица с потребительскими знаками проходит молча.
  // Ровно это и показала мутация.
  //
  // Со стороны потребителя ослабление гарантии ломающее, а усиление - нет. Со
  // стороны автора знаки зеркальны: ему ломает то, что сужает его свободу.
  const SIGNS = {
    sdk_consumer: {
      required_to_optional: 'major',
      optional_to_required: 'minor',
      narrow_type: 'major',
      widen_type: 'major',
    },
    sdk_author: {
      required_to_optional: 'minor',
      optional_to_required: 'major',
      narrow_type: 'minor',
      widen_type: 'minor',
    },
  }
  if (SIGNS[side]) {
    const expected = SIGNS[side]
    for (const [kind, want] of Object.entries(expected)) {
      const got = ((rules.changes || {})[kind] || {}).bump
      if (got && got !== want) {
        fail(rel, `объявлена классификация со стороны «${side}», а класс ` +
          `${kind} держит bump «${got}» вместо «${want}». Ослабление поля до ` +
          'необязательного уехало бы минором, и обновившийся по минору ' +
          'пользователь получил бы пустоту там, где его код читал значение ' +
          'напрямую: в Python это падение в рантайме, в C - разыменование NULL')
      }
    }
  }

  // Правило нулевого мажора исполняет классификатор, и величину он теперь
  // читает отсюда. Мусорное значение не совпало бы ни с чем, и ломающее
  // изменение проехало бы без единого слова - хуже, чем неверное значение.
  const zero = rules.zero_major || {}
  if (!['major', 'minor', 'patch'].includes(zero.breaking_bumps)) {
    fail(rel, `zero_major.breaking_bumps «${zero.breaking_bumps}» вне перечня ` +
      'major, minor, patch. Классификатор сравнивает с этой величиной, и при ' +
      'мусорной он не совпадёт ни с чем: ломающее изменение уедет молча')
  }

  for (const [name, body] of Object.entries(rules.changes || {})) {
    if (!['major', 'minor', 'patch', 'forbidden'].includes(body.bump)) {
      fail(rel, `у класса «${name}» непонятный bump «${body.bump}»`)
    }
    // Объяснение может стоять под rationale либо под summary - оба имени в
    // файле уже прижились. Требуется одно из них: класс с объявленным bump и без
    // единого слова о причине читается как произвол, и первый же спорный случай
    // решат по-своему.
    const why = String(body.rationale || body.summary || '').trim()
    if (why.length < 30) {
      fail(rel, `класс «${name}» не объясняет, почему bump именно такой`)
    }
  }

  return declared.length
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
    // Нестроковые члены перечисления - не идентификаторы. Значение null означает
    // «значение может отсутствовать», и требовать от него snake_case
    // бессмысленно; прежде проверка на нём падала с TypeError, а падение
    // валидатора выглядит как поломка инструмента, а не как нарушение правила.
    if (typeof name !== 'string') return
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

    // Требование поля version снято вместе с самим полем: см. проверку
    // единственной оси версий ниже.

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
        : inherited.evidence

      // Уверенность наследуется так же, как ссылка на снимок. Без наследования
      // селектор, лежащий во вложенном узле, молча выпадает из перечня: узел
      // свой confidence не несёт, а перечень собирается по нему. Так однажды
      // исчез .tc-status, когда у статуса появилось два носителя, - без
      // единого нарушения и без строки в выводе.
      const confidence = typeof node.confidence === 'string'
        ? node.confidence
        : inherited.confidence

      // Область счётчика наследуется так же. Объявлять её у каждого поля
      // отдельно значило бы завести полтора десятка одинаковых строк, а забыть
      // одну - получить проверку, считающую строки документом.
      const scope = typeof node.scope === 'string' ? node.scope : inherited.scope

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
      }

      const sel = node.selector || node.selectors
      if (sel) {
        if (!confidence) {
          fail(rel, `${pointer}: селектор без пометки уверенности ни в самом узле, ` +
            'ни у любого из его предков. Такой селектор не попадает в перечень и ' +
            'не проверяется по снимкам - то есть перестаёт быть контрактом молча')
        }
        if (confidence === 'observed' && !evidence) {
          fail(rel, `${pointer}: селектор с пометкой observed без ссылки на снимок`)
        }
        if (confidence === 'observed' && evidence) {
          const list = Array.isArray(sel) ? sel : [sel]
          for (const one of list) {
            if (one.startsWith('self')) continue
            // Разделитель приводится к косой черте: иначе файл перестраивается
            // по-разному на Windows и на Linux, и проверка свежести падает в CI
            // на ровном месте.
            const where = `${rel.split(path.sep).join('/')}:${pointer}`
            // Счётчик кладётся в перечень вместе с селектором, и это не
            // украшение. Числа в спецификации протухли молча дважды: снимки
            // пересняли, элементов стало больше, а count_observed остался
            // прежним - и сверить его было нечем. Теперь сверяет соседний
            // репозиторий, у которого снимки под рукой.
            //
            // Правило области обязательно там, где счётчик есть: одно и то же
            // число означает то «столько на странице», то «столько в строке», и
            // без пометки проверяющий не знает, что считать.
            const entry = { selector: one, evidence, where }
            // Утверждение об ОТСУТСТВИИ - вторая половина наблюдения, и до сих
            // пор её не проверял никто. Признак вошедшего, который вдруг
            // нашёлся бы и на гостевой странице, перестал бы различать сессии -
            // а спецификация продолжала бы утверждать, что различает.
            if (Array.isArray(node.absent_in) && node.absent_in.length > 0) {
              entry.absent_in = node.absent_in
            }
            if (typeof node.count_observed === 'number') {
              const where_scope = scope || 'document'
              if (where_scope !== 'document' && where_scope !== 'row') {
                fail(rel, `${pointer}: неизвестная область счётчика "${where_scope}"`)
              }
              entry.count_observed = node.count_observed
              entry.scope = where_scope
            }
            selectors.push(entry)
          }
        }
      }

      // Отсутствие объявляется только там, где объявлено и присутствие:
      // «нигде не наблюдался, но вот здесь его точно нет» - утверждение ни о
      // чём, и проверить его нечем.
      if (Array.isArray(node.absent_in) && node.absent_in.length > 0) {
        if (!node.selector && !node.selectors) {
          fail(rel, `${pointer}: absent_in объявлен там, где нет селектора`)
        }
        const overlap = (evidence || []).filter((name) => node.absent_in.includes(name))
        if (overlap.length > 0) {
          fail(rel, `${pointer}: снимки ${overlap.join(', ')} названы и как ` +
            `свидетельство наличия, и как свидетельство отсутствия`)
        }
      }

      if (node.enum_is_closed === false && node.unknown_fallback !== 'required') {
        fail(rel, `${pointer}: открытое перечисление обязано требовать запасное значение ` +
          'для незнакомого, иначе незнакомое состояние станет ошибкой')
      }

      for (const key of Object.keys(node)) {
        visit(node[key], `${pointer}.${key}`, { evidence, confidence, scope })
      }
    }

    visit(doc, path.basename(file, '.yaml'), { evidence: null, confidence: null, scope: null })
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
  const changeClasses = checkChangeClasses()
  checkNotImplementedLinks()
  const confidences = checkConfidence()
  checkVersion()
  const symbols = checkCurrencySymbols()
  const enums = checkEnumOpenness()
  const axes = checkSingleVersionAxis()
  checkNoSecondRevisionDeclaration()
  const revisionParts = checkRevisionParts(
    readYaml(path.join(SPEC, 'events', 'delivery.yaml')) || {})
  const marks = checkDeprecationMarks(
    (readYaml(path.join(SPEC, 'version.yaml')) || {}).spec_version)
  const errorNames = checkErrorNamesResolve(
    new Set(Object.keys(readYaml(path.join(SPEC, 'errors', 'errors.yaml')).errors || {})))
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

  console.log(`пометок уверенности: ${confidences} | классов изменений: ${changeClasses} | типов: ${KNOWN_TYPES.size} | знаков валют: ${symbols} | перечислений: ${enums} | файлов без своей версии: ${axes} | составов версии: ${revisionParts} | пометок устаревшего: ${marks} | имён ошибок: ${errorNames} | схем: ${models} | ошибок: ${errors} | ` +
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

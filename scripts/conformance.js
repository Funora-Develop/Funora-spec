#!/usr/bin/env node
/**
 * Раннер набора соответствия.
 *
 * Собирает случаи из объявленных наборов, подаёт их реализации по протоколу
 * spec/conformance/runner-protocol.yaml и сверяет ответы.
 *
 * Живёт в репозитории спецификации, а не реализации, и это принципиально:
 * прогонять он будет любую из шести, и принадлежать одной ему нельзя.
 *
 * Главное правило - НЕЛЬЗЯ ПРОМОЛЧАТЬ. Пропуск без ссылки на запись реестра
 * неисполненного считается отказом. Набор, который можно тихо пропустить,
 * показывает согласие там, где его нет: отсутствие набора видно, ложное
 * согласие нет.
 *
 * Второе правило, добытое дорого: ОЖИДАЕМОЕ НЕ ПОКИДАЕТ РАННЕРА. Первая
 * редакция клала ожидаемое прямо в случай, а случай уезжал реализации целиком -
 * то есть проверяемому присылали ответ вместе с вопросом. Пустая реализация,
 * возвращающая присланное, проходила бы весь набор.
 *
 * Запуск:
 *   node scripts/conformance.js "python -m funora.conformance"
 *
 * Код возврата: 0 - отказов нет, 1 - есть. Пропуски на код не влияют: пропуск
 * это объявленное состояние, и ронять сборку из-за него значило бы требовать
 * полноты там, где реестр честно говорит о неполноте.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const yaml = require('js-yaml')

const ROOT = path.resolve(__dirname, '..')
const SPEC = path.join(ROOT, 'spec')

/**
 * Отвергает файл векторов и останавливает прогон.
 *
 * Порок в самих векторах - не отказ реализации, а поломка набора, и путать их
 * нельзя: отказ реализации разбирают, глядя в реализацию, и искали бы там же.
 *
 * @param {string} message Что именно не так.
 * @returns {void}
 */
function refuse(message) {
  console.error(`векторы негодны: ${message}`)
  process.exit(2)
}

/**
 * Читает объявление протокола.
 *
 * @returns {object} Разобранный runner-protocol.yaml.
 */
function protocol() {
  return yaml.load(
    fs.readFileSync(path.join(SPEC, 'conformance', 'runner-protocol.yaml'), 'utf8'))
}

/**
 * Читает перечень объявленных записей реестра неисполненного.
 *
 * @returns {Set<string>} Ключи записей.
 */
function registry() {
  const doc = yaml.load(
    fs.readFileSync(path.join(SPEC, 'conformance', 'not-implemented.yaml'), 'utf8'))
  return new Set(Object.keys((doc && doc.items) || {}))
}

/**
 * Читает файл векторов и сверяет объявленную им версию протокола.
 *
 * Штамп runner_protocol стоял в файлах векторов с самого начала и не читался
 * никем: набор, написанный под другую версию протокола, прогонялся бы молча.
 *
 * @param {string} name Имя файла в каталоге spec/conformance.
 * @param {number} expected Версия протокола, по которой работает раннер.
 * @returns {object|null} Разобранный файл либо null, если файла нет.
 */
function vectorFile(name, expected) {
  const file = path.join(SPEC, 'conformance', name)
  if (!fs.existsSync(file)) return null
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))

  if (doc.runner_protocol !== expected) {
    refuse(`${name} объявляет протокол ${doc.runner_protocol}, а раннер работает `
      + `по версии ${expected}. Прогнать набор чужой версии молча нельзя`)
  }
  return doc
}

/**
 * Собирает случаи набора канонической формы из файла векторов.
 *
 * Случаи выводятся из векторов, а не пишутся отдельно: два перечня одного и
 * того же разошлись бы молча.
 *
 * @param {number} version Версия протокола.
 * @returns {object[]} Пары «что уезжает реализации» и «чем сверять».
 */
function canonicalCases(version) {
  const vectors = vectorFile('canonical-form.vectors.json', version)
  if (vectors === null) return []

  const cases = []
  const add = (section, bucket, kind, list) => {
    list.forEach((vector, index) => {
      const refuses = kind.endsWith('_refuses')

      if (!refuses && vector.expected === undefined && vector.same_as === undefined) {
        refuse(`${section}.${bucket}[${index}] «${vector.name}» не объявил ожидаемого: `
          + 'ни expected, ни same_as. Такой случай проходил бы, не проверив ничего')
      }
      if (refuses && vector.expected !== undefined) {
        refuse(`${section}.${bucket}[${index}] «${vector.name}» - вектор отказа, и `
          + 'expected у него сверять нечем. Поле выглядит проверяемым и не проверяется')
      }
      if (refuses && vector.refuses_with === undefined) {
        refuse(`${section}.${bucket}[${index}] «${vector.name}» - вектор отказа и не `
          + 'назвал класса ошибки в refuses_with. Без имени класса отказ судит себя '
          + 'сам, и реализация, отвергающая всё подряд, случай проходит')
      }

      cases.push({
        ask: {
          id: `${section}/${vector.name}`,
          suite: 'canonical_form',
          kind,
          // Ссылка, а не значение. Раннер на JavaScript, и JSON.parse тут теряет
          // точность за 2^53 и не отличает 1.0 от 1 - то есть портит ровно те
          // различия, ради которых векторы и существуют. Разбирать вектор обязан
          // тот, кто будет с ним работать.
          vector: `${section}.${bucket}[${index}]`,
          ...(vector.why === undefined ? {} : { why: vector.why }),
        },
        // Ожидаемое остаётся ЗДЕСЬ и по проводу не уходит.
        judge: refuses
          ? { refuses_with: vector.refuses_with }
          : vector.expected === undefined
            ? { same_as: `${section}/${vector.same_as}` }
            : { value: vector.expected },
      })
    })
  }

  add('serialize', 'accept', 'serialize', vectors.serialize.accept)
  add('serialize', 'reject', 'serialize_refuses', vectors.serialize.reject)
  add('fingerprint', 'accept', 'fingerprint', vectors.fingerprint.accept)
  add('fingerprint', 'reject', 'fingerprint_refuses', vectors.fingerprint.reject)

  // Ссылка на другой случай разрешается в ЗНАЧЕНИЕ, если оно известно. Сверка
  // двух ответов между собой сама по себе дырява: реализация, не вернувшая
  // ничего, даёт undefined в обоих, а undefined равно undefined - и случай
  // проходит. Проверено полой реализацией: она проходила ровно этот случай и
  // никакой другой.
  const known = new Map()
  for (const one of cases) {
    if (one.judge.value !== undefined) known.set(one.ask.id, one.judge.value)
  }
  for (const one of cases) {
    const target = one.judge.same_as
    if (target === undefined) continue
    if (!cases.some((other) => other.ask.id === target)) {
      refuse(`случай «${one.ask.id}» ссылается на «${target}», которого в наборе нет`)
    }
    if (known.has(target)) {
      one.judge = { value: known.get(target), because_same_as: target }
    }
  }
  return cases
}

/**
 * Собирает случаи набора resume.
 *
 * Сценарий - не чистая функция: он несёт последовательность шагов и перезапуск
 * посередине. Поэтому случай ссылается на сценарий целиком, а сверяет раннер
 * не значение, а перечень доставленного по шагам.
 *
 * @param {number} version Версия протокола.
 * @returns {object[]} Пары «что уезжает реализации» и «чем сверять».
 */
function resumeCases(version) {
  const doc = vectorFile('resume.vectors.json', version)
  if (doc === null) return []

  return doc.scenarios.map((scenario, index) => {
    if (!Array.isArray(scenario.expected)) {
      refuse(`resume scenarios[${index}] «${scenario.name}» не объявил ожидаемого`)
    }
    if (scenario.expected.length !== scenario.steps.length) {
      refuse(`resume scenarios[${index}] «${scenario.name}»: шагов `
        + `${scenario.steps.length}, а ожиданий ${scenario.expected.length}. `
        + 'Сценарий проверял бы меньше, чем выглядит')
    }

    return {
      ask: {
        id: `resume/${scenario.name}`,
        suite: 'resume',
        kind: 'resume',
        vector: `scenarios[${index}]`,
        ...(scenario.why === undefined ? {} : { why: scenario.why }),
      },
      judge: { steps: scenario.expected },
    }
  })
}

/**
 * Собирает случаи набора capabilities.
 *
 * Проверяется решение о допуске, а не проба: проба ходит на площадку, и
 * воспроизвести её вектором нельзя. Решение объявлено нормативным в predicates
 * и обязано совпадать у всех реализаций - разойдись они, один и тот же код на
 * двух SDK уйдёт в разные ветки, и вторая сделает не то, что задумано, молча.
 *
 * Случаи трёх видов. Таблица решений - полный перебор пяти состояний на два
 * значения включения. Перебор по каждой возможности - требование
 * spec/capabilities.yaml#requirements, и ловит он реализацию, у которой одна
 * возможность обработана особо. Начальное состояние - то, с чего возможность
 * стартует до первой пробы.
 *
 * @param {number} version Версия протокола.
 * @returns {object[]} Пары «что уезжает реализации» и «чем сверять».
 */
function capabilitiesCases(version) {
  const doc = vectorFile('capabilities.vectors.json', version)
  if (doc === null) return []

  const caps = yaml.load(fs.readFileSync(path.join(SPEC, 'capabilities.yaml'), 'utf8'))
  const states = Object.keys(caps.states || {})
  const out = []

  /**
   * Превращает строку решения в пару «спросить, судить».
   *
   * @param {string} id Идентификатор случая.
   * @param {string} capability Возможность, на которой проверяется решение.
   * @param {object} row Строка вектора.
   * @returns {object} Пара.
   */
  const decisionCase = (id, capability, row) => {
    if (row.allowed !== true && row.allowed !== false) {
      refuse(`capabilities «${id}»: строка не объявила allowed`)
    }
    if (row.allowed === false && !row.error) {
      refuse(`capabilities «${id}»: отказ объявлен без класса ошибки. `
        + 'Вызывающий пишет except по классу, и «просто отклонено» ему нечем ловить')
    }
    if (row.allowed === true && row.error) {
      refuse(`capabilities «${id}»: вызов разрешён и назван класс ошибки. `
        + 'Одно из двух неверно')
    }
    if (!states.includes(row.state)) {
      refuse(`capabilities «${id}»: состояние «${row.state}» не объявлено `
        + 'в spec/capabilities.yaml')
    }
    return {
      ask: {
        id,
        suite: 'capabilities',
        kind: 'capability_decision',
        capability,
        state: row.state,
        opted_in: row.opted_in === true,
        ...(row.why === undefined ? {} : { why: row.why }),
      },
      judge: {
        value: row.allowed ? 'разрешено' : row.error,
      },
    }
  }

  // Первая возможность перечня служит носителем таблицы решений: решение от
  // конкретной возможности не зависит, и это как раз проверяет перебор ниже.
  const ids = Object.keys(caps.capabilities || {})
  if (ids.length === 0) refuse('capabilities: в spec/capabilities.yaml нет ни одной возможности')
  const carrier = ids[0]

  const rows = (doc.decision || {}).rows || []
  const seen = new Set()
  for (const row of rows) {
    seen.add(`${row.state}/${row.opted_in === true}`)
    out.push(decisionCase(
      `capabilities/решение/${row.state}/${row.opted_in === true ? 'включено' : 'не включено'}`,
      carrier, row))
  }

  // Перебор обязан быть ПОЛНЫМ. Пропущенная строка - это состояние, о котором
  // набор молчит, и молчит он ровно там, где реализации расходятся: у
  // experimental признак usable равен true, и без строки «не включено» решение
  // по признаку вместо предиката проходит.
  for (const state of states) {
    for (const opted of [true, false]) {
      if (!seen.has(`${state}/${opted}`)) {
        refuse(`capabilities: в таблице решений нет строки «${state}, `
          + `${opted ? 'включено' : 'не включено'}». Перебор обязан быть полным`)
      }
    }
  }

  // Состав веток сверяется с требованием из spec/capabilities.yaml, а не с
  // самим набором. Прежде здесь стояло «перечень непуст», и этого мало: убери
  // ветку unsupported - двадцать два вектора исчезают, а раннер печатает
  // «отказов: 0» и выходит с нулём. Набор, который вправе тихо уменьшиться,
  // показывает согласие там, где перестал спрашивать.
  const required = (caps.conformance_requirements || {})
  const wanted = required.per_capability_branches || []
  if (wanted.length === 0) {
    refuse('spec/capabilities.yaml: не объявлено conformance_requirements.'
      + 'per_capability_branches. Без него набор вправе уменьшиться до одной '
      + 'ветки, и никто не заметит')
  }

  const branches = (doc.per_capability || {}).branches || []
  for (const want of wanted) {
    const got = branches.find((one) => one.state === want.state)
    if (!got) {
      refuse(`capabilities: в per_capability.branches нет ветки «${want.state}», `
        + 'а spec/capabilities.yaml объявляет её обязательной. Без неё набор '
        + 'перестаёт спрашивать у реализаций, что они делают в этом состоянии, '
        + 'и продолжает показывать согласие')
      continue
    }
    if (got.allowed !== want.allowed) {
      refuse(`capabilities: ветка «${want.state}» объявлена allowed: `
        + `${got.allowed}, а требуется ${want.allowed}`)
    }
    if (want.typed_error === 'required' && !got.error) {
      refuse(`capabilities: ветка «${want.state}» не называет класса ошибки, `
        + 'а требование объявляет его обязательным. Вызывающий пишет except по '
        + 'классу, и «просто отклонено» ему нечем ловить')
    }
  }
  for (const id of ids) {
    for (const branch of branches) {
      out.push(decisionCase(`capabilities/${id}/${branch.state}`, id, branch))
    }
  }

  // Начальное состояние тоже обязано проверяться, и обязанность объявлена не
  // здесь: check: false молча уносил двадцать два случая.
  if (required.initial_state_required === true && (doc.initial_state || {}).check !== true) {
    refuse('capabilities: spec/capabilities.yaml требует проверки начального '
      + 'состояния, а набор объявляет initial_state.check не равным true. '
      + 'Состояние до первой пробы решает поведение при самом первом вызове')
  }
  if ((doc.initial_state || {}).check === true) {
    for (const id of ids) {
      const initial = (caps.capabilities[id] || {}).initial
      if (!initial) refuse(`capabilities «${id}»: не объявлено начальное состояние`)
      out.push({
        ask: {
          id: `capabilities/${id}/начальное`,
          suite: 'capabilities',
          kind: 'capability_initial',
          capability: id,
          why: 'Состояние до первой пробы решает поведение при самом первом вызове.',
        },
        judge: { value: initial },
      })
    }
  }

  return out
}

/**
 * Собирает случаи набора rate-budget.
 *
 * @param {number} version Версия протокола.
 * @returns {object[]} Пары «что уезжает реализации» и «чем сверять».
 */
function rateBudgetCases(version) {
  const doc = vectorFile('rate-budget.vectors.json', version)
  if (doc === null) return []

  const checkable = ['refused', 'at', 'not_before', 'not_after', 'total_sent_at_most',
    'served_in_order']

  return doc.scenarios.map((scenario, index) => {
    const want = scenario.expected || {}
    const named = checkable.filter((key) => want[key] !== undefined)
    if (named.length === 0) {
      refuse(`rate-budget scenarios[${index}] «${scenario.name}» не объявил ничего `
        + `проверяемого: ожидались какие-то из ${checkable.join(', ')}`)
    }
    if (scenario.concurrent && scenario.requires === undefined) {
      refuse(`rate-budget scenarios[${index}] «${scenario.name}» объявлен одновременным `
        + 'и не назвал записи реестра в поле requires. Реализация без очереди не '
        + 'смогла бы честно пропустить его')
    }

    // Длину трассы считает раннер по самому вектору. Без неё реализация,
    // вернувшая пустой перечень, проходит любое ограничение сверху: ноль
    // отправленных не больше никакого предела.
    const count = scenario.requests
      ? scenario.requests.length
      : scenario.generate.accounts * scenario.generate.per_account

    return {
      ask: {
        id: `rate-budget/${scenario.name}`,
        suite: 'rate_budget',
        kind: 'rate_budget',
        vector: `scenarios[${index}]`,
        ...(scenario.why === undefined ? {} : { why: scenario.why }),
      },
      judge: { trace: { ...want, request_count: count } },
    }
  })
}

/**
 * Сверяет трассу отправки с ожидаемым.
 *
 * Точная метка (at) требуется там, где ожидания не было вовсе. Где оно было -
 * требуется КОРИДОР из not_before и not_after: запас в ведре считается числами
 * с плавающей точкой, и последний бит деления даёт то 199, то 200 миллисекунд.
 * Одной нижней границы мало - реализация, восстанавливающая право на залп вдвое
 * медленнее объявленного, все нижние границы соблюдает.
 *
 * @param {object} answer Ответ реализации.
 * @param {object} want Ожидаемое из вектора.
 * @returns {string} Пустая строка, если сошлось, иначе описание расхождения.
 */
function checkTrace(answer, want) {
  const sent = answer.sent
  if (!Array.isArray(sent)) return `трасса не пришла вовсе: ${JSON.stringify(sent)}`
  if (sent.length !== want.request_count) {
    return `в трассе ${sent.length} меток, а запросов в сценарии `
      + `${want.request_count}. Метка обязана быть у каждого`
  }

  if (want.refused) {
    const got = sent.map((one, index) => (one === null ? index : -1)).filter((one) => one >= 0)
    if (JSON.stringify(got) !== JSON.stringify(want.refused)) {
      return `не ушли запросы ${JSON.stringify(got)}, ожидалось ${JSON.stringify(want.refused)}`
    }
  }

  for (const [index, moment] of Object.entries(want.at || {})) {
    if (sent[index] !== moment) {
      return `запрос ${index} ушёл в ${sent[index]}, ожидалось ровно ${moment}`
    }
  }

  const bounded = (bounds, worse) => {
    for (const [index, edge] of Object.entries(bounds || {})) {
      if (Number(index) >= sent.length) {
        return `граница объявлена запросу ${index}, а в трассе всего ${sent.length}`
      }
      if (sent[index] === null || sent[index] === undefined) {
        return `запрос ${index} не ушёл вовсе, а ожидался в границах около ${edge}`
      }
      if (worse(sent[index], edge)) {
        return `запрос ${index} ушёл в ${sent[index]}, а граница ${edge}`
      }
    }
    return ''
  }

  const low = bounded(want.not_before, (got, edge) => got < edge)
  if (low) return low
  const high = bounded(want.not_after, (got, edge) => got > edge)
  if (high) return high

  if (want.total_sent_at_most !== undefined) {
    const total = sent.filter((one) => one !== null).length
    if (total > want.total_sent_at_most) {
      return `ушло ${total} запросов, а больше ${want.total_sent_at_most} уйти не может`
    }
  }

  if (want.served_in_order !== undefined) {
    // Порядок обслуживания НЕ выводится из меток: при одновременном поступлении
    // честная реализация с очередью вправе вернуть одинаковые метки. Поэтому
    // порядок обязан прийти отдельным полем - иначе сверять нечего.
    if (!Array.isArray(answer.served)) {
      return 'сценарий проверяет порядок обслуживания, а поле served не пришло. '
        + 'Из меток отправки порядок не выводится: они могут совпасть'
    }
    const got = JSON.stringify(answer.served)
    const need = JSON.stringify(want.served_in_order)
    if (got !== need) return `обслужено в порядке ${got}, ожидалось ${need}`
  }

  return ''
}

/**
 * Подаёт случаи реализации и читает ответы.
 *
 * @param {string} command Команда реализации.
 * @param {object[]} cases Случаи; уезжает только поле ask.
 * @returns {Map<string, object>} Ответы по идентификатору случая.
 */
function ask(command, cases) {
  const input = cases.map((one) => JSON.stringify(one.ask)).join('\n') + '\n'
  const parts = command.split(/\s+/)
  const run = spawnSync(parts[0], parts.slice(1), {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  if (run.error) {
    console.error(`не удалось запустить реализацию: ${run.error.message}`)
    process.exit(2)
  }
  if (run.stderr && run.stderr.trim()) {
    console.error(run.stderr.trim())
  }

  const answers = new Map()
  for (const line of (run.stdout || '').split('\n')) {
    if (!line.trim()) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      console.error(`ответ не разбирается как JSON: ${line.slice(0, 120)}`)
      process.exit(2)
    }
    answers.set(parsed.id, parsed)
  }
  return answers
}

/**
 * Сверяет один ответ с тем, чем этот случай судится.
 *
 * @param {object} one Случай: поля ask и judge.
 * @param {object} answer Ответ реализации.
 * @param {Map<string, object>} answers Все ответы - нужны сверке с другим случаем.
 * @returns {string} Пустая строка, если сошлось, иначе описание расхождения.
 */
function verdict(one, answer, answers) {
  const judge = one.judge

  if (judge.trace !== undefined) return checkTrace(answer, judge.trace)

  if (judge.steps !== undefined) {
    const got = JSON.stringify(answer.steps)
    const need = JSON.stringify(judge.steps)
    return got === need ? '' : `по шагам получено ${got}, ожидалось ${need}`
  }

  if (judge.value !== undefined) {
    if (answer.value === judge.value) return ''
    const source = judge.because_same_as === undefined
      ? ''
      : ` (ответ обязан совпасть с «${judge.because_same_as}»)`
    return `получено ${JSON.stringify(answer.value)}, ожидалось `
      + `${JSON.stringify(judge.value)}${source}`
  }

  if (judge.same_as !== undefined) {
    // Сюда доходят только ссылки на случай, у которого своего ожидаемого нет, -
    // прочие разрешены в значение при сборке. Пустой ответ отвергается прежде
    // сравнения: иначе два «ничего» совпадут и случай пройдёт.
    const other = answers.get(judge.same_as)
    if (answer.value === undefined || answer.value === null) {
      return `ответ пуст, а обязан совпасть с «${judge.same_as}». Два пустых `
        + 'ответа совпадают между собой и не значат ничего'
    }
    if (!other || other.value !== answer.value) {
      return `ответ обязан совпасть с «${judge.same_as}»: ${answer.value} против `
        + `${other ? other.value : 'ответа нет'}`
    }
    return ''
  }

  if (judge.refuses_with !== undefined) {
    // Отказ обязан быть ИМЕНОВАННЫМ. Иначе случай судит себя сам, и реализация,
    // отвергающая всё подряд, проходит его наравне с правильной. Заодно это
    // держит согласие классов ошибок: два SDK, отвергающие дробное число
    // разными классами, заставляют вызывающего писать разный except.
    if (answer.value !== judge.refuses_with) {
      return `отказ обязан быть классом «${judge.refuses_with}», а пришло `
        + `${JSON.stringify(answer.value)}`
    }
    return ''
  }

  // Страховка на случай, если сюда доедет случай, которому нечем судить.
  // Прежде такой случай молча засчитывался пройденным.
  return 'случай не объявил ожидаемого: судить его нечем'
}

/**
 * Прогоняет набор и печатает итог.
 *
 * @returns {number} Код возврата.
 */
function main() {
  const command = process.argv[2]
  if (!command) {
    console.error('нужна команда реализации, например: '
      + 'node scripts/conformance.js "python -m funora.conformance"')
    return 2
  }

  const declared = protocol()
  const known = registry()
  const version = declared.protocol
  const cases = [
    ...canonicalCases(version),
    ...resumeCases(version),
    ...rateBudgetCases(version),
    ...capabilitiesCases(version),
  ]
  const answers = ask(command, cases)

  let passed = 0
  const failures = []
  const skipped = []

  for (const one of cases) {
    const answer = answers.get(one.ask.id)
    if (!answer) {
      failures.push([one.ask.id, 'реализация не ответила на случай вовсе'])
      continue
    }

    if (answer.outcome === 'skip') {
      const named = answer.not_implemented
      if (!named) {
        // Пропуск без ссылки - отказ. Ровно то, ради чего протокол написан:
        // реализация вправе чего-то не уметь и не вправе делать вид, что умеет.
        failures.push([one.ask.id, 'пропуск без ссылки на реестр неисполненного'])
        continue
      }
      if (!known.has(named)) {
        failures.push([one.ask.id,
          `пропуск ссылается на запись «${named}», которой в реестре нет`])
        continue
      }
      skipped.push([one.ask.id, named])
      continue
    }

    if (answer.outcome === 'pass') {
      const complaint = verdict(one, answer, answers)
      if (complaint) {
        failures.push([one.ask.id, complaint])
        continue
      }
      passed += 1
      continue
    }

    failures.push([one.ask.id, answer.detail || 'отказ без подробностей'])
  }

  const suites = new Set(cases.map((one) => one.ask.suite))
  console.log(`протокол: ${version}`)
  console.log(`наборов: ${suites.size} | случаев: ${cases.length}`)
  console.log(`пройдено: ${passed} | отказов: ${failures.length} | пропущено: ${skipped.length}`)

  if (skipped.length > 0) {
    console.log('')
    console.log('пропущено по объявленной неполноте:')
    for (const [id, named] of skipped) console.log(`  ${id} -> ${named}`)
  }

  if (failures.length > 0) {
    console.log('')
    console.log('отказы:')
    for (const [id, detail] of failures) console.log(`  ${id}: ${detail}`)
    return 1
  }

  return 0
}

process.exit(main())

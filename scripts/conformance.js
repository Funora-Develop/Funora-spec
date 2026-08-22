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
 * Собирает случаи набора канонической формы из файла векторов.
 *
 * Случаи выводятся из векторов, а не пишутся отдельно: два перечня одного и
 * того же разошлись бы молча.
 *
 * @returns {object[]} Случаи по протоколу.
 */
function canonicalCases() {
  const vectors = JSON.parse(fs.readFileSync(
    path.join(SPEC, 'conformance', 'canonical-form.vectors.json'), 'utf8'))

  const cases = []
  const add = (section, bucket, kind, list) => {
    list.forEach((vector, index) => {
      cases.push({
        id: `${section}/${vector.name}`,
        suite: 'canonical_form',
        kind,
        // Ссылка, а не значение. Раннер на JavaScript, и JSON.parse тут теряет
        // точность за 2^53 и не отличает 1.0 от 1 - то есть портит ровно те
        // различия, ради которых векторы и существуют. Разбирать вектор обязан
        // тот, кто будет с ним работать.
        vector: `${section}.${bucket}[${index}]`,
        ...(vector.expected === undefined ? {} : { expected: vector.expected }),
        ...(vector.same_as === undefined
          ? {}
          : { same_as: `${section}/${vector.same_as}` }),
        ...(vector.why === undefined ? {} : { why: vector.why }),
      })
    })
  }

  add('serialize', 'accept', 'serialize', vectors.serialize.accept)
  add('serialize', 'reject', 'serialize_refuses', vectors.serialize.reject)
  add('fingerprint', 'accept', 'fingerprint', vectors.fingerprint.accept)
  add('fingerprint', 'reject', 'fingerprint_refuses', vectors.fingerprint.reject)
  return cases
}

/**
 * Подаёт случаи реализации и читает ответы.
 *
 * @param {string} command Команда реализации.
 * @param {object[]} cases Случаи.
 * @returns {Map<string, object>} Ответы по идентификатору случая.
 */
function ask(command, cases) {
  const input = cases.map((one) => JSON.stringify(one)).join('\n') + '\n'
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
  const cases = canonicalCases()
  const answers = ask(command, cases)

  let passed = 0
  const failures = []
  const skipped = []

  for (const one of cases) {
    const answer = answers.get(one.id)
    if (!answer) {
      failures.push([one.id, 'реализация не ответила на случай вовсе'])
      continue
    }

    if (answer.outcome === 'skip') {
      const named = answer.not_implemented
      if (!named) {
        // Пропуск без ссылки - отказ. Ровно то, ради чего протокол написан:
        // реализация вправе чего-то не уметь и не вправе делать вид, что умеет.
        failures.push([one.id, 'пропуск без ссылки на реестр неисполненного'])
        continue
      }
      if (!known.has(named)) {
        failures.push([one.id, `пропуск ссылается на запись «${named}», которой в реестре нет`])
        continue
      }
      skipped.push([one.id, named])
      continue
    }

    if (answer.outcome === 'pass') {
      // Случай, сверяемый с другим, проверяет раннер: реализация своих ответов
      // между собой не сравнивает и сравнивать не обязана.
      if (one.same_as) {
        const other = answers.get(one.same_as)
        if (!other || other.value !== answer.value) {
          failures.push([one.id,
            `ответ обязан совпасть с «${one.same_as}»: ${answer.value} против `
            + `${other ? other.value : 'ответа нет'}`])
          continue
        }
      }
      passed += 1
      continue
    }

    failures.push([one.id, answer.detail || 'отказ без подробностей'])
  }

  console.log(`протокол: ${declared.protocol}`)
  console.log(`наборов: 1 | случаев: ${cases.length}`)
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

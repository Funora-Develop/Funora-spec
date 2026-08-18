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
    if (a.type !== b.type) {
      change('narrow_type', rel, `поле ${name}: тип изменился с ${a.type} на ${b.type}`)
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
  for (const [id, op] of Object.entries(b)) {
    if (!(id in a)) { change('add_operation', rel, `добавлена операция ${id}`); continue }
    if (a[id].safety !== op.safety) {
      change('change_operation_safety', rel,
        `${id}: safety изменилась с ${a[id].safety} на ${op.safety} - меняет решение ` +
        `о повторе на стороне транспорта`)
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
  return { was: w, now: n, bump }
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
    if (kind === 'canonical_form_change') return (rules.canonical_form_change || {}).bump || 'major'
    const r = (rules.changes || {})[kind]
    return r ? r.bump : 'major'
  }

  const oldFiles = new Set(listAt(base))
  const newFiles = listNow()

  if (oldFiles.size === 0) {
    console.log(`базовая точка ${base} не содержит spec - сравнивать не с чем`)
    process.exit(0)
  }

  for (const rel of newFiles) {
    const now = parse(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'))
    const was = parse(rel, readAt(base, rel))
    if (!now) continue

    if (!was) {
      if (rel.includes('/models/') || rel.includes('/events/')) {
        change('add_operation', rel, 'новый файл схемы')
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

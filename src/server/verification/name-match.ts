import type { PlaceCandidate } from '../maps'

// 生成した予定の名称と、Places上の施設を、同じ施設とみなしてよいかの判定（名称・所在地のゲート）。
// 疎通確認で、別の施設（飲食店→別の飲食店、飲食店→医院）に紐付く事例があったため、名称が一致しない候補は
// 採用しない。名称の一致は、実在や同一性の保証ではない。迷う場合は「確認できない」にする。
//
// 採用する条件（すべて満たすときだけ）：
// - 名称が完全に一致する（部分一致は採用しない。「清水寺」と「清水寺 奥の院」のような別施設を避ける）。
//   比較で無視するのは、空白と、引用符・括弧類（「」『』【】“”）の装飾だけ。「/」「・」などの記号は、
//   名称の一部として扱う（「A/B」と「AB」を同じにしない）。括弧書きは、識別情報（支店・別館など）として、
//   位置も含めて一致が必要（「資料館（別館）」と「資料館」、「A（店）B」と「AB（店）」は別）。
// - 候補の所在地が、住所の行政区画（都道府県・市区町村）の階層で、旅程の地域と一致する。地域が複数の要素
//   （「福島・郡山」など）なら、すべての要素を、同じ住所の、重ならない行政区画で確認できたときだけ。
//   住所の解析や階層が不明確なら、採用しない（確認できない）。

// 比較で無視する文字：空白と、引用符・括弧類の装飾だけ。
const IGNORED = /[\s「」『』【】“”"]/g
const PAREN_GROUP = /\(([^)]*)\)/g

const strip = (text: string): string => text.replace(IGNORED, '')

export interface ParsedName {
  // 括弧書きを除いた名称（重複の判定用）
  base: string
  // 括弧書きの内容（支店名・別館など。識別情報）
  qualifier: string
  // 括弧書きを、位置も含めて残した名称（一致の判定用）
  full: string
}

export function parseName(name: string): ParsedName {
  // 全角の括弧は、NFKCで半角になる。
  const text = name.normalize('NFKC').toLowerCase()
  const qualifiers: string[] = []
  const base = text.replace(PAREN_GROUP, (_match, inner: string) => {
    qualifiers.push(strip(inner))
    return ''
  })
  return { base: strip(base), qualifier: qualifiers.join(''), full: strip(text) }
}

export type NameMatchKind = 'exact' | 'none'

export function compareNames(generated: string, found: string): NameMatchKind {
  const a = parseName(generated)
  const b = parseName(found)
  if (a.base.length === 0 || b.base.length === 0) return 'none'
  // 括弧書きは、識別情報。位置を含めて、全体が一致するときだけ同じ名称とする。
  return a.full === b.full ? 'exact' : 'none'
}

const REGION_SUFFIX = /(周辺|付近|近辺|エリア|地区|方面|一帯|市内|県内|府内|都内|区内|町内|村内)$/

// 語尾は、重なっていても（「東山エリア周辺」）、すべて外す。
const stripRegionSuffixes = (token: string): string => {
  let result = token
  for (
    let next = result.replace(REGION_SUFFIX, '');
    next !== result;
    next = result.replace(REGION_SUFFIX, '')
  ) {
    result = next
  }
  return result
}

// 地域を、要素（「京都・東山」なら「京都」「東山」）に分ける。
export function regionTokens(region: string): string[] {
  return (
    region
      .normalize('NFKC')
      .toLowerCase()
      // 括弧書きの補足（「（架空デモ）」など）は、地域の語に含めない。
      .replace(/\([^)]*\)/g, '')
      .split(/[・･,、，/／\s\-–—−〜~]+/)
      .map(stripRegionSuffixes)
      .filter((token) => token.length > 0)
  )
}

// 日本の住所の行政区画を、住所の先頭から、階層の順に読み取る：
//   都道府県 → 郡（→ 町・村）／市（→ 区）／（東京都は）特別区
// 読み取れない（日本の住所と確かめられない）ときは、null。町名・丁目・建物名は、行政区画として扱わない
// （町・村は、郡の下にあるものだけを行政区画とする。「神田神保町」のような町名を、町として読み取らない）。
const COUNTRY_PREFIX = /^(日本|japan)[、,\s]*/
const POSTAL_CODE = /^〒?\s*\d{3}-?\d{4}\s*/
const PREFECTURE = /^(北海道|東京都|京都府|大阪府|[^\s\d、,]{2,3}県)/
const NAME = '[^\\s\\d、,]'
const COUNTY = new RegExp(`^${NAME}{1,6}?郡`)
const TOWN_OR_VILLAGE = new RegExp(`^${NAME}{1,6}?[町村]`)
const CITY = new RegExp(`^${NAME}{1,6}?市`)
const WARD = new RegExp(`^${NAME}{1,5}?区`)

export function administrativeUnits(address: string | undefined): string[] | null {
  if (!address) return null
  let rest = address.normalize('NFKC').trim().replace(COUNTRY_PREFIX, '').replace(POSTAL_CODE, '')
  const prefecture = PREFECTURE.exec(rest)?.[1]
  if (!prefecture) return null
  const units = [prefecture]
  rest = rest.slice(prefecture.length)

  const take = (pattern: RegExp): boolean => {
    const matched = pattern.exec(rest)?.[0]
    if (!matched) return false
    units.push(matched)
    rest = rest.slice(matched.length)
    return true
  }

  if (take(COUNTY)) {
    take(TOWN_OR_VILLAGE)
  } else if (prefecture === '東京都' && take(WARD)) {
    // 特別区。
  } else if (take(CITY)) {
    take(WARD)
  }
  return units
}

// 行政区画の名称：「京都市」と「京都」、「東山区」と「東山」のどちらでも一致とする。
const unitForms = (unit: string): string[] => [unit, unit.slice(0, -1)]

// 地域の1要素が、住所の行政区画の並び（階層の順）として、すべて読み取れるか（例：「京都市東山」＝京都市→東山区）。
// 使った行政区画は、used に記録する。
function consumeComponent(
  rest: string,
  units: readonly string[],
  from: number,
  used: ReadonlySet<number>,
  next: (used: ReadonlySet<number>) => boolean,
): boolean {
  if (rest === '') return next(used)
  for (let index = from; index < units.length; index += 1) {
    if (used.has(index)) continue
    for (const form of unitForms(units[index])) {
      if (form.length > 0 && rest.startsWith(form)) {
        const nextUsed = new Set(used).add(index)
        if (consumeComponent(rest.slice(form.length), units, index + 1, nextUsed, next)) return true
      }
    }
  }
  return false
}

function matchAllComponents(
  components: readonly string[],
  units: readonly string[],
  used: ReadonlySet<number>,
): boolean {
  const [head, ...tail] = components
  if (head === undefined) return true
  return consumeComponent(head, units, 0, used, (nextUsed) =>
    matchAllComponents(tail, units, nextUsed),
  )
}

// 候補の所在地が、旅程の地域と、行政区画の階層で一致するか。
// 地域のすべての要素を、同じ住所の、重ならない行政区画で確認できたときだけ、一致とする
// （「福島・郡山」に対して、大阪市福島区や、福島県までしか分からない住所は、一致としない）。
// 住所が無い・日本の住所と読み取れない・地域の要素が行政区画でないときは、裏付けなし（確認できない）。
export function addressMatchesRegion(address: string | undefined, region: string): boolean {
  const units = administrativeUnits(address)
  if (!units) return false
  const components = regionTokens(region)
  return components.length > 0 && matchAllComponents(components, units, new Set())
}

export type PlaceSelection =
  | { status: 'matched'; place: PlaceCandidate }
  // 名称が一致する候補が複数あり、1つに絞れない（チェーン店の複数店舗など）。
  | { status: 'ambiguous'; count: number }
  // 名称は一致するが、所在地が旅程の地域と一致する（と確かめられる）候補がない。
  | { status: 'region_mismatch' }
  // 候補はあるが、どれも名称が一致しない（別の施設の可能性）。
  | { status: 'mismatch' }
  | { status: 'no_candidates' }

export function selectPlace(
  generatedName: string,
  region: string,
  candidates: readonly PlaceCandidate[],
): PlaceSelection {
  if (candidates.length === 0) return { status: 'no_candidates' }

  const named = candidates.filter((place) => compareNames(generatedName, place.name) === 'exact')
  if (named.length === 0) return { status: 'mismatch' }

  const inRegion = named.filter((place) => addressMatchesRegion(place.address, region))
  if (inRegion.length === 0) return { status: 'region_mismatch' }

  // 同じ施設を指す重複（同一のPlace ID）は1件として数える。
  const distinct = new Set(inRegion.map((place) => place.placeId))
  if (distinct.size > 1) return { status: 'ambiguous', count: distinct.size }
  return { status: 'matched', place: inRegion[0] }
}

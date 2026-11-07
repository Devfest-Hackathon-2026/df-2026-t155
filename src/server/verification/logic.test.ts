import { describe, expect, it } from 'vitest'

import type { OpeningPeriod, PlaceCandidate } from '../maps'
import {
  addressMatchesRegion,
  administrativeUnits,
  compareNames,
  parseName,
  regionTokens,
  selectPlace,
} from './name-match'
import { checkOpeningHours, weekdayIndex, weekdayName } from './opening-hours'
import { availableMinutes, evaluateTravel, hasTimeConflict } from './travel'

const REGION = '京都・東山'
const KYOTO_ADDRESS = '日本、〒605-0862 京都府京都市東山区清水1丁目294'
const OSAKA_ADDRESS = '日本、〒530-0001 大阪府大阪市北区梅田'
const place = (
  placeId: string,
  name: string,
  address: string | null = KYOTO_ADDRESS,
): PlaceCandidate => ({
  placeId,
  name,
  address: address ?? undefined,
  openingHours: { status: 'not_requested' },
})

describe('名称の解析と一致', () => {
  it('空白・記号・全角半角・大文字小文字の違いを吸収する', () => {
    expect(parseName('奥丹 清水').base).toBe(parseName('奥丹清水').base)
    expect(parseName('ＡＢＣ　カフェ').base).toBe(parseName('abcカフェ').base)
    expect(parseName('「茶寮 都路里」').base).toBe('茶寮都路里')
  })

  it('識別に必要な記号は、無視しない（「A/B」と「AB」・「A・B」と「AB」は別の名称）', () => {
    expect(parseName('A/B').base).not.toBe(parseName('AB').base)
    expect(parseName('A・B').base).not.toBe(parseName('AB').base)
    expect(compareNames('A/B', 'AB')).toBe('none')
    expect(compareNames('カフェ・ド・クリエ', 'カフェドクリエ')).toBe('none')
  })

  it('括弧書きは、比較用の名称から分け、識別情報として保持する', () => {
    expect(parseName('昼食店A（架空）')).toEqual({
      base: '昼食店a',
      qualifier: '架空',
      full: '昼食店a(架空)',
    })
    expect(parseName('カフェ(京都駅店)')).toMatchObject({ base: 'カフェ', qualifier: '京都駅店' })
  })

  it('正規化後に同じなら exact', () => {
    expect(compareNames('総本家 ゆどうふ 奥丹清水', '総本家ゆどうふ奥丹清水')).toBe('exact')
    expect(compareNames('清水寺', '清水寺')).toBe('exact')
  })

  it('支店名が異なる（括弧書きを保持して比べる）場合は、同じ施設としない', () => {
    expect(compareNames('麺処いちょう庵（四条店）', '麺処いちょう庵（河原町店）')).toBe('none')
    expect(compareNames('麺処いちょう庵（四条店）', '麺処いちょう庵（四条店）')).toBe('exact')
  })

  it('見つかった施設だけが支店を名乗る・生成した名称だけが支店を指定する場合は、確かめられない', () => {
    expect(compareNames('麺処いちょう庵', '麺処いちょう庵（河原町店）')).toBe('none')
    expect(compareNames('麺処いちょう庵（四条店）', '麺処いちょう庵')).toBe('none')
  })

  it('括弧書きの位置が異なる名称は、同じ施設としない（識別情報が失われない）', () => {
    expect(compareNames('A（本店）B', 'AB（本店）')).toBe('none')
    expect(compareNames('（本店）AB', 'AB（本店）')).toBe('none')
    expect(compareNames('A（本店）B', 'A（本店）B')).toBe('exact')
    // 括弧の全角・半角の違いと、括弧内の空白は、無視する。
    expect(compareNames('AB（本店）', 'AB( 本店 )')).toBe('exact')
  })

  it('括弧書きが一方にしかなければ、補足に見えても、同じ施設と確かめられない', () => {
    expect(compareNames('資料館（別館）', '資料館')).toBe('none')
    expect(compareNames('資料館', '資料館（別館）')).toBe('none')
    expect(compareNames('洛東食事処（サンプル）', '洛東食事処')).toBe('none')
    expect(compareNames('資料館（別館）', '資料館（別館）')).toBe('exact')
  })

  it('部分一致は認めない（別の施設を採用しない）', () => {
    expect(compareNames('祇園辻利', '祇園辻利 祇園本店')).toBe('none')
    expect(compareNames('清水寺', '清水寺 奥の院')).toBe('none')
    expect(compareNames('清水', '清水寺')).toBe('none')
    expect(compareNames('茶寮', '茶寮都路里祇園本店')).toBe('none')
    expect(compareNames('カフェ', 'カフェ京都駅前店')).toBe('none')
  })

  it('疎通確認で別の施設に紐付いた事例（飲食店→別の飲食店、飲食店→医院）を一致としない', () => {
    expect(compareNames('おきな家', 'ひさご')).toBe('none')
    expect(compareNames('柴崎', '柴崎医院')).toBe('none')
  })

  it('空の名称は、どれとも一致しない', () => {
    expect(compareNames('', '清水寺')).toBe('none')
    expect(compareNames('清水寺', '')).toBe('none')
    expect(compareNames('（架空）', '（架空）')).toBe('none')
  })
})

describe('住所の行政区画', () => {
  it('都道府県と市区町村（郡を含む）を、先頭から順に読み取る。町名・丁目は含めない', () => {
    expect(administrativeUnits(KYOTO_ADDRESS)).toEqual(['京都府', '京都市', '東山区'])
    expect(administrativeUnits('日本、〒153-0043 東京都目黒区東山1丁目')).toEqual([
      '東京都',
      '目黒区',
    ])
    expect(administrativeUnits('日本、〒250-0521 神奈川県足柄下郡箱根町仙石原')).toEqual([
      '神奈川県',
      '足柄下郡',
      '箱根町',
    ])
    expect(administrativeUnits('北海道札幌市中央区北1条西2丁目')).toEqual([
      '北海道',
      '札幌市',
      '中央区',
    ])
  })

  it('町・村は、郡の下にあるものだけを行政区画とする（町名を、行政区画として読み取らない）', () => {
    expect(administrativeUnits('日本、〒101-0051 東京都千代田区神田神保町1丁目')).toEqual([
      '東京都',
      '千代田区',
    ])
    expect(administrativeUnits('東京都新宿区市谷田町1丁目')).toEqual(['東京都', '新宿区'])
    expect(administrativeUnits('東京都八王子市本町')).toEqual(['東京都', '八王子市'])
  })

  it('都道府県までしか読み取れない住所は、都道府県だけを返す', () => {
    expect(administrativeUnits('日本、〒960-8043 福島県')).toEqual(['福島県'])
    expect(administrativeUnits('日本、〒553-0003 大阪府大阪市福島区福島1丁目')).toEqual([
      '大阪府',
      '大阪市',
      '福島区',
    ])
    expect(administrativeUnits('福島県郡山市朝日2丁目')).toEqual(['福島県', '郡山市'])
  })

  it('日本の住所と読み取れないときは null（「Japan」の文字や地域の語が含まれていても）', () => {
    expect(administrativeUnits(undefined)).toBeNull()
    expect(administrativeUnits('')).toBeNull()
    expect(administrativeUnits('Japan Street, Kentucky, United States 京都市')).toBeNull()
    expect(administrativeUnits('1 Infinite Loop, Cupertino, CA')).toBeNull()
  })
})

describe('所在地と地域', () => {
  it('地域を語に分け、「周辺」などの語尾は外す', () => {
    expect(regionTokens('京都・東山')).toEqual(['京都', '東山'])
    expect(regionTokens('京都駅周辺')).toEqual(['京都駅'])
    // 語尾が重なっていても、すべて外す。
    expect(regionTokens('京都・東山エリア周辺')).toEqual(['京都', '東山'])
    expect(regionTokens('  ・ ')).toEqual([])
  })

  it('「市内」「都内」などの語尾も外し、ハイフン類・波線も区切りにする', () => {
    // 語尾（市内など）を外した語は、行政区画の名称（京都市・東京都）と、語尾の「市」「都」を除いた形で一致する。
    expect(regionTokens('京都市内')).toEqual(['京都'])
    expect(regionTokens('東京都内')).toEqual(['東京'])
    expect(regionTokens('大阪府内')).toEqual(['大阪'])
    expect(regionTokens('神奈川県内')).toEqual(['神奈川'])
    expect(regionTokens('東山区内')).toEqual(['東山'])
    expect(regionTokens('京都-奈良')).toEqual(['京都', '奈良'])
    expect(regionTokens('京都–奈良')).toEqual(['京都', '奈良'])
    expect(regionTokens('京都—奈良')).toEqual(['京都', '奈良'])
    expect(regionTokens('京都−奈良')).toEqual(['京都', '奈良'])
    expect(regionTokens('京都〜奈良')).toEqual(['京都', '奈良'])
    expect(regionTokens('京都~奈良')).toEqual(['京都', '奈良'])
    // 全角のハイフン・波線は、NFKCで半角になる。
    expect(regionTokens('京都－奈良')).toEqual(['京都', '奈良'])
    expect(regionTokens('京都～奈良')).toEqual(['京都', '奈良'])
    expect(regionTokens('京都・東山エリア周辺')).toEqual(['京都', '東山'])
  })

  it('語尾を広げても、行政区画でない駅名・温泉地は、従来どおり一致しない（意図した制限）', () => {
    const hakone = '日本、〒250-0521 神奈川県足柄下郡箱根町仙石原'

    expect(addressMatchesRegion(hakone, '箱根温泉')).toBe(false)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都駅周辺')).toBe(false)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都駅')).toBe(false)
  })

  it('地域のすべての要素が、同じ住所の行政区画の階層で確認できれば、一致', () => {
    expect(addressMatchesRegion(KYOTO_ADDRESS, REGION)).toBe(true)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '東山・京都')).toBe(true)
    // 「京都市東山」のように、続けて書いた地域も、京都市→東山区の階層として読み取る。
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都市東山エリア')).toBe(true)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都市・東山（架空デモ）')).toBe(true)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都')).toBe(true)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都・東山エリア周辺')).toBe(true)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都市内')).toBe(true)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都-奈良')).toBe(false) // 奈良の施設ではない
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都-東山')).toBe(true)
    expect(addressMatchesRegion('日本、〒100-0001 東京都千代田区千代田', '東京都内')).toBe(true)
  })

  it('地域の要素の一部しか確認できない住所は、一致としない（下京区の施設を「京都・東山」としない）', () => {
    const shimogyo = '日本、〒600-8216 京都府京都市下京区東塩小路町'

    expect(addressMatchesRegion(shimogyo, REGION)).toBe(false)
    expect(addressMatchesRegion(shimogyo, '京都')).toBe(true)
  })

  it('複合地域「福島・郡山」：大阪市福島区や、福島県までしか分からない住所は、一致としない', () => {
    const osakaFukushima = '日本、〒553-0003 大阪府大阪市福島区福島1丁目'
    const prefectureOnly = '日本、〒960-8043 福島県'
    const koriyama = '日本、〒963-8002 福島県郡山市駅前2丁目'

    expect(addressMatchesRegion(osakaFukushima, '福島・郡山')).toBe(false)
    expect(addressMatchesRegion(prefectureOnly, '福島・郡山')).toBe(false)
    expect(addressMatchesRegion(koriyama, '福島・郡山')).toBe(true)
    // 1つの要素の地域なら、その要素が確認できればよい。
    expect(addressMatchesRegion(osakaFukushima, '福島')).toBe(true)
  })

  it('同じ行政区画を、2つの要素に使い回さない', () => {
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都・京都府')).toBe(true) // 京都府と京都市
    // 1つの行政区画（福島県）を、2つの要素（福島・福島）に使い回して、一致にしない。
    expect(addressMatchesRegion('日本、〒960-8043 福島県', '福島・福島')).toBe(false)
  })

  it('町名は、行政区画として読み取らない（「神保町」は、千代田区の町名）', () => {
    const jimbocho = '日本、〒101-0051 東京都千代田区神田神保町1丁目'

    expect(addressMatchesRegion(jimbocho, '神保町')).toBe(false)
    expect(addressMatchesRegion(jimbocho, '神田神保町')).toBe(false)
    expect(addressMatchesRegion(jimbocho, '東京・千代田')).toBe(true)
  })

  it('住所が無い・日本の住所と読み取れない・地域の語が無い・地域が空なら、裏付けなし', () => {
    expect(addressMatchesRegion('Kyoto, 京都市 Street, Japan', REGION)).toBe(false)
    expect(addressMatchesRegion(undefined, REGION)).toBe(false)
    expect(addressMatchesRegion(OSAKA_ADDRESS, REGION)).toBe(false)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '')).toBe(false)
  })

  it('「京都」は、「東京都」の一部としては数えない（行政区画の名称で照合する）', () => {
    expect(addressMatchesRegion('日本、〒100-0001 東京都千代田区千代田', '京都')).toBe(false)
  })

  it('別の都道府県の同名の地名（東京都目黒区東山）を、「京都・東山」としない', () => {
    const meguro = '日本、〒153-0043 東京都目黒区東山1丁目'

    expect(addressMatchesRegion(meguro, '京都・東山')).toBe(false)
    expect(addressMatchesRegion(meguro, '東京・目黒')).toBe(true)
  })

  it('行政区画として確認できない地域の語（駅名・町名など）は、裏付けにならない', () => {
    expect(addressMatchesRegion(KYOTO_ADDRESS, '京都駅周辺')).toBe(false)
    expect(addressMatchesRegion(KYOTO_ADDRESS, '清水')).toBe(false)
  })

  it('郡・町を含む地域（箱根）も、行政区画の名称と一致すれば、一致とする', () => {
    const hakone = '日本、〒250-0521 神奈川県足柄下郡箱根町仙石原'

    expect(addressMatchesRegion(hakone, '箱根')).toBe(true)
    expect(addressMatchesRegion(hakone, '神奈川・箱根')).toBe(true)
  })
})

describe('施設の選択（名称・所在地のゲート）', () => {
  it('名称が一致し、所在地が地域と矛盾しない1件を選ぶ', () => {
    const result = selectPlace('清水寺', REGION, [place('a', '八坂神社'), place('b', '清水寺')])

    expect(result).toMatchObject({ status: 'matched', place: { placeId: 'b' } })
  })

  it('候補があっても、どれも一致しなければ mismatch（採用しない）', () => {
    const result = selectPlace('おきな家', REGION, [place('a', 'ひさご'), place('b', '柴崎医院')])

    expect(result).toEqual({ status: 'mismatch' })
  })

  it('候補が無ければ no_candidates', () => {
    expect(selectPlace('清水寺', REGION, [])).toEqual({ status: 'no_candidates' })
  })

  it('名称が一致しても、所在地が地域と一致しなければ region_mismatch（別の地域の同名施設を採用しない）', () => {
    const result = selectPlace('麺処いちょう庵', REGION, [
      place('a', '麺処いちょう庵', OSAKA_ADDRESS),
    ])

    expect(result).toEqual({ status: 'region_mismatch' })
  })

  it('住所が無い候補は、地域の裏付けがないため採用しない', () => {
    const result = selectPlace('清水寺', REGION, [place('a', '清水寺', null)])

    expect(result).toEqual({ status: 'region_mismatch' })
  })

  it('地域が合う同名の施設と、合わない同名の施設があれば、合うほうだけを選ぶ', () => {
    const result = selectPlace('麺処いちょう庵', REGION, [
      place('osaka', '麺処いちょう庵', OSAKA_ADDRESS),
      place('kyoto', '麺処いちょう庵'),
    ])

    expect(result).toMatchObject({ status: 'matched', place: { placeId: 'kyoto' } })
  })

  it('複合地域「福島・郡山」：大阪市福島区の同名施設と、福島県までしか分からない候補は、採用しない', () => {
    const osakaFukushima = '日本、〒553-0003 大阪府大阪市福島区福島1丁目'
    const prefectureOnly = '日本、〒960-8043 福島県'
    const koriyama = '日本、〒963-8002 福島県郡山市駅前2丁目'

    expect(selectPlace('資料館', '福島・郡山', [place('osaka', '資料館', osakaFukushima)])).toEqual(
      { status: 'region_mismatch' },
    )
    expect(selectPlace('資料館', '福島・郡山', [place('pref', '資料館', prefectureOnly)])).toEqual({
      status: 'region_mismatch',
    })
    expect(
      selectPlace('資料館', '福島・郡山', [
        place('osaka', '資料館', osakaFukushima),
        place('pref', '資料館', prefectureOnly),
        place('koriyama', '資料館', koriyama),
      ]),
    ).toMatchObject({ status: 'matched', place: { placeId: 'koriyama' } })
  })

  it('支店名が異なる候補しかなければ、採用しない（誤ったPlace IDを根拠に伝えない）', () => {
    const result = selectPlace('麺処いちょう庵（四条店）', REGION, [
      place('a', '麺処いちょう庵（河原町店）'),
    ])

    expect(result).toEqual({ status: 'mismatch' })
  })

  it('同名の施設が複数ある（異なるPlace ID）場合は ambiguous で、1つに絞らない', () => {
    const result = selectPlace('茶寮都路里', REGION, [
      place('a', '茶寮都路里'),
      place('b', '茶寮都路里'),
    ])

    expect(result).toEqual({ status: 'ambiguous', count: 2 })
  })

  it('同じPlace IDの重複は、1件として数える', () => {
    const result = selectPlace('茶寮都路里', REGION, [
      place('a', '茶寮都路里'),
      place('a', '茶寮都路里'),
    ])

    expect(result.status).toBe('matched')
  })

  it('名称が空の候補は、選ばれない', () => {
    expect(selectPlace('清水寺', REGION, [place('a', '')])).toEqual({ status: 'mismatch' })
  })
})

describe('曜日', () => {
  it('日付から曜日を求める（0=日曜）', () => {
    expect(weekdayIndex('2026-11-08')).toBe(0)
    expect(weekdayIndex('2026-11-14')).toBe(6)
    expect(weekdayName('2026-11-14')).toBe('土曜日')
    expect(weekdayName('2028-02-29')).toBe('火曜日')
  })

  it('西暦1〜99年も、そのままの年として扱う（1900年代に読み替えない）', () => {
    expect(weekdayIndex('0001-01-01')).toBe(1)
    expect(weekdayIndex('0099-12-31')).toBe(new Date('0099-12-31T00:00:00Z').getUTCDay())
  })
})

const open = (day: number, hour: number, minute = 0) => ({ day, hour, minute })
const period = (o: ReturnType<typeof open>, c?: ReturnType<typeof open>): OpeningPeriod => ({
  open: o,
  close: c,
})
// 2026-11-14（土曜）を対象にする。土曜=6。
const SAT = '2026-11-14'

describe('営業時間の照合（通常営業時間）', () => {
  const saturday = [period(open(6, 9), open(6, 17))]

  it('営業時間内なら consistent（ちょうど閉店時刻までも含む）', () => {
    expect(checkOpeningHours(saturday, SAT, '10:00', 60).status).toBe('consistent')
    expect(checkOpeningHours(saturday, SAT, '09:00', 480).status).toBe('consistent')
    expect(checkOpeningHours(saturday, SAT, '16:00', 60).status).toBe('consistent')
  })

  it('開店前・閉店後にかかるなら conflicting', () => {
    expect(checkOpeningHours(saturday, SAT, '08:30', 60).status).toBe('conflicting')
    expect(checkOpeningHours(saturday, SAT, '16:30', 60).status).toBe('conflicting')
    expect(checkOpeningHours(saturday, SAT, '17:00', 30).status).toBe('conflicting')
  })

  it('その曜日に営業の記載が無ければ conflicting（定休日の可能性）', () => {
    const result = checkOpeningHours([period(open(1, 9), open(1, 17))], SAT, '10:00', 60)

    expect(result.status).toBe('conflicting')
    expect(result.explanation).toContain('定休日の可能性')
  })

  it('昼休みなど、同じ日に複数の営業時間があるときは、どれか1つに収まればよい', () => {
    const split = [period(open(6, 9), open(6, 12)), period(open(6, 13), open(6, 17))]

    expect(checkOpeningHours(split, SAT, '13:30', 60).status).toBe('consistent')
    expect(checkOpeningHours(split, SAT, '11:30', 60).status).toBe('conflicting') // 昼休みにかかる
  })

  it('日付をまたぐ営業（土曜18:00〜日曜2:00）を扱える', () => {
    const late = [period(open(6, 18), open(0, 2))]

    expect(checkOpeningHours(late, SAT, '20:00', 120).status).toBe('consistent')
    expect(checkOpeningHours(late, '2026-11-08', '01:00', 60).status).toBe('consistent') // 日曜の早朝
    expect(checkOpeningHours(late, '2026-11-08', '01:30', 60).status).toBe('conflicting')
  })

  it('24時間営業（日曜0:00開店・閉店なし）は、どの時間帯も consistent', () => {
    expect(checkOpeningHours([period(open(0, 0))], SAT, '03:00', 60).status).toBe('consistent')
  })

  it('営業の区間を解釈できない（閉店が無く24時間でもない）場合は unverifiable', () => {
    expect(checkOpeningHours([period(open(6, 9))], SAT, '10:00', 60).status).toBe('unverifiable')
    expect(checkOpeningHours([], SAT, '10:00', 60).status).toBe('unverifiable')
  })

  it('開店と閉店が同じ曜日・時刻の区間は、丸1週間の営業とせず、不完全なデータとして扱う', () => {
    const sameTime = [period(open(6, 9), open(6, 9))]

    // 別の曜日（月曜）・同じ曜日（土曜）のどちらでも、営業中と断定しない。
    expect(checkOpeningHours(sameTime, '2026-11-09', '10:00', 60).status).toBe('unverifiable')
    expect(checkOpeningHours(sameTime, SAT, '09:30', 60).status).toBe('unverifiable')

    // 他に確認できた区間があれば、そこに収まる場合だけ「整合」。同時刻の区間は、営業時間外の根拠にしない。
    const mixed = [period(open(6, 9), open(6, 12)), period(open(1, 9), open(1, 9))]
    expect(checkOpeningHours(mixed, SAT, '10:00', 60).status).toBe('consistent')
    expect(checkOpeningHours(mixed, '2026-11-09', '10:00', 60).status).toBe('unverifiable')
  })

  it('週をまたぐ営業として扱うのは、閉店が開店より小さい（日曜0:00をまたぐ）場合だけ', () => {
    const wrap = [period(open(6, 22), open(0, 2))]

    expect(checkOpeningHours(wrap, '2026-11-08', '01:00', 60).status).toBe('consistent')
    expect(checkOpeningHours(wrap, '2026-11-10', '01:00', 60).status).toBe('conflicting')
  })

  it('24時間営業の正規の表現は、ちょうど1件だけ。他の区間と並ぶ「閉店なし」は24時間営業としない', () => {
    const mixed = [period(open(0, 0)), period(open(6, 9), open(6, 12))]

    expect(checkOpeningHours(mixed, SAT, '20:00', 60).status).toBe('unverifiable')
    // 日曜0:00以外の「閉店なし」も、24時間営業ではない。
    expect(checkOpeningHours([period(open(6, 0))], SAT, '03:00', 60).status).toBe('unverifiable')
  })

  it('解釈できない区間があるとき、確認できた区間の範囲外だけで「営業時間外」と断定しない', () => {
    const partial = [period(open(6, 9), open(6, 12)), period(open(6, 13))]

    expect(checkOpeningHours(partial, SAT, '15:00', 60).status).toBe('unverifiable')
    // 確認できた区間に収まるなら、その区間は信頼できるため consistent。
    expect(checkOpeningHours(partial, SAT, '10:00', 60).status).toBe('consistent')
  })

  it('説明に、臨時休業は確認できないことを明記する（consistentのとき）', () => {
    expect(checkOpeningHours(saturday, SAT, '10:00', 60).explanation).toContain('臨時休業')
  })

  it('説明に、営業時間そのもの（Places由来の値）を載せない', () => {
    const result = checkOpeningHours(saturday, SAT, '10:00', 60)

    expect(result.explanation).not.toContain('09:00')
    expect(result.explanation).not.toContain('17:00')
  })
})

describe('営業時間：空配列（欠落とは別）', () => {
  it('空配列は、営業とも休みとも決めつけず、空であることを理由に「確認できない」とする', () => {
    const result = checkOpeningHours([], SAT, '10:00', 60)

    expect(result.status).toBe('unverifiable')
    expect(result.explanation).toContain('空')
    expect(result.explanation).not.toContain('定休日')
  })
})

describe('移動の余裕', () => {
  it('前の予定の終了から次の予定の開始までの時間を求める', () => {
    expect(
      availableMinutes({
        previous: { plannedStartTime: '12:00', durationMinutes: 60 },
        next: { plannedStartTime: '14:00' },
      }),
    ).toBe(60)
    expect(
      availableMinutes({
        previous: { plannedStartTime: '12:00', durationMinutes: 150 },
        next: { plannedStartTime: '14:00' },
      }),
    ).toBe(-30)
  })

  it('予定の時刻が、順序どおりで重なっていないかを判定する', () => {
    const stop = (plannedStartTime: string, durationMinutes: number) => ({
      plannedStartTime,
      durationMinutes,
    })

    expect(hasTimeConflict([stop('10:00', 60), stop('11:00', 30), stop('14:00', 60)])).toBe(false)
    expect(hasTimeConflict([stop('10:00', 90), stop('11:00', 30)])).toBe(true)
    expect(hasTimeConflict([stop('12:00', 30), stop('10:00', 30)])).toBe(true)
  })

  it('余裕が0以上なら間に合う（ちょうども可）。負なら間に合わない', () => {
    expect(evaluateTravel(60, 45)).toEqual({ status: 'fits', slackMinutes: 15 })
    expect(evaluateTravel(60, 60)).toEqual({ status: 'fits', slackMinutes: 0 })
    expect(evaluateTravel(60, 61)).toEqual({ status: 'too_long', slackMinutes: -1 })
  })
})

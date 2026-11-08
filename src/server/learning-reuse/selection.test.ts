import { describe, expect, it, vi } from 'vitest'

import type { ApprovedLearning } from '@/domain'
import { sampleApprovedLearning, sampleLearning } from '@/domain/samples'
import { approveLearning, MAX_LEARNING_CONTENT_LENGTH } from '@/lib/learnings/lifecycle'
import { InMemoryLearningStore } from '@/server/learnings/store'
import type { VersionedLearning } from '@/server/persistence/contracts'

import {
  LearningSelectionError,
  resolveSelectedLearnings,
  type VersionedLearningSource,
} from './selection'

const date = '2026-11-08T20:00:00+09:00'
const region = '京都市・東山'
const scoped = approveLearning({ ...sampleLearning, scope: { kind: 'region', region } }, date)
const anotherRegion = approveLearning(
  { ...sampleLearning, id: 'learning-nara', scope: { kind: 'region', region: '奈良市' } },
  date,
)

// 保存直後の版。新規保存は版1になる。
const pick = (id: string, version = 1) => ({ id, version })

async function setup() {
  const store = new InMemoryLearningStore()
  await store.saveApproved('user-a', sampleApprovedLearning)
  await store.saveApproved('user-a', scoped)
  await store.saveApproved('user-a', anotherRegion)
  await store.saveApproved('user-b', {
    ...sampleApprovedLearning,
    id: 'other-user-only',
  })
  return store
}

async function errorOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  return error instanceof LearningSelectionError ? error : undefined
}

async function codeOf(promise: Promise<unknown>) {
  return (await errorOf(promise))?.code
}

// 保存先が返す一覧を固定した代役。実装が版つきで返せないケースの検証に使う。
const storeReturning = (records: unknown): VersionedLearningSource => ({
  listVersionedApproved: async () => records as VersionedLearning[],
})

describe('次回旅程に使う学びのサーバー側解決', () => {
  it('UIDと地域に一致する承認済み学びを、利用者の選択順で返す', async () => {
    const store = await setup()
    const actual = await resolveSelectedLearnings(store, 'user-a', region, [
      pick(scoped.id),
      pick(sampleApprovedLearning.id),
    ])
    expect(actual).toEqual([scoped, sampleApprovedLearning])
  })

  it('前後に空白がある地域入力も、同じ表記の地域として扱う', async () => {
    const store = await setup()
    const actual = await resolveSelectedLearnings(store, 'user-a', `  ${region}　`, [
      pick(scoped.id),
    ])
    expect(actual.map((item) => item.id)).toEqual([scoped.id])
  })

  describe('画面で見た内容と違う学びを黙って使わない', () => {
    it('同じIDの内容が再承認で差し替わる（版+1）と、古い選択を拒否し、新しい版の選択は採用する', async () => {
      const store = await setup()
      // 利用者は learning-rest の版1（昼食後に休憩…）を画面で見て選んだ。
      const selected = pick(sampleApprovedLearning.id, 1)
      // その後、同じIDで別の文に再承認された。Firestoreと同じく版が加算される。
      await store.saveApproved(
        'user-a',
        { ...sampleApprovedLearning, content: '休憩は取らずに回りたい' },
        1,
      )

      const stale = await errorOf(resolveSelectedLearnings(store, 'user-a', region, [selected]))
      expect(stale?.code).toBe('selection_changed')
      // 新しい内容を、エラーなしで返さない。
      const fresh = await resolveSelectedLearnings(store, 'user-a', region, [
        pick(sampleApprovedLearning.id, 2),
      ])
      expect(fresh[0].content).toBe('休憩は取らずに回りたい')
    })

    it('撤回後に同じIDで保存し直しても、過去に見た版を再利用せず古い選択を拒否する', async () => {
      const store = await setup()
      await store.remove('user-a', scoped.id)
      await store.saveApproved('user-a', { ...scoped, content: '全く別の内容にした' })

      expect(
        await codeOf(resolveSelectedLearnings(store, 'user-a', region, [pick(scoped.id)])),
      ).toBe('selection_changed')
    })

    it('他人の学び・別地域・撤回・存在しない選択IDを拒否する', async () => {
      const store = await setup()
      expect(
        await codeOf(resolveSelectedLearnings(store, 'user-a', region, [pick('other-user-only')])),
      ).toBe('selection_changed')
      expect(
        await codeOf(resolveSelectedLearnings(store, 'user-a', region, [pick(anotherRegion.id)])),
      ).toBe('selection_changed')
      expect(
        await codeOf(resolveSelectedLearnings(store, 'user-a', region, [pick('missing')])),
      ).toBe('selection_changed')
      await store.remove('user-a', scoped.id)
      expect(
        await codeOf(resolveSelectedLearnings(store, 'user-a', region, [pick(scoped.id)])),
      ).toBe('selection_changed')
    })

    it('生成先の地域が変わった（選択時と別の地域）場合、地域限定の学びを拒否する', async () => {
      const store = await setup()
      expect(
        await codeOf(resolveSelectedLearnings(store, 'user-a', '奈良市', [pick(scoped.id)])),
      ).toBe('selection_changed')
      // 表記が違う地域は同じ地域として扱わない（完全一致）。
      expect(
        await codeOf(resolveSelectedLearnings(store, 'user-a', '京都市', [pick(scoped.id)])),
      ).toBe('selection_changed')
    })

    it('別のユーザーの選択としては、同じIDと版でも採用しない', async () => {
      const store = await setup()
      expect(
        await codeOf(
          resolveSelectedLearnings(store, 'user-b', region, [pick(sampleApprovedLearning.id)]),
        ),
      ).toBe('selection_changed')
    })
  })

  describe('不正な入力は保存先を読まずに拒否する', () => {
    it('重複ID・不正な所有者・空の地域・版のない選択を拒否する', async () => {
      const store = await setup()
      const spy = vi.spyOn(store, 'listVersionedApproved')
      const resolve = (owner: string, area: string, selections: unknown[]) =>
        codeOf(
          resolveSelectedLearnings(
            store,
            owner,
            area,
            selections as { id: string; version: number }[],
          ),
        )

      expect(await resolve('user-a', region, [pick('x'), pick('x')])).toBe('invalid_selection')
      // 版が違っても、同じIDの重複は曖昧なので拒否する。
      expect(await resolve('user-a', region, [pick('x', 1), pick('x', 2)])).toBe(
        'invalid_selection',
      )
      expect(await resolve('', region, [])).toBe('invalid_selection')
      expect(await resolve('user-a', '  ', [])).toBe('invalid_selection')
      expect(await resolve('user-a', '　', [pick('x')])).toBe('invalid_selection')
      // 旧形式のID文字列だけ、版が0・小数・欠落の選択は受け付けない。
      for (const bad of [{ id: 'x' }, { id: 'x', version: 0 }, { id: 'x', version: 1.5 }, 'x']) {
        expect(await resolve('user-a', region, [bad])).toBe('invalid_selection')
      }
      expect(spy).not.toHaveBeenCalled()
    })

    it('選択数が保存できる上限を超える場合は拒否する', async () => {
      const store = await setup()
      const many = Array.from({ length: 41 }, (_, index) => pick(`learning-${index}`))
      expect(await codeOf(resolveSelectedLearnings(store, 'user-a', region, many))).toBe(
        'invalid_selection',
      )
    })

    it('空選択は何も適用せず、保存先を読まない', async () => {
      const listVersionedApproved = vi.fn(async (): Promise<VersionedLearning[]> => {
        throw new Error('呼ばれてはいけない')
      })
      expect(
        await resolveSelectedLearnings({ listVersionedApproved }, 'user-a', region, []),
      ).toEqual([])
      expect(listVersionedApproved).not.toHaveBeenCalled()
    })
  })

  describe('保存先を安全に使えないときは、内部情報を出さず unavailable にする', () => {
    it('一覧の取得が失敗（破損文書による invalid_stored_data 等）しても、内部情報を含めず変換する', async () => {
      const secret = 'users/uid-secret/learnings/doc: PERMISSION_DENIED internal detail'
      const store: VersionedLearningSource = {
        listVersionedApproved: vi.fn(async () => {
          throw new Error(secret)
        }),
      }
      const error = await errorOf(resolveSelectedLearnings(store, 'user-a', region, [pick('x')]))
      expect(error?.code).toBe('unavailable')
      expect(error?.status).toBe(503)
      expect(error?.message).not.toContain('uid-secret')
      expect(error?.message).not.toContain('PERMISSION_DENIED')
      expect(error?.cause).toBeUndefined()
    })

    it('版を返さない実装や、未承認・形式不正の要素が混ざる一覧は採用しない（fail-closed）', async () => {
      const unapproved = { ...sampleApprovedLearning, approval: { status: 'pending' } }
      const cases: unknown[] = [
        // 版のない旧形式（learning だけ）。
        [sampleApprovedLearning],
        // 版が0。
        [{ version: 0, learning: sampleApprovedLearning }],
        // 未承認が混入している。
        [{ version: 1, learning: unapproved }],
        // 余分なキー。
        [{ version: 1, learning: sampleApprovedLearning, extra: true }],
        // 配列ではない。
        { version: 1, learning: sampleApprovedLearning },
      ]
      for (const records of cases) {
        expect(
          await codeOf(
            resolveSelectedLearnings(storeReturning(records), 'user-a', region, [
              pick(sampleApprovedLearning.id),
            ]),
          ),
        ).toBe('unavailable')
      }
    })

    it('同じIDが複数ある一覧は、どれが現行か判断できないため採用しない', async () => {
      const records = [
        { version: 1, learning: sampleApprovedLearning },
        { version: 2, learning: { ...sampleApprovedLearning, content: '別の文' } },
      ]
      expect(
        await codeOf(
          resolveSelectedLearnings(storeReturning(records), 'user-a', region, [
            pick(sampleApprovedLearning.id, 2),
          ]),
        ),
      ).toBe('unavailable')
    })
  })

  describe(`本文は${MAX_LEARNING_CONTENT_LENGTH}文字以内だけを出力する`, () => {
    const withContent = (content: string): ApprovedLearning => ({
      ...sampleApprovedLearning,
      content,
    })

    it('上限ちょうどは返し、超える本文は生成に渡さない', async () => {
      const exact = withContent('あ'.repeat(MAX_LEARNING_CONTENT_LENGTH))
      const over = withContent('あ'.repeat(MAX_LEARNING_CONTENT_LENGTH + 1))
      expect(
        await resolveSelectedLearnings(
          storeReturning([{ version: 1, learning: exact }]),
          'user-a',
          region,
          [pick(exact.id)],
        ),
      ).toEqual([exact])
      expect(
        await codeOf(
          resolveSelectedLearnings(
            storeReturning([{ version: 1, learning: over }]),
            'user-a',
            region,
            [pick(over.id)],
          ),
        ),
      ).toBe('unavailable')
    })

    it('選んでいない学びの本文が長くても、選んだ学びの解決には影響しない', async () => {
      const over: ApprovedLearning = {
        ...withContent('い'.repeat(MAX_LEARNING_CONTENT_LENGTH + 1)),
        id: 'long-unselected',
      }
      const records = [
        { version: 1, learning: sampleApprovedLearning },
        { version: 1, learning: over },
      ]
      expect(
        await resolveSelectedLearnings(storeReturning(records), 'user-a', region, [
          pick(sampleApprovedLearning.id),
        ]),
      ).toEqual([sampleApprovedLearning])
    })
  })

  it('エラーコードとHTTP状態の対応（統合側が応答に変換する）', () => {
    expect(new LearningSelectionError('invalid_selection').status).toBe(400)
    expect(new LearningSelectionError('selection_changed').status).toBe(409)
    expect(new LearningSelectionError('unavailable').status).toBe(503)
  })
})

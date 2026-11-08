import { describe, expect, it } from 'vitest'

import type { ApprovedLearning } from '../../domain'
import { sampleApprovedLearning, sampleLearning } from '../../domain/samples'
import { approveLearning, rejectLearning } from '../../lib/learnings/lifecycle'
import { getApplicableLearnings, InMemoryLearningStore, LearningStoreError } from './store'

const DECIDED_AT = '2026-11-08T20:00:00+09:00'
const region = sampleLearning.scope.kind === 'region' ? sampleLearning.scope.region : ''

// 型では弾かれる不正な値を、実行時の防御の検証のために渡す。
const asApproved = (value: unknown): ApprovedLearning => value as ApprovedLearning

const codeOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  )
  return error instanceof LearningStoreError ? error.code : undefined
}

describe('InMemoryLearningStore', () => {
  it('承認済みの学びを保存し、内容と適用範囲を取得できる', async () => {
    const store = new InMemoryLearningStore()
    await store.saveApproved('user-a', sampleApprovedLearning)

    expect(await store.listApproved('user-a')).toEqual([sampleApprovedLearning])
  })

  it('承認済みだけを保存できる。未承認・却下済みは拒否する', async () => {
    const store = new InMemoryLearningStore()

    expect(await codeOf(store.saveApproved('user-a', asApproved(sampleLearning)))).toBe(
      'not_approved',
    )
    expect(
      await codeOf(
        store.saveApproved('user-a', asApproved(rejectLearning(sampleLearning, DECIDED_AT))),
      ),
    ).toBe('not_approved')
    expect(await store.listApproved('user-a')).toEqual([])
  })

  it('承認の申告だけが付いた不正な学び（承認日時なし）は、保存できない', async () => {
    const store = new InMemoryLearningStore()
    const forged = asApproved({ ...sampleLearning, approval: { status: 'approved' } })

    expect(await codeOf(store.saveApproved('user-a', forged))).toBe('not_approved')
  })

  it('利用者ごとに分離され、他の利用者の学びは見えない・消せない', async () => {
    const store = new InMemoryLearningStore()
    await store.saveApproved('user-a', sampleApprovedLearning)

    expect(await store.listApproved('user-b')).toEqual([])
    expect(await store.remove('user-b', sampleApprovedLearning.id)).toBe(false)
    expect(await store.listApproved('user-a')).toHaveLength(1)
  })

  it('同じIDは上書きされ、削除（撤回）できる', async () => {
    const store = new InMemoryLearningStore()
    await store.saveApproved('user-a', sampleApprovedLearning)
    await store.saveApproved('user-a', { ...sampleApprovedLearning, content: '更新した内容' })

    expect((await store.listApproved('user-a'))[0].content).toBe('更新した内容')
    expect(await store.remove('user-a', sampleApprovedLearning.id)).toBe(true)
    expect(await store.listApproved('user-a')).toEqual([])
    expect(await store.remove('user-a', sampleApprovedLearning.id)).toBe(false)
  })

  it('版つきで取得でき、保存のたびに加算される。撤回後に保存し直しても過去の版を再利用しない', async () => {
    const store = new InMemoryLearningStore()
    await store.saveApproved('user-a', sampleApprovedLearning)
    expect(await store.listVersionedApproved('user-a')).toEqual([
      { version: 1, learning: sampleApprovedLearning },
    ])

    await store.saveApproved('user-a', { ...sampleApprovedLearning, content: '更新した内容' }, 1)
    expect((await store.listVersionedApproved('user-a'))[0].version).toBe(2)

    expect(await store.remove('user-a', sampleApprovedLearning.id)).toBe(true)
    expect(await store.listVersionedApproved('user-a')).toEqual([])
    // 撤回済みを再度削除しても、撤回済みのまま。期待版つきの再保存は拒否する。
    expect(await store.remove('user-a', sampleApprovedLearning.id)).toBe(false)
    expect(await codeOf(store.saveApproved('user-a', sampleApprovedLearning, 2))).toBe(
      'version_conflict',
    )

    await store.saveApproved('user-a', { ...sampleApprovedLearning, content: '別の内容' })
    expect(await store.listVersionedApproved('user-a')).toMatchObject([
      { version: 3, learning: { content: '別の内容' } },
    ])
  })

  it('版つきの一覧も、利用者ごとに分離され、空のUIDを拒否する', async () => {
    const store = new InMemoryLearningStore()
    await store.saveApproved('user-a', sampleApprovedLearning)

    expect(await store.listVersionedApproved('user-b')).toEqual([])
    expect(await codeOf(store.listVersionedApproved(''))).toBe('invalid_owner')
  })

  it('取得した値を書き換えても、保存済みの内容は変わらない', async () => {
    const store = new InMemoryLearningStore()
    await store.saveApproved('user-a', sampleApprovedLearning)
    const [first] = await store.listApproved('user-a')
    first.content = '外から書き換え'

    expect((await store.listApproved('user-a'))[0].content).toBe(sampleApprovedLearning.content)
  })

  it('利用者を特定できない（空のUID）場合は拒否する', async () => {
    const store = new InMemoryLearningStore()

    expect(await codeOf(store.saveApproved('  ', sampleApprovedLearning))).toBe('invalid_owner')
    expect(await codeOf(store.listApproved(''))).toBe('invalid_owner')
  })
})

describe('getApplicableLearnings（次回の旅程生成に渡す学び）', () => {
  it('承認済みで、地域が合うものだけを返す', async () => {
    const store = new InMemoryLearningStore()
    await store.saveApproved('user-a', sampleApprovedLearning)
    await store.saveApproved(
      'user-a',
      approveLearning({ ...sampleLearning, id: 'learning-here' }, DECIDED_AT),
    )
    await store.saveApproved(
      'user-a',
      approveLearning(
        { ...sampleLearning, id: 'learning-nara', scope: { kind: 'region', region: '奈良市' } },
        DECIDED_AT,
      ),
    )

    const result = await getApplicableLearnings(store, 'user-a', region)
    expect(result.map((item) => item.id).sort()).toEqual(
      ['learning-here', sampleApprovedLearning.id].sort(),
    )
  })

  it('他の利用者の学びは、含まれない', async () => {
    const store = new InMemoryLearningStore()
    await store.saveApproved('user-a', sampleApprovedLearning)

    expect(await getApplicableLearnings(store, 'user-b', region)).toEqual([])
  })

  it('未承認の学びは、そもそも保存されないため、適用されない', async () => {
    const store = new InMemoryLearningStore()
    await codeOf(store.saveApproved('user-a', asApproved(sampleLearning)))

    expect(await getApplicableLearnings(store, 'user-a', region)).toEqual([])
  })
})

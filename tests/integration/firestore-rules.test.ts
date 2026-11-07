import { readFile } from 'node:fs/promises'
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore'
import { afterAll, beforeAll, describe, it } from 'vitest'

let environment: RulesTestEnvironment
const paths = [
  'users/user-a/trips/trip-a',
  'users/user-a/trips/trip-a/revisions/revision-a',
  'users/user-a/learnings/learning-a',
  'users/user-a/persistenceLimits/trips',
  'users/user-a/trips/trip-a/persistenceLimits/revisions',
]

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId: 'demo-groundtrip',
    firestore: {
      host: '127.0.0.1',
      port: 8080,
      rules: await readFile('firestore.rules', 'utf8'),
    },
  })
  await environment.clearFirestore()
  await environment.withSecurityRulesDisabled(async (context) => {
    await Promise.all(
      paths.map((path) => setDoc(doc(context.firestore(), path), { ownerUid: 'user-a' })),
    )
  })
})

afterAll(async () => {
  await environment?.cleanup()
})

describe.each(['user-a', 'user-b', null])('全拒否Rules：利用者=%s', (uid) => {
  it.each(paths)('%sの直接参照・一覧・作成・変更・削除を拒否する', async (path) => {
    const context = uid
      ? environment.authenticatedContext(uid)
      : environment.unauthenticatedContext()
    const db = context.firestore()
    const reference = doc(db, path)
    await assertFails(getDoc(reference))
    await assertFails(getDocs(collection(db, reference.parent.path)))
    await assertFails(setDoc(doc(db, `${path}-new`), { ownerUid: uid }))
    await assertFails(updateDoc(reference, { ownerUid: uid }))
    await assertFails(deleteDoc(reference))
  })

  it('未定義のコレクションへの直接アクセスも拒否する', async () => {
    const context = uid
      ? environment.authenticatedContext(uid)
      : environment.unauthenticatedContext()
    await assertFails(getDoc(doc(context.firestore(), 'unexpected/record')))
    await assertFails(setDoc(doc(context.firestore(), 'unexpected/record'), { value: true }))
  })
})

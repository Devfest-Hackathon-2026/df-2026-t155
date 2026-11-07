import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { ApprovedLearning } from '@/domain'

import type { LearningStore, SaveResult } from './store'

// 承認済みの学びの「保存」の状態。承認（本人の判断）とは別の状態として扱う。
// - 承認しただけでは、保存済みにならない。保存は、利用者が押す明示的な操作で行う。
// - 保存済みかどうかは、保存に成功した時点の承認済みの内容と、いまの内容を比べて決める。
//   保存のあとに承認済みの内容が変われば、自動的に「未保存の変更あり」に戻る。

export type SaveStatus =
  | { kind: 'saving' }
  | { kind: 'saved'; count: number }
  | { kind: 'unsaved'; count: number }
  // 承認済みが0件で、保存した内容もない。
  | { kind: 'empty' }
  | { kind: 'failed'; message: string; count: number }

type SavePhase =
  { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; key: string; message: string }

const DEFAULT_FAILURE = '時間をおいて、もう一度お試しください。'
const EMPTY_NOTICE =
  '保存できる承認済みの学びがありません。学びの候補を承認してから、保存してください。'

interface Options {
  store: LearningStore | undefined
  approved: ApprovedLearning[]
  // 承認済みの内容を表す文字列（内容が同じなら同じ値）。
  approvedKey: string
  // 旅程と地域の組。変わったら、保存の状態を消し、進行中の保存を中止する。
  scopeKey: string
  // 常設のライブリージョンへ通知する。
  announce: (text: string) => void
}

export function useApprovedSave({ store, approved, approvedKey, scopeKey, announce }: Options) {
  const [phase, setPhase] = useState<SavePhase>({ kind: 'idle' })
  // 最後に保存に成功したときの、承認済みの内容。
  const [savedKey, setSavedKey] = useState<string | null>(null)
  // 承認済みが0件のまま保存を押されたときの案内。
  const [notice, setNotice] = useState('')
  const [lastScopeKey, setLastScopeKey] = useState(scopeKey)

  const controllerRef = useRef<AbortController | null>(null)
  // 二重送信の即時ロック（状態の更新は非同期のため、refで確実に止める）。
  const inFlightRef = useRef(false)
  // 最新の保存の応答だけを採用するための通し番号。
  const seqRef = useRef(0)
  const approvedKeyRef = useRef(approvedKey)
  useLayoutEffect(() => {
    approvedKeyRef.current = approvedKey
  })

  // 別の旅程・地域になったら、保存の状態を消す（描画中の状態調整）。
  if (scopeKey !== lastScopeKey) {
    setLastScopeKey(scopeKey)
    setPhase({ kind: 'idle' })
    setSavedKey(null)
    setNotice('')
  }

  // 旅程・地域が変わったら、進行中の保存を中止し、古い応答を採用しない（コミットと同時に行う）。
  useLayoutEffect(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    seqRef.current += 1
    inFlightRef.current = false
  }, [scopeKey])
  // 画面を閉じるときも、進行中の保存を中止する。
  useEffect(
    () => () => {
      controllerRef.current?.abort()
      seqRef.current += 1
    },
    [],
  )

  // 承認済みが増えたら、0件のときの案内は消す。
  if (notice && approved.length > 0) setNotice('')

  const status: SaveStatus = (() => {
    if (phase.kind === 'saving') return { kind: 'saving' }
    // 以前に保存した内容があるときは、0件になっても「未保存の変更あり」とする（保存した内容とは違うため）。
    if (approved.length === 0 && savedKey === null) return { kind: 'empty' }
    if (phase.kind === 'failed' && phase.key === approvedKey) {
      return { kind: 'failed', message: phase.message, count: approved.length }
    }
    if (savedKey === approvedKey) return { kind: 'saved', count: approved.length }
    return { kind: 'unsaved', count: approved.length }
  })()

  // 保存済みだった内容が変わったら、その変化を通知する（見た目だけで伝えない）。
  const wasSavedRef = useRef(false)
  const statusKind = status.kind
  useEffect(() => {
    if (wasSavedRef.current && statusKind === 'unsaved') {
      announce('承認済みの内容が変わりました。未保存の変更があります。')
    }
    wasSavedRef.current = statusKind === 'saved'
  }, [statusKind, announce])

  const save = useCallback(async () => {
    if (!store) return
    if (inFlightRef.current) return
    // ボタンは常に押せるようにし、保存するものが無いときは、理由を案内する。
    if (approved.length === 0) {
      setNotice(EMPTY_NOTICE)
      announce(EMPTY_NOTICE)
      return
    }
    setNotice('')

    inFlightRef.current = true
    const seq = (seqRef.current += 1)
    const controller = new AbortController()
    controllerRef.current = controller
    const submittedKey = approvedKey
    const count = approved.length
    setPhase({ kind: 'saving' })
    announce('承認した学びを保存しています。')

    let result: SaveResult
    try {
      result = await store.save(approved, { signal: controller.signal })
    } catch {
      result = { ok: false, message: '' }
    }

    // 古い応答（中止された・新しい保存がある・旅程が切り替わった）は、採用しない。
    if (seq !== seqRef.current || controller.signal.aborted) return
    inFlightRef.current = false
    controllerRef.current = null

    if (result.ok === true) {
      setSavedKey(submittedKey)
      setPhase({ kind: 'idle' })
      announce(
        approvedKeyRef.current === submittedKey
          ? `承認した学び${count}件を保存しました。`
          : '保存しましたが、保存の間に承認済みの内容が変わったため、未保存の変更があります。',
      )
      return
    }
    // 失敗しても、承認済みの内容と入力中の内容は残す。失敗は、再試行できる。
    // 失敗の通知は、role="alert"（画面側）が担うため、ライブリージョンには入れない。
    const reason = result.message || DEFAULT_FAILURE
    setPhase({ kind: 'failed', key: submittedKey, message: reason })
  }, [store, approved, approvedKey, announce])

  return { status, notice, save }
}

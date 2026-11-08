'use client'

import { useEffect, useRef, useState } from 'react'

import { observeAuthState, type ClientAuthError } from './client'
import { createSessionScope, type SessionScope } from './session-scope'

// scopeEpochは、Firebase Userの認証世代が変わるたびに増える整数（このフックの利用単位で単調増加）。
// UID変更、セッション終了・復帰、同じUIDでもUserが置き換わった場合に増える。
// 同一Userの通常のトークン更新・再通知では増えない。最初の認証でも増えない。
// 利用側はscopeEpochまたはscope.uidが変わったら、表示・編集・選択・進行中の読み込みを捨てる。
export type SessionScopeState =
  | { status: 'restoring'; scopeEpoch: number }
  | { status: 'authenticated'; scope: SessionScope; scopeEpoch: number }
  | { status: 'session_ended'; error: ClientAuthError; scopeEpoch: number }
  | { status: 'error'; error: ClientAuthError; scopeEpoch: number }

// 認証状態を購読し、保存・生成などの操作に使うスコープを返す。
// restoring / session_ended / error ではscopeが無く、操作を始められない。
// どの状態でも匿名アカウントは作らない（新規開始は明示操作のstartNewAnonymousSessionだけ）。
export function useSessionScope(): SessionScopeState {
  const [state, setState] = useState<SessionScopeState>({ status: 'restoring', scopeEpoch: 0 })
  // 開発時のStrict Modeによる購読の張り直しでも、世代が戻らないようrefで持つ。
  const epochRef = useRef(0)
  const scopeRef = useRef<SessionScope | undefined>(undefined)
  const scopeGenerationRef = useRef<number | undefined>(undefined)
  const observedGenerationRef = useRef<number | undefined>(undefined)
  const authenticatedOnceRef = useRef(false)

  useEffect(() => {
    const stop = observeAuthState((auth) => {
      const previousGeneration = observedGenerationRef.current
      if (
        authenticatedOnceRef.current &&
        previousGeneration !== undefined &&
        previousGeneration !== auth.sessionGeneration
      ) {
        // 通知の同期区間で先に世代を進め、Reactの再描画より前に旧操作を無効化する。
        epochRef.current += 1
      }
      observedGenerationRef.current = auth.sessionGeneration

      if (auth.status === 'authenticated') {
        const { uid } = auth.user
        const previous = scopeRef.current
        const sameGeneration = scopeGenerationRef.current === auth.sessionGeneration
        // 同じ認証世代では同じスコープ参照を返し、トークン更新による再実行を避ける。
        const scope =
          previous?.uid === uid && sameGeneration
            ? previous
            : createSessionScope(uid, auth.sessionGeneration)
        scopeRef.current = scope
        scopeGenerationRef.current = auth.sessionGeneration
        authenticatedOnceRef.current = true
        // 更新関数は後から実行されうるため、この通知時点の世代を固定して使う。
        const scopeEpoch = epochRef.current
        setState((prev) =>
          prev.status === 'authenticated' && prev.scope === scope && prev.scopeEpoch === scopeEpoch
            ? prev
            : { status: 'authenticated', scope, scopeEpoch },
        )
        return
      }
      const scopeEpoch = epochRef.current
      if (auth.status === 'restoring') {
        setState((prev) =>
          prev.status === 'restoring' && prev.scopeEpoch === scopeEpoch
            ? prev
            : { status: 'restoring', scopeEpoch },
        )
        return
      }
      setState({ status: auth.status, error: auth.error, scopeEpoch })
    })
    return stop
  }, [])

  return state
}

import type { GenerationFailureKind } from './api-client'

// 失敗の種類ごとの見出しと、次にとれる行動の案内。
// 「条件に合う候補なし」「情報不足」「サービス失敗」「通信中断」を区別して伝える。
export const failureGuidance: Record<GenerationFailureKind, { title: string; action: string }> = {
  no_candidates: {
    title: '条件に合う旅程を作れませんでした',
    action: '旅行先や希望条件を見直して、もう一度お試しください。',
  },
  insufficient_information: {
    title: '旅程を作るための情報が足りません',
    action: '旅行先や希望条件をより具体的にして、もう一度お試しください。',
  },
  external_service_error: {
    title: 'AIによる旅程の生成に失敗しました',
    action: '入力内容はそのままです。時間をおいて、もう一度お試しください。',
  },
  invalid_request: {
    title: '入力内容を受け付けられませんでした',
    action: '入力内容を確認して、もう一度お試しください。',
  },
  payload_too_large: {
    title: '入力内容が大きすぎます',
    action: '希望条件を短くして、もう一度お試しください。',
  },
  service_unavailable: {
    title: '旅程の生成は現在利用できません',
    action:
      'このサービスでは、旅程の生成を一時的に停止しています。しばらくしてからお試しください。',
  },
  selection_changed: {
    title: '選んだ学びが変更または撤回されていました',
    action:
      '旅程は作っていません。入力内容はそのままです。学びの一覧を読み込み直したので、選び直してください。学びを使わずに作る場合は、選択を外してもう一度お試しください。',
  },
  learnings_unavailable: {
    title: '保存済みの学びを確認できませんでした',
    action:
      '旅程は作っていません。入力内容はそのままです。学びの選択を外して、学びを使わずに旅程を作成するか、時間をおいてもう一度お試しください。',
  },
  session_changed: {
    title: '認証の状態が変わったため、学びを使った生成を取りやめました',
    action:
      '入力内容はそのままです。選んでいた学びは解除しました。学びの一覧を確認して選び直してから、もう一度お試しください。',
  },
  unauthorized: {
    title: '認証、招待、またはアプリの検証が通りませんでした',
    action:
      '入力内容はそのままです。認証の有効期限が切れているか、このアカウントでは利用できない可能性があります。認証の状態を確認してから、もう一度お試しください。',
  },
  rate_limited: {
    title: '利用の回数が上限に達しました',
    action:
      '入力内容はそのままです。しばらく時間をおいてから、もう一度お試しください。繰り返し押しても、上限は戻りません。',
  },
  auth_required: {
    title: '認証情報を取得できず、旅程の生成を送信しませんでした',
    action:
      'AIには問い合わせていません。入力内容はそのままです。認証の状態を確認してから、もう一度お試しください。',
  },
  app_check_unavailable: {
    title: 'アプリの検証（App Check）を用意できず、旅程の生成を送信しませんでした',
    action:
      'AIには問い合わせていません。入力内容はそのままです。設定の不足や、reCAPTCHAの失敗が考えられます。時間をおいてもう一度お試しください。',
  },
  interrupted: {
    title: '通信が中断されました',
    action: '入力内容はそのままです。接続を確認して、もう一度お試しください。',
  },
  unexpected: {
    title: '予期しないエラーが発生しました',
    action: '入力内容はそのままです。時間をおいて、もう一度お試しください。',
  },
}

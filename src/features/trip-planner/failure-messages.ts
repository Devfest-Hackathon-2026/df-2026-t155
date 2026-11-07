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
  interrupted: {
    title: '通信が中断されました',
    action: '入力内容はそのままです。接続を確認して、もう一度お試しください。',
  },
  unexpected: {
    title: '予期しないエラーが発生しました',
    action: '入力内容はそのままです。時間をおいて、もう一度お試しください。',
  },
}

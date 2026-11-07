import { GoogleAuth } from 'google-auth-library'

import { MapsCallError } from './errors'

// Places・Routesの認証はサーバーのADC（サービスアカウント）のOAuthトークンで行い、
// APIキーは使わない（キーの作成にはapikeys APIの有効化が必要で、チームの承認も無い）。
// トークンは呼び出しごとに取得し（ライブラリがキャッシュ・更新する）、保存もログ出力もしない。

export interface MapsAuth {
  // Authorization と X-Goog-User-Project（課金・クォータの対象プロジェクト）を返す。
  getHeaders(): Promise<Record<string, string>>
}

export interface MapsConfig {
  project: string
}

export function loadMapsConfig(env: Record<string, string | undefined>): MapsConfig {
  const project = env.GOOGLE_CLOUD_PROJECT?.trim()
  if (!project) {
    throw new MapsCallError('not_configured', 'GOOGLE_CLOUD_PROJECTが設定されていません')
  }
  return { project }
}

export type AccessTokenFn = () => Promise<string | null | undefined>

// アクセストークンの取得を注入できるようにし、単体テストで実際の認証へ接続しない。
export function createMapsAuth(project: string, getAccessToken: AccessTokenFn): MapsAuth {
  return {
    async getHeaders() {
      let token: string | null | undefined
      try {
        token = await getAccessToken()
      } catch {
        // 認証ライブラリの例外は、メッセージに機微な情報を含み得るため、保持しない。
        throw new MapsCallError('auth_failed', 'Google Maps Platformの認証に失敗しました')
      }
      if (!token) {
        throw new MapsCallError('auth_failed', 'Google Maps Platformの認証に失敗しました')
      }
      return { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': project }
    },
  }
}

export function createAdcMapsAuth(project: string): MapsAuth {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  return createMapsAuth(project, () => auth.getAccessToken())
}

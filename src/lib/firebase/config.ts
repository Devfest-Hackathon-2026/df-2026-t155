import { z } from 'zod'

export class FirebaseConfigurationError extends Error {
  constructor() {
    super('Firebaseの設定を確認してください')
    this.name = 'FirebaseConfigurationError'
  }
}

export class DemoSessionExitPendingError extends Error {
  constructor() {
    super('デモの終了操作を完了してください')
    this.name = 'DemoSessionExitPendingError'
  }
}

const ProjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)
const EmulatorFlagSchema = z.enum(['true', 'false']).optional()

// process.envはクライアント側で静的に参照する。環境変数の値をエラーへ含めない。
export function parseClientConfig(env: {
  projectId?: string
  apiKey?: string
  authDomain?: string
  appId?: string
  useEmulators?: string
  nodeEnv?: string
}) {
  const result = z
    .object({
      projectId: ProjectIdSchema,
      apiKey: z.string().min(1),
      authDomain: z.string().min(1),
      appId: z.string().min(1),
      useEmulators: EmulatorFlagSchema,
      nodeEnv: z.string().optional(),
    })
    .safeParse(env)

  if (!result.success) throw new FirebaseConfigurationError()
  const { useEmulators, nodeEnv, ...options } = result.data
  const emulator = useEmulators === 'true'
  if (emulator && (nodeEnv === 'production' || !options.projectId.startsWith('demo-'))) {
    throw new FirebaseConfigurationError()
  }
  return { options, emulator }
}

export function parseServerConfig(env: {
  projectId?: string
  clientProjectId?: string
  useEmulators?: string
  authEmulatorHost?: string
  firestoreEmulatorHost?: string
  nodeEnv?: string
}) {
  const project = ProjectIdSchema.safeParse(env.projectId)
  const flag = EmulatorFlagSchema.safeParse(env.useEmulators)
  if (!project.success || !flag.success) throw new FirebaseConfigurationError()
  if (env.clientProjectId && env.clientProjectId !== project.data) {
    throw new FirebaseConfigurationError()
  }

  const emulator = flag.data === 'true'
  if (emulator) {
    if (
      env.nodeEnv === 'production' ||
      !project.data.startsWith('demo-') ||
      env.authEmulatorHost !== '127.0.0.1:9099' ||
      env.firestoreEmulatorHost !== '127.0.0.1:8080'
    ) {
      throw new FirebaseConfigurationError()
    }
  } else if (env.authEmulatorHost !== undefined || env.firestoreEmulatorHost !== undefined) {
    // Auth Emulatorの署名なしトークン受け入れを、暗黙に有効化させない。
    throw new FirebaseConfigurationError()
  }
  return { projectId: project.data, emulator }
}

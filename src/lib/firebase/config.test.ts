import { describe, expect, it } from 'vitest'

import { FirebaseConfigurationError, parseClientConfig, parseServerConfig } from './config'

const client = {
  projectId: 'demo-groundtrip',
  apiKey: 'demo-api-key',
  authDomain: 'demo-groundtrip.firebaseapp.com',
  appId: 'demo-app-id',
  useEmulators: 'true',
  nodeEnv: 'test',
}
const server = {
  projectId: 'demo-groundtrip',
  clientProjectId: 'demo-groundtrip',
  useEmulators: 'true',
  authEmulatorHost: '127.0.0.1:9099',
  firestoreEmulatorHost: '127.0.0.1:8080',
  nodeEnv: 'test',
}

describe('Firebase環境設定', () => {
  it('demoプロジェクトとローカルEmulatorを明示的に指定する', () => {
    expect(parseClientConfig(client).emulator).toBe(true)
    expect(parseServerConfig(server).emulator).toBe(true)
  })

  it.each([
    { nodeEnv: 'production' },
    { projectId: 'real-project' },
    { projectId: undefined },
    { useEmulators: 'yes' },
  ])('クライアントの危険な設定を拒否する: %j', (changes) => {
    expect(() => parseClientConfig({ ...client, ...changes })).toThrow(FirebaseConfigurationError)
  })

  it.each([
    { nodeEnv: 'production' },
    { projectId: 'real-project', clientProjectId: 'real-project' },
    { clientProjectId: 'other-project' },
    { projectId: undefined },
    { useEmulators: 'yes' },
    { useEmulators: 'false' },
    { useEmulators: undefined },
    { authEmulatorHost: undefined },
    { firestoreEmulatorHost: undefined },
    { authEmulatorHost: 'remote.example:9099' },
    { firestoreEmulatorHost: 'remote.example:8080' },
  ])('署名検証の迂回・実DB混在・プロジェクト不一致を拒否する: %j', (changes) => {
    expect(() => parseServerConfig({ ...server, ...changes })).toThrow(FirebaseConfigurationError)
  })

  it('本番設定はEmulator変数なしで受け付ける', () => {
    expect(
      parseServerConfig({
        projectId: 'real-project',
        clientProjectId: 'real-project',
        nodeEnv: 'production',
      }),
    ).toEqual({ projectId: 'real-project', emulator: false })
  })
})

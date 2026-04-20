import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { HubConnectionForm } from '../shared/hub-connection-form'
import {
  requestCompletionNotificationPermission,
  writeStoredCompletionNotificationSettings,
} from '../../lib/notifications'
import { isNativeApp } from '../../lib/platform'
import { resetRuntimeConnectionState } from '../../lib/runtime-connection-reset'
import { useRuntimeConfig, writeRuntimeConfig } from '../../lib/runtime-config'

export const RuntimeOnboardingGate = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const runtimeConfig = useRuntimeConfig()

  return (
    <main className="runtime-onboarding">
      <div className="runtime-onboarding__shell">
        <section className="runtime-onboarding__hero">
          <span className="runtime-onboarding__eyebrow">首次连接</span>
          <h1 className="runtime-onboarding__title">输入 Panda 访问地址</h1>
          <p className="runtime-onboarding__summary">
            填一次，之后打开就能直接进入。也支持扫码。
          </p>
        </section>

        <section className="settings-panel runtime-onboarding__panel">
          <HubConnectionForm
            title="Hub 地址"
            description="填写电脑上显示的访问地址。"
            initialHubUrl={runtimeConfig.hubUrl}
            hint="手机能直接打开这个地址就可以。"
            saveLabel="保存并进入"
            savingLabel="连接中"
            saveDescription="保存后立即进入，之后也能在设置里修改。"
            saveSuccessMessage="地址已保存，正在进入 Panda。"
            onSaveSuccess={async (result) => {
              await writeRuntimeConfig({
                hubUrl: result.url,
                onboardingCompleted: true,
              })

              if (isNativeApp()) {
                const permission =
                  await requestCompletionNotificationPermission().catch(
                    () => 'unsupported' as const,
                  )
                if (permission === 'granted') {
                  writeStoredCompletionNotificationSettings({
                    completionNotificationsEnabled: true,
                  })
                }
              }

              await resetRuntimeConnectionState(queryClient)
              await navigate({ to: '/nodes', replace: true })
            }}
          />
        </section>
      </div>
    </main>
  )
}

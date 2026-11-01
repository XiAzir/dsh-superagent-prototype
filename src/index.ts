/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { protectStateDirectory } from './infra/private-directory.ts'
import { webSource } from './app/web-tasks.ts'
import { QqBridge, QqSourceError } from './app/qq-source.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  protectStateDirectory(machine.stateDir)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // DSH's editable forms accept volatile fields. Keep this activation's mode fixed until a saved mode change remounts it.
  let modeRestart: ReturnType<typeof setTimeout> | undefined
  ctx.on('loader/volatile-update', paths => {
    if (!paths.some(path => path.length === 1 && path[0] === 'mode') || modeRestart !== undefined || config.mode.get() === machine.mode) return
    modeRestart = setTimeout(() => {
      modeRestart = undefined
      if (config.mode.get() !== machine.mode) restart()
    }, 0)
  })
  ctx.effect(() => () => { clearTimeout(modeRestart) })
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => runtime.sources.register(webSource(runtime.store, () => machine.mode === 'personal', runtime.artifacts)))
  const qq = runtime.qq = new QqBridge({ store: runtime.store, stateDir: machine.stateDir, artifacts: runtime.artifacts,
    configured: () => runtime.configured(), receive: trigger => runtime.receive(trigger),
    notify: message => runtime.outbox.send(message),
    report: value => runtime.sources.healthEntries(['qq']).get('qq')?.set(value),
    resolveToken: async name => (await ctx.get('credentials')?.resolve(credentialRef(name)))?.value ?? process.env[name],
    writeToken: async (name, value) => {
      const credentials = ctx.get('credentials')
      if (!credentials) throw new QqSourceError(503, 'DSH 凭据服务尚未就绪，请稍后重试。')
      if (value) await credentials.set(credentialRef(name), value)
      else await credentials.unset(credentialRef(name))
    } })
  const unregisterQq = runtime.sources.register(qq.kind)
  ctx.effect(() => async () => { await qq.stop(); await runtime.stop(); unregisterQq() })
  await runtime.ready
  await qq.start()
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'

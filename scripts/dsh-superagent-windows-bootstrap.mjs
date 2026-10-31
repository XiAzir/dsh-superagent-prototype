// Receive the wrapper's authenticated control-file request and invoke DSH's graceful SIGTERM listener.
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const entry = process.argv.splice(2, 1)[0]
if (!entry) throw new Error('Missing dsh CLI entry path.')
process.argv[1] = entry
const token = process.env.DSH_SUPERAGENT_CONTROL_TOKEN
const requestPath = process.env.DSH_SUPERAGENT_STOP_REQUEST
let stopDelivered = false
let waitingForHandlerLogged = false
const control = setInterval(() => {
  if (stopDelivered || !token || !requestPath || !existsSync(requestPath)) return
  try {
    const request = JSON.parse(readFileSync(requestPath, 'utf8'))
    if (request.token !== token || request.pid !== process.pid) {
      process.stderr.write('Ignored a stop request that did not match this bootstrap identity.\n')
      return
    }
    if (process.listenerCount('SIGTERM') === 0) {
      if (!waitingForHandlerLogged) process.stderr.write('Authenticated stop request is waiting for DSH startup to install SIGTERM handlers.\n')
      waitingForHandlerLogged = true
      return
    }
    stopDelivered = true
    unlinkSync(requestPath)
    process.stderr.write('Delivered authenticated stop request to DSH SIGTERM handlers.\n')
    process.emit('SIGTERM')
    clearInterval(control)
  } catch {
    // The writer replaces a complete JSON request atomically from the service manager.
  }
}, 100)
control.unref()
const { runCli } = await import(pathToFileURL(entry).href)
try {
  await runCli()
} catch (error) {
  clearInterval(control)
  throw error
}

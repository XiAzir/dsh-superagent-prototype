/**
 * Default-path guard for worker-facing account CLIs. The generated program sees argv only and never prints it,
 * so rejected commands cannot echo an attempted token or secret into worker output.
 */
export const CREDENTIAL_GUARD_PROGRAM = String.raw`
const command = String(process.argv[1] || '').toLowerCase()
const args = process.argv.slice(2)
const valueOptions = command === 'gh'
  ? new Set(['-r', '--repo', '-h', '--hostname', '--config', '--git-protocol'])
  : new Set(['--config', '--config-dir', '--profile'])
const words = []
for (let i = 0; i < args.length && words.length < 2; i++) {
  const arg = args[i]
  if (arg === '--') break
  if (arg.startsWith('-')) {
    const name = arg.split('=', 1)[0].toLowerCase()
    if (valueOptions.has(name) && !arg.includes('=')) i++
    continue
  }
  words.push(arg.toLowerCase())
}
const [group, action] = words
let refusal = ''
if (command === 'gh' && group === 'auth') {
  const flags = args.map(arg => arg.toLowerCase())
  if (action === 'status' && flags.some(arg => arg === '--show-token' || arg.startsWith('--show-token=') || arg === '-t' || (arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes('t')))) {
    refusal = 'gh auth status token display is blocked in worker CLI.'
  } else if (action !== 'status') {
    refusal = 'gh credential or account management is blocked in worker CLI.'
  }
}
if (command === 'lark-cli' && (group === 'auth' || group === 'config')) {
  // Lark CLI auth and config commands can reveal credentials or change the identity/strict mode.
  // Workers only need business APIs such as api and im; the host calls setup commands directly.
  refusal = 'lark-cli credential or configuration management is blocked in worker CLI.'
}
if (refusal) {
  console.error(refusal)
  process.exit(1)
}
`


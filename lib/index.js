/**
 * dsh-keep-awake — host half.
 *
 * Keeps the OS awake while any DSH agent, subagent, or background job runs,
 * then releases the hold after a configurable grace period.
 *
 * Activity sources (rescan every 5s, plus immediate rescans on
 * agent/status, subagent/start|end, and job-set changes):
 *   - agents.list(): agents whose status is 'running'
 *     (covers the main agent, subagents, and workflow children)
 *   - jobs.list() / jobs.list(agent): jobs with status running|stopping
 *     (covers run_in_background shell commands and background subagent jobs)
 *
 * The keep-awake helper is one child process, spawned through the
 * `subprocess` service (tree-scoped termination):
 *   - win32:  powershell SetThreadExecutionState(ES_CONTINUOUS |
 *             ES_SYSTEM_REQUIRED [| ES_DISPLAY_REQUIRED])
 *   - darwin: caffeinate [-d] -i -s
 *   - linux:  systemd-inhibit --what=idle --mode=block sleep 1e8
 *
 * Settings persist in the `keep-awake` namespace of the DSH settings
 * service. The web settings page (lib/client.js) polls GET /dsh-keep-awake/state
 * and PUTs /dsh-keep-awake/config.
 */
import { z } from 'zod'

export const name = 'dsh-keep-awake'
export const inject = ['timer']

const SETTINGS_NAMESPACE = 'keep-awake'
const STATE_ROUTE = '/dsh-keep-awake/state'
const CONFIG_ROUTE = '/dsh-keep-awake/config'
const POLL_MS = 5000
const PROBE_TIMEOUT_MS = 3000
const POWERSHELL_FALLBACK = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CAFFEINATE_FALLBACK = '/usr/bin/caffeinate'
const MAX_BODY_BYTES = 64 * 1024

const KeepAwakeSchema = z.object({
  enabled: z.boolean().default(true),
  graceMs: z.number().int().min(1000).max(3600000).default(60000),
  preventDisplaySleep: z.boolean().default(false),
  manualHold: z.boolean().default(false),
})

const DEFAULT_CONFIG = {
  enabled: true,
  graceMs: 60000,
  preventDisplaySleep: false,
  manualHold: false,
}

function normalizeConfig(value) {
  const v = typeof value === 'object' && value !== null ? value : {}
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_CONFIG.enabled,
    graceMs: Number.isFinite(v.graceMs)
      ? Math.min(3600000, Math.max(1000, Math.round(v.graceMs)))
      : DEFAULT_CONFIG.graceMs,
    preventDisplaySleep: typeof v.preventDisplaySleep === 'boolean'
      ? v.preventDisplaySleep
      : DEFAULT_CONFIG.preventDisplaySleep,
    manualHold: typeof v.manualHold === 'boolean' ? v.manualHold : DEFAULT_CONFIG.manualHold,
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isSameOriginMutation(req) {
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host && loopbackHost
    } catch {
      return false
    }
  }
  return loopbackHost && req.headers['sec-fetch-site'] === 'same-origin'
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

async function readJsonBody(req) {
  req.setEncoding('utf8')
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
      throw new Error('request body exceeds 64 KiB')
    }
  }
  if (text.length === 0) throw new Error('request body is required')
  const value = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object')
  }
  return value
}

function dirOf(path) {
  const i = path.lastIndexOf('\\')
  const j = path.lastIndexOf('/')
  const k = Math.max(i, j)
  return k >= 0 ? path.slice(0, k) : '.'
}

/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED | (ES_DISPLAY_REQUIRED when flags===3). */
function powershellScript(flags) {
  return (
    "$src = @'\n" +
    'using System;\n' +
    'using System.Runtime.InteropServices;\n' +
    'public class DshKa {\n' +
    '  [DllImport("kernel32.dll")]\n' +
    '  public static extern uint SetThreadExecutionState(uint flags);\n' +
    '  public static void Hold(uint flags) {\n' +
    '    SetThreadExecutionState(0x80000000u | flags);\n' +
    '    Thread.Sleep(Timeout.Infinite);\n' +
    '  }\n' +
    '}\n' +
    "'@\n" +
    'Add-Type -TypeDefinition $src\n' +
    '[void][DshKa]::Hold(' + flags + ')'
  )
}

export async function apply(ctx) {
  const subprocess = ctx.get('subprocess')
  const jobs = ctx.get('jobs')
  const agents = ctx.get('agents')
  const settings = ctx.get('settings')
  const webServer = ctx.get('webServer')

  if (subprocess === undefined) {
    ctx.logger?.warn?.('keep-awake: subprocess service missing; plugin inactive')
  }

  const platform = process.platform
  const config = { ...DEFAULT_CONFIG }
  const activity = { runningAgents: 0, liveJobs: 0 }
  const helper = {
    state: 'off',
    proc: null,
    pid: null,
    error: null,
    paths: null,
    starting: false,
    stopRequested: false,
  }
  let graceTimer = null
  let graceUntil = 0
  let stopped = false

  // ------------------------------------------------------------------ probes

  /** resolveExecutable with a bounded wait so a pathological PATH cannot hang us. */
  const tryResolve = (candidate) => new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    try {
      const t = ctx.timeout(PROBE_TIMEOUT_MS)
      if (t !== null && typeof t.then === 'function') t.then(() => finish(null))
    } catch {
      /* timer unavailable; the probe promise alone still settles */
    }
    try {
      Promise.resolve(subprocess.resolveExecutable(candidate)).then((v) => finish(v), () => finish(null))
    } catch {
      finish(null)
    }
  })

  async function resolveHelperPaths() {
    if (helper.paths !== null) return helper.paths
    const paths = {}
    if (platform === 'win32') {
      const ps = (await tryResolve('powershell')) ?? (await tryResolve(POWERSHELL_FALLBACK))
      if (ps !== null) paths.powershell = ps
    } else if (platform === 'darwin') {
      paths.caffeinate = (await tryResolve('caffeinate')) ?? CAFFEINATE_FALLBACK
    } else if (platform === 'linux') {
      const inhibit = await tryResolve('systemd-inhibit')
      if (inhibit !== null) {
        paths.inhibit = inhibit
        paths.sleep = (await tryResolve('sleep')) ?? 'sleep'
      }
    }
    helper.paths = Object.keys(paths).length > 0 ? paths : null
    return helper.paths
  }

  // ------------------------------------------------------------------ helper

  function buildArgv() {
    const paths = helper.paths
    if (paths === null) throw new Error('helper paths unresolved')
    if (platform === 'win32') {
      const flags = config.preventDisplaySleep ? 3 : 1
      return [paths.powershell, '-NoProfile', '-NonInteractive', '-Command', powershellScript(flags)]
    }
    if (platform === 'darwin') {
      return config.preventDisplaySleep
        ? [paths.caffeinate, '-d', '-i', '-s']
        : [paths.caffeinate, '-i', '-s']
    }
    if (platform === 'linux') {
      return [
        paths.inhibit, '--what=idle', '--who=dsh-keep-awake', '--why=DSH agents running',
        '--mode=block', paths.sleep, '100000000',
      ]
    }
    return null
  }

  const shouldHold = () =>
    config.enabled && (config.manualHold || activity.runningAgents > 0 || activity.liveJobs > 0)

  function snapshot() {
    return {
      platform,
      enabled: config.enabled,
      graceMs: config.graceMs,
      preventDisplaySleep: config.preventDisplaySleep,
      manualHold: config.manualHold,
      runningAgents: activity.runningAgents,
      liveJobs: activity.liveJobs,
      active: shouldHold(),
      graceRemainingMs: graceTimer !== null ? Math.max(0, graceUntil - Date.now()) : 0,
      helperState: helper.state,
      helperPid: helper.pid,
      helperError: helper.error,
    }
  }

  function stopHelper() {
    if (graceTimer !== null) {
      graceTimer()
      graceTimer = null
    }
    graceUntil = 0
    helper.stopRequested = true
    const proc = helper.proc
    helper.proc = null
    helper.pid = null
    helper.state = 'off'
    if (proc !== null) proc.terminate()
  }

  function startHelper() {
    if (helper.starting) return
    helper.starting = true
    helper.stopRequested = false
    helper.state = 'starting'
    helper.error = null
    (async () => {
      let proc = null
      try {
        const paths = await resolveHelperPaths()
        if (paths === null) {
          helper.state = 'error'
          helper.error = `未找到防休眠工具（platform=${platform}）`
          return
        }
        const argv = buildArgv()
        if (argv === null) throw new Error('no helper argv for platform ' + platform)
        proc = subprocess.spawn({
          argv,
          cwd: dirOf(String(argv[0])),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
          graceMs: 3000,
        })
        if (helper.stopRequested) {
          proc.done.catch(() => {})
          proc.terminate()
          return
        }
        helper.proc = proc
        helper.pid = proc.pid
        helper.state = 'on'
        const outcome = await proc.done
        if (stopped || helper.proc !== proc) return
        let msg = 'exit ' + (outcome.exitCode === null
          ? 'signal ' + String(outcome.signal)
          : 'code ' + String(outcome.exitCode))
        try {
          const tail = proc.collected.stderr.readFrom(0)
          if (tail && typeof tail.text === 'string' && tail.text.trim() !== '') {
            msg = tail.text.trim().slice(-500)
          }
        } catch {
          /* keep the exit summary */
        }
        helper.proc = null
        helper.pid = null
        helper.state = 'error'
        helper.error = msg
      } catch (e) {
        if (stopped) return
        helper.proc = null
        helper.pid = null
        helper.state = 'error'
        helper.error = errorMessage(e)
      } finally {
        helper.starting = false
      }
    })()
  }

  function evaluate() {
    if (shouldHold()) {
      if (graceTimer !== null) {
        graceTimer()
        graceTimer = null
      }
      graceUntil = 0
      if (helper.state === 'off' || helper.state === 'error') startHelper()
      return
    }
    if (helper.state === 'on' || helper.state === 'starting') {
      if (graceTimer !== null) graceTimer()
      const wait = config.enabled ? config.graceMs : 0
      if (wait <= 0) {
        stopHelper()
        return
      }
      graceUntil = Date.now() + wait
      graceTimer = ctx.timeout(() => {
        graceTimer = null
        graceUntil = 0
        if (!shouldHold() && (helper.state === 'on' || helper.state === 'starting')) stopHelper()
      }, wait)
    }
  }

  // ---------------------------------------------------------------- activity

  function resync() {
    let runningAgents = 0
    const liveAgents = []
    if (agents !== undefined) {
      try {
        const list = agents.list()
        for (const a of list) {
          if (a !== null && a !== undefined && a.status === 'running') runningAgents++
        }
        liveAgents.push(...list)
      } catch {
        /* agents service raced its own teardown */
      }
    }
    let liveJobs = 0
    if (jobs !== undefined) {
      const seen = {}
      const addList = (list) => {
        for (const j of list) seen[j.id] = j
      }
      try {
        addList(jobs.list())
      } catch {
        /* ignore */
      }
      for (const a of liveAgents) {
        try {
          addList(jobs.list(a))
        } catch {
          /* ignore */
        }
      }
      const ids = Object.keys(seen)
      for (const id of ids) {
        const s = seen[id].status
        if (s === 'running' || s === 'stopping') liveJobs++
      }
    }
    activity.runningAgents = runningAgents
    activity.liveJobs = liveJobs
    evaluate()
  }

  // ---------------------------------------------------------------- settings

  let settingsScope = null
  if (settings !== undefined) {
    try {
      settingsScope = settings.register(SETTINGS_NAMESPACE, KeepAwakeSchema, { applies: 'live' })
      Object.assign(config, normalizeConfig(settingsScope.get()))
      ctx.on('settings/updated', (ns, next) => {
        if (ns !== SETTINGS_NAMESPACE) return
        Object.assign(config, normalizeConfig(next))
        resync()
      })
    } catch (e) {
      ctx.logger?.warn?.(`keep-awake: settings registration failed: ${errorMessage(e)}`)
    }
  }

  // -------------------------------------------------------------------- web

  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: STATE_ROUTE,
      async handler(req, res) {
        if (!isLoopbackAddress(req.socket?.remoteAddress)) {
          sendJson(res, 403, { error: 'keep-awake state is available only over a loopback connection.' })
          return
        }
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET')
          sendJson(res, 405, { error: 'Method not allowed.' })
          return
        }
        try {
          resync()
        } catch {
          /* keep serving the cached activity */
        }
        sendJson(res, 200, snapshot())
      },
    }), 'dsh-keep-awake: state route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      async handler(req, res) {
        if (req.method !== 'PUT') {
          res.setHeader('allow', 'PUT')
          sendJson(res, 405, { error: 'Method not allowed.' })
          return
        }
        if (!isSameOriginMutation(req)) {
          sendJson(res, 403, { error: 'Config updates require a same-origin browser request.' })
          return
        }
        const contentType = req.headers['content-type']
        if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { error: 'Config updates require application/json.' })
          return
        }
        try {
          const body = await readJsonBody(req)
          if (typeof body.section !== 'object' || body.section === null || Array.isArray(body.section)) {
            throw new Error('config update requires a section object')
          }
          const section = normalizeConfig(body.section)
          if (settingsScope !== null) await settingsScope.replace(section)
          Object.assign(config, section)
          resync()
          sendJson(res, 200, snapshot())
        } catch (e) {
          sendJson(res, e instanceof SyntaxError ? 400 : 400, { error: errorMessage(e) })
        }
      },
    }), 'dsh-keep-awake: config route')
  }

  // ------------------------------------------------------------ subscriptions

  ctx.effect(() => {
    const disposers = []
    disposers.push(ctx.interval(() => {
      try {
        resync()
      } catch {
        /* poll tick */
      }
    }, POLL_MS))
    disposers.push(ctx.on('agent/status', () => {
      try {
        resync()
      } catch {
        /* listener */
      }
    }))
    disposers.push(ctx.on('subagent/start', () => {
      try {
        resync()
      } catch {
        /* listener */
      }
    }))
    disposers.push(ctx.on('subagent/end', () => {
      try {
        resync()
      } catch {
        /* listener */
      }
    }))
    if (jobs !== undefined && typeof jobs.onJobsChanged === 'function') {
      disposers.push(jobs.onJobsChanged(() => {
        try {
          resync()
        } catch {
          /* listener */
        }
      }))
    }
    void resolveHelperPaths()
    try {
      resync()
    } catch {
      /* initial rescan */
    }
    return () => {
      stopped = true
      for (const d of disposers) d()
      stopHelper()
    }
  })
}

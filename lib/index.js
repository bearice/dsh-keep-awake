/**
 * dsh-keep-awake — host half.
 *
 * Keeps the OS awake while any DSH agent, subagent, or background job runs,
 * then releases the hold after a configurable grace period.
 *
 * Activity sources (rescan every 5s, plus immediate rescans on
 * agent/status, subagent/start|end, and job-registry events):
 *   - agents.list(): agents whose status is 'running'
 *     (covers the main agent, subagents, and workflow children)
 *   - jobs registry: jobs with status running|stopping, read through
 *     jobs.list(caller) — one call per live agent's session id plus the
 *     unowned bucket (covers run_in_background shell commands and background
 *     subagent jobs). A job with an owner is reachable only by its own
 *     session id, so an unscoped list() alone would miss every agent job.
 *
 * The keep-awake helper is one child process, spawned directly through
 * node:child_process (posix children are detached process-group leaders so
 * teardown can kill the whole tree):
 *   - win32:  powershell SetThreadExecutionState(ES_CONTINUOUS |
 *             ES_SYSTEM_REQUIRED [| ES_DISPLAY_REQUIRED])
 *   - darwin: /usr/bin/env caffeinate [-d] -i -s
 *   - linux:  /usr/bin/env systemd-inhibit --what=idle --mode=block sleep 1e8
 *
 * Settings live in this plugin's own Loader row: the 0.2 line of DSH replaced
 * the registrable settings namespace with a forms service over the profile's
 * entries, so the user preferences ARE the exported `Config` schema below,
 * written through the `settings` service and read back from `describe()`.
 * The web settings page (lib/client.js) polls GET /dsh-keep-awake/state and
 * PUTs /dsh-keep-awake/config.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-keep-awake'
// apply waits until every injected service exists; webServer is the latest to
// register in this profile, so the row applies late enough for settings & co.
// `timer` stays injected: ctx.timeout / ctx.interval are service-backed
// getters in the row context and throw without it.
export const inject = ['settings', 'webServer', 'timer']

const STATE_ROUTE = '/dsh-keep-awake/state'
const CONFIG_ROUTE = '/dsh-keep-awake/config'
const POLL_MS = 5000
const POWERSHELL_FALLBACK = (process.env.WINDIR
  ? path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
const MAX_BODY_BYTES = 64 * 1024

const KeepAwakeSchema = z.object({
  enabled: z.boolean().default(true),
  graceMs: z.number().step(1).min(1000).max(3600000).default(60000),
  preventDisplaySleep: z.boolean().default(false),
  manualHold: z.boolean().default(false),
})

/**
 * Config schema of this plugin's Loader row — the user preferences themselves.
 *
 * Every field is volatile, and BOTH halves of that matter:
 *   - the Loader's `equalExceptVolatile` ignores volatile fields, so a
 *     preference edit is recognised as volatile-only and takes the live-commit
 *     path (`loader/volatile-update`) instead of remounting the plugin;
 *   - DSH's schemastery WRAPS a volatile field in a cosmokit `Volatile`
 *     reference while parsing, which is the thing that path commits into. A
 *     schema from a build without that wrapping sets the same `meta` flag but
 *     produces plain values, and the commit then silently has nothing to do —
 *     which is why `@deepseek-ai/schemastery` here must be >= 3.18.5 and why
 *     the settings service otherwise rejects the row as having no volatile
 *     fields.
 *
 * `.volatile()` RETURNS A COPY (`extra()` does), so the marked schemas have to
 * be collected — calling it for its side effect leaves every field non-volatile.
 *
 * If the resolved schemastery predates `.volatile()` (a profile pinning 3.18.1
 * for some other plugin can shadow the host's 3.18.5), the plugin still loads
 * with plain fields: the settings page keeps working in memory for this run and
 * `snapshot().persistent` reports false, instead of the package failing to
 * import. See `volatileSupported` below.
 */
const volatileSupported = typeof KeepAwakeSchema.dict?.enabled?.volatile === 'function'

const volatilePrefs = volatileSupported
  ? Object.fromEntries(
      Object.entries(KeepAwakeSchema.dict ?? {}).map(([key, field]) => [key, field.volatile()]),
    )
  : KeepAwakeSchema.dict

export const Config = z.object({ ...volatilePrefs })

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

/**
 * Keep only the recognized preference keys of a partial update.
 *
 * The config route sends a patch, not a whole section: normalizing it with
 * `normalizeConfig` would fill every absent key with its default and silently
 * reset whatever the caller did not mention.
 */
function configPatch(value) {
  const v = typeof value === 'object' && value !== null ? value : {}
  const patch = {}
  if (typeof v.enabled === 'boolean') patch.enabled = v.enabled
  if (Number.isFinite(v.graceMs)) patch.graceMs = Math.min(3600000, Math.max(1000, Math.round(v.graceMs)))
  if (typeof v.preventDisplaySleep === 'boolean') patch.preventDisplaySleep = v.preventDisplaySleep
  if (typeof v.manualHold === 'boolean') patch.manualHold = v.manualHold
  return patch
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

/** Synchronous PATH scan. Skips UNC roots so a dead share cannot hang boot. */
function whichSync(name) {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  for (const dir of dirs) {
    if (dir.startsWith('\\\\') || dir.startsWith('//')) continue
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase())
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* unreadable entry */
      }
    }
  }
  return null
}

/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED | (ES_DISPLAY_REQUIRED when flags===3). */
function powershellScript(flags) {
  return (
    "$src = @'\n" +
    'using System;\n' +
    'using System.Runtime.InteropServices;\n' +
    'using System.Threading;\n' +
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
  const jobs = ctx.get('jobs')
  const agents = ctx.get('agents')
  const settings = ctx.get('settings')
  const webServer = ctx.get('webServer')

  // Real failures surface through ctx.logger only (no console noise in the
  // committed source; add temporary console logging while debugging).
  const lerr = (msg) => {
    try {
      ctx.logger?.warn?.(msg)
    } catch {
      /* logger optional */
    }
  }

  const platform = process.platform
  const config = { ...DEFAULT_CONFIG }
  const activity = { runningAgents: 0, liveJobs: 0 }
  const helper = {
    state: 'off',
    proc: null,
    pid: null,
    error: null,
    powershell: undefined,
    starting: false,
    startingSince: 0,
    stopRequested: false,
  }
  let graceTimer = null
  let graceUntil = 0
  let stopped = false

  // ---------------------------------------------------------------- settings
  //
  // The 0.2 line of DSH dropped the registrable settings namespace
  // (`register(ns, schema, {applies})`) for a forms service over the Loader
  // entries. A plugin's preferences are now its row's `Config` (exported
  // above), addressed by the row id: `describe()` projects the live values and
  // revision, `update(ns, patch, revision)` writes them back as a profile
  // patch, and the Loader commits a volatile-only change into the running
  // fiber instead of remounting it.
  //
  // The old settings.yaml namespace is gone for good (DSH renamed it to
  // settings.yaml.imported at the upgrade), so nothing is migrated here: the
  // defaults below are the starting point for anyone without a row override.
  const settingsAvailable = settings !== undefined
    && typeof settings.describe === 'function'
    && typeof settings.update === 'function'
  let settingsEntryId = null
  let settingsRevision

  /** This plugin's own Loader row id (the name-matched row whose fiber is ours). */
  function ownEntryId() {
    try {
      for (const entry of ctx.loader?.entries?.() ?? []) {
        const id = entry?.options?.id
        if (entry?.options?.name !== name || typeof id !== 'string' || id === '') continue
        if (entry.fiber === ctx.fiber) return id
      }
    } catch {
      /* the loader is not reachable from this context */
    }
    return null
  }

  /** `ctx.loader.await()` when this context can reach the Loader, else undefined. */
  function loaderSettled() {
    try {
      return ctx.loader?.await?.()
    } catch {
      return undefined
    }
  }

  /** Re-read the live preferences (and their revision) from the forms service. */
  function refreshConfig() {
    if (!settingsAvailable || settingsEntryId === null) return
    let row
    try {
      row = settings.describe().find((candidate) => candidate.ns === settingsEntryId)
    } catch (e) {
      lerr('settings.describe failed: ' + errorMessage(e))
      return
    }
    if (row === undefined) return
    settingsRevision = row.revision
    Object.assign(config, normalizeConfig(row.value))
  }

  if (settingsAvailable) {
    settingsEntryId = ownEntryId()
    if (settingsEntryId === null) {
      lerr('no Loader row for this package; preferences stay at their defaults')
    } else {
      if (!volatileSupported) {
        lerr('@deepseek-ai/schemastery < 3.18.5 has no .volatile(); preferences cannot be persisted')
      }
      // This plugin draws its own section, so the framework's generated form
      // for the same row would be a second, differently styled copy.
      try {
        ctx.effect(() => settings.configure({ auto: false }, ctx.fiber), 'dsh-keep-awake: settings page policy')
      } catch (e) {
        lerr('settings.configure failed: ' + errorMessage(e))
      }
    }
  } else if (settings !== undefined) {
    lerr('settings service has no forms API; preferences stay at their defaults')
  }

  // ------------------------------------------------------------------ probes

  /** Resolve the Windows PowerShell executable (known path first, then PATH). */
  function resolvePowershell() {
    if (helper.powershell !== undefined) return helper.powershell
    const found = existsSync(POWERSHELL_FALLBACK) ? POWERSHELL_FALLBACK : whichSync('powershell')
    helper.powershell = found
    if (found === null) lerr('powershell not found (known path + PATH scan)')
    return found
  }

  // ------------------------------------------------------------------ helper

  function buildArgv() {
    if (platform === 'win32') {
      const exe = resolvePowershell()
      if (exe === null) throw new Error('powershell not found')
      const flags = config.preventDisplaySleep ? 3 : 1
      return [exe, '-NoProfile', '-NonInteractive', '-Command', powershellScript(flags)]
    }
    if (platform === 'darwin') {
      return config.preventDisplaySleep
        ? ['/usr/bin/env', 'caffeinate', '-d', '-i', '-s']
        : ['/usr/bin/env', 'caffeinate', '-i', '-s']
    }
    if (platform === 'linux') {
      return [
        '/usr/bin/env', 'systemd-inhibit', '--what=idle', '--who=dsh-keep-awake',
        '--why=DSH agents running', '--mode=block', 'sleep', '100000000',
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
      holdingWakeLock: helper.state === 'on',
      // Persisted through the forms service? `revision` is the CAS token the
      // config route echoes back, null when the service is unavailable. A
      // non-volatile schema cannot be written at all (the loader rejects the
      // row), so it counts as not persistent even when the service is there.
      persistent: settingsAvailable && settingsEntryId !== null && volatileSupported,
      settingsEntryId,
      revision: settingsRevision ?? null,
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
    if (proc !== null) {
      try {
        // posix children are detached process-group leaders: kill the whole
        // group (env → systemd-inhibit/caffeinate → sleep survives a plain
        // kill). Windows: TerminateProcess on the single powershell process.
        if (platform !== 'win32' && typeof proc.pid === 'number') {
          try {
            process.kill(-proc.pid, 'SIGTERM')
          } catch {
            proc.kill('SIGTERM')
          }
        } else {
          proc.kill()
        }
      } catch {
        /* already gone */
      }
    }
  }

  function startHelper() {
    if (helper.starting) return
    helper.starting = true
    helper.startingSince = Date.now()
    helper.stopRequested = false
    helper.state = 'starting'
    helper.error = null
    let argv = null
    try {
      argv = buildArgv()
    } catch (e) {
      helper.starting = false
      helper.state = 'error'
      helper.error = errorMessage(e)
      lerr('helper argv failed: ' + errorMessage(e))
      return
    }
    if (argv === null) {
      helper.starting = false
      helper.state = 'error'
      helper.error = 'no helper for platform ' + platform
      lerr('helper argv null (platform=' + platform + ')')
      return
    }
    let proc
    try {
      proc = spawn(argv[0], argv.slice(1), {
        cwd: platform === 'win32' ? dirOf(argv[0]) : '/',
        stdio: ['ignore', 'ignore', 'pipe'],
        env: process.env,
        detached: platform !== 'win32',
      })
    } catch (e) {
      helper.starting = false
      helper.state = 'error'
      helper.error = errorMessage(e)
      lerr('helper spawn failed: ' + errorMessage(e))
      return
    }
    let errTail = ''
    proc.stderr.on('data', (chunk) => {
      errTail = (errTail + chunk.toString()).slice(-2048)
    })
    proc.on('error', (e) => {
      if (stopped || helper.proc !== proc) return
      helper.proc = null
      helper.pid = null
      helper.state = 'error'
      helper.error = errorMessage(e)
      lerr('helper process error: ' + errorMessage(e))
    })
    proc.on('exit', (code, signal) => {
      if (stopped || helper.proc !== proc) return
      helper.proc = null
      helper.pid = null
      helper.state = 'error'
      const tail = errTail.trim()
      helper.error = tail !== '' ? tail.slice(-500) : 'exit ' + (signal ?? String(code))
      lerr('helper exited unexpectedly: ' + helper.error)
    })
    if (helper.stopRequested) {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
      return
    }
    helper.proc = proc
    helper.pid = proc.pid ?? null
    helper.state = 'on'
    helper.starting = false
    helper.startingSince = 0
  }

  function evaluate() {
    // Watchdog: a spawn that stays 'starting' without a pid for 15s is marked
    // error so the next resync retries (e.g. a spawn that stalled waiting on
    // a context that never arrives).
    if (
      helper.state === 'starting' &&
      helper.pid === null &&
      helper.startingSince > 0 &&
      Date.now() - helper.startingSince > 15000
    ) {
      helper.state = 'error'
      helper.error = 'spawn stalled >15s; retrying'
      helper.startingSince = 0
      lerr('helper starting stalled >15s; marked error for retry')
    }
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
      // A grace countdown already running must not be re-armed here: resync
      // fires every POLL_MS, and disposing+re-arming would restart the full
      // grace window each tick so it would never expire.
      if (graceTimer !== null) return
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

  /**
   * Active background jobs across every owner.
   *
   * `jobs.list(caller)` is fenced by owner: it answers with the unowned bucket
   * plus the jobs whose owner id equals `caller`, so one live agent is one
   * call with its session id. An unscoped `list()` therefore reports only
   * unowned work — which is why the scan unions both.
   */
  function countLiveJobs(liveAgents) {
    if (jobs === undefined) return 0
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
      const caller = typeof a?.sessionId === 'string'
        ? a.sessionId
        : (typeof a?.id === 'string' ? a.id : undefined)
      if (caller === undefined) continue
      try {
        addList(jobs.list(caller))
      } catch {
        /* ignore */
      }
    }
    let live = 0
    for (const id of Object.keys(seen)) {
      const s = seen[id].status
      if (s === 'running' || s === 'stopping') live++
    }
    return live
  }

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
    try {
      liveJobs = countLiveJobs(liveAgents)
    } catch {
      /* jobs service raced its own teardown */
    }
    activity.runningAgents = runningAgents
    activity.liveJobs = liveJobs
    refreshConfig()
    evaluate()
  }

  // -------------------------------------------------------------------- web

  if (webServer !== undefined) {
    ctx.effect(() => {
      let disposed
      try {
        disposed = webServer.register({
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
        })
        return disposed
      } catch (e) {
        lerr('route register failed (' + STATE_ROUTE + '): ' + errorMessage(e))
        return () => {}
      }
    }, 'dsh-keep-awake: state route')

    ctx.effect(() => {
      let disposed
      try {
        disposed = webServer.register({
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
          const section = configPatch(body.section)
          if (Object.keys(section).length === 0) {
            throw new Error('config update named no known preference')
          }
          if (settingsAvailable && settingsEntryId !== null && volatileSupported) {
            const expected = Number.isInteger(body.revision) ? body.revision : undefined
            try {
              await settings.update(settingsEntryId, section, expected)
            } catch (e) {
              if (e instanceof Error && e.name === 'SettingsConflictError') {
                refreshConfig()
                resync()
                sendJson(res, 409, {
                  error: 'settings changed since this page loaded; reloading the live values',
                  ...snapshot(),
                })
                return
              }
              throw e
            }
          }
          Object.assign(config, section)
          refreshConfig()
          resync()
          sendJson(res, 200, snapshot())
        } catch (e) {
          sendJson(res, 400, { error: errorMessage(e) })
        }
      },
        })
        return disposed
      } catch (e) {
        lerr('route register failed (' + CONFIG_ROUTE + '): ' + errorMessage(e))
        return () => {}
      }
    }, 'dsh-keep-awake: config route')
  } else {
    lerr('webServer service missing; state/config routes NOT registered')
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
    // Job registry notifications: 0.2.x exposes `jobs.events` (a filtered
    // stream that fires on registration, stopping, settlement and removal);
    // older hosts exposed `jobs.onJobsChanged`. Either way the subscription is
    // only a wake-up — the count itself always comes from a fresh list scan.
    if (jobs !== undefined) {
      const onJobChange = () => {
        try {
          resync()
        } catch {
          /* listener */
        }
      }
      if (jobs.events !== undefined && typeof jobs.events.subscribe === 'function') {
        try {
          disposers.push(jobs.events.subscribe({ owners: 'all' }, (event) => {
            // Output appends and progress lines fire constantly; only ownership
            // changes matter to the wake lock.
            const type = event?.type
            if (type === 'output' || type === 'progress') return
            onJobChange()
          }))
        } catch (e) {
          // A rejected subscription must not take the plugin down: the poll
          // tick still resyncs every POLL_MS.
          lerr('jobs.events.subscribe failed: ' + errorMessage(e))
        }
      } else if (typeof jobs.onJobsChanged === 'function') {
        disposers.push(jobs.onJobsChanged(onJobChange))
      }
    }
    // A volatile-only settings write is committed into this fiber and announced
    // here; re-read the values so the wake lock follows the new preference.
    disposers.push(ctx.on('loader/volatile-update', () => {
      try {
        resync()
      } catch {
        /* listener */
      }
    }))
    if (platform === 'win32') resolvePowershell()
    // The forms service only projects the rows of ACTIVE plugins, so this
    // plugin's own row becomes readable once the Loader settles.
    Promise.resolve(loaderSettled()).then(() => {
      if (stopped) return
      try {
        resync()
      } catch (e) {
        lerr('post-load resync failed: ' + errorMessage(e))
      }
    }).catch(() => {
      /* loader unavailable: the polling tick still picks the values up */
    })
    try {
      resync()
    } catch (e) {
      lerr('initial resync failed: ' + errorMessage(e))
    }
    return () => {
      stopped = true
      for (const d of disposers) d()
      stopHelper()
    }
  })
}

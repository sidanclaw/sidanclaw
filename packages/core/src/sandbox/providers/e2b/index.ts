/**
 * E2BCloudProvider — the v1 `SandboxProvider` (§4.3): one task-scoped E2B
 * microVM hosting agent-browser + Python over a shared ephemeral scratch.
 * Structured as a pure adapter over the `E2bRuntime` wrapper (runtime.ts is
 * the only E2B-SDK importer); tests inject a fake runtime, and BYOC/self-host
 * later swap the runtime construction, not this file.
 *
 * Containment contracts implemented HERE (§4.7, §8):
 *  - runPython always executes under an unshared network namespace
 *    (`unshare -rn`) in isolated mode (`python3 -I`) — egress-denied by
 *    construction, fail-closed when the template lacks `unshare`.
 *  - No ambient secrets: nothing from the host env is forwarded into the
 *    sandbox; the only credential a sandbox ever sees is the session bundle
 *    the orchestrator explicitly injects.
 *  - The BYOP proxy hook (§4.6) is agent-browser's `-p` flag, wired but
 *    dormant (set per-create, never a pool).
 */
import {
  BrowserBackendError,
  type BrowserSnapshot,
  type RunPythonRequest,
  type RunPythonResult,
  type SandboxBridge,
  type SandboxBrowser,
  type SandboxCreateOptions,
  type SandboxHandle,
  type SandboxProvider,
  type SessionBundle,
  type TakeoverInputEvent,
} from '../../types.js'
import { cli, parseSnapshotOutput, sessionEnv } from './agent-browser-cli.js'
import type { E2bRuntime, E2bSandboxHandle } from './runtime.js'

export const SCRATCH_DIR = '/home/user/scratch'
export const DOWNLOADS_DIR = '/home/user/downloads'
/** agent-browser persists per-session state here (AGENT_BROWSER_SESSION_NAME). */
function sessionStatePath(sandboxId: string): string {
  return `/root/.agent-browser/sessions/sbx-${sandboxId}.json`
}

const DEFAULT_MAX_LIFETIME_SECONDS = 3600
const COMMAND_TIMEOUT_MS = 40_000
const PYTHON_DEFAULT_TIMEOUT_MS = 60_000
const MAX_DOWNLOAD_FILES = 20

export type E2bCloudProviderConfig = {
  templateId?: string
  defaultMaxLifetimeSeconds?: number
}

type PerSandbox = {
  proxyUrl?: string
  unshareChecked?: boolean
  pythonRunCounter: number
}

export function createE2bCloudProvider(
  runtime: E2bRuntime,
  config: E2bCloudProviderConfig = {},
): SandboxProvider {
  const perSandbox = new Map<string, PerSandbox>()
  const handles = new Map<string, E2bSandboxHandle>()

  function meta(sandboxId: string): PerSandbox {
    let m = perSandbox.get(sandboxId)
    if (!m) {
      m = { pythonRunCounter: 0 }
      perSandbox.set(sandboxId, m)
    }
    return m
  }

  async function handleFor(sandboxId: string): Promise<E2bSandboxHandle> {
    const cached = handles.get(sandboxId)
    if (cached) return cached
    const handle = await runtime.connect(sandboxId)
    handles.set(sandboxId, handle)
    return handle
  }

  async function runBrowserCommand(sandboxId: string, command: string): Promise<string> {
    const handle = await handleFor(sandboxId)
    const res = await handle.runCommand(command, {
      timeoutMs: COMMAND_TIMEOUT_MS,
      envs: sessionEnv(`sbx-${sandboxId}`),
    })
    if (res.exitCode !== 0) {
      const message = (res.stderr || res.stdout || 'agent-browser command failed').trim()
      const code = /not found|stale|unknown ref|no element/i.test(message) ? 'stale_ref' : 'backend_error'
      throw new BrowserBackendError(message.slice(0, 500), code)
    }
    return res.stdout
  }

  function browser(sandboxId: string): SandboxBrowser {
    return {
      navigate: async (url) => {
        const proxy = meta(sandboxId).proxyUrl
        const open = proxy ? `${cli.open(url)} -p '${proxy.replace(/'/g, '')}'` : cli.open(url)
        await runBrowserCommand(sandboxId, open)
        const current = (await runBrowserCommand(sandboxId, cli.getUrl())).trim()
        return { url: current || url }
      },
      snapshot: async (): Promise<BrowserSnapshot> => {
        const [raw, url, title] = [
          await runBrowserCommand(sandboxId, cli.snapshot()),
          (await runBrowserCommand(sandboxId, cli.getUrl())).trim(),
          (await runBrowserCommand(sandboxId, cli.getTitle())).trim(),
        ]
        return parseSnapshotOutput(raw, { url, title })
      },
      click: async (ref) => {
        await runBrowserCommand(sandboxId, cli.click(ref))
      },
      type: async (ref, text) => {
        await runBrowserCommand(sandboxId, cli.fill(ref, text))
      },
      currentUrl: async () => {
        const url = (await runBrowserCommand(sandboxId, cli.getUrl())).trim()
        const title = (await runBrowserCommand(sandboxId, cli.getTitle())).trim()
        return { url, title }
      },
      captureStorageState: async (site): Promise<SessionBundle> => {
        const handle = await handleFor(sandboxId)
        try {
          const bytes = await handle.readFile(sessionStatePath(sandboxId))
          const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
            cookies?: unknown[]
            origins?: Array<{ origin?: string; localStorage?: Array<{ name?: string; value?: string }> }>
          }
          const localStorage: Record<string, Record<string, string>> = {}
          for (const origin of parsed.origins ?? []) {
            if (!origin.origin) continue
            const kv: Record<string, string> = {}
            for (const item of origin.localStorage ?? []) {
              if (typeof item.name === 'string') kv[item.name] = item.value ?? ''
            }
            localStorage[origin.origin] = kv
          }
          return {
            site,
            cookies: parsed.cookies ?? [],
            localStorage: Object.keys(localStorage).length ? localStorage : undefined,
            capturedAt: new Date().toISOString(),
          }
        } catch (err) {
          throw new BrowserBackendError(
            `Could not capture the browser session state: ${err instanceof Error ? err.message : String(err)}`,
            'backend_error',
          )
        }
      },
      injectStorageState: async (bundle): Promise<void> => {
        // Must run BEFORE the first navigate in the sandbox — the daemon
        // reads its session file on start (the orchestrator guarantees the
        // ordering: connect → inject → browse).
        const handle = await handleFor(sandboxId)
        const origins = Object.entries(bundle.localStorage ?? {}).map(([origin, kv]) => ({
          origin,
          localStorage: Object.entries(kv).map(([name, value]) => ({ name, value })),
        }))
        const state = JSON.stringify({ cookies: bundle.cookies, origins })
        await handle.runCommand(`mkdir -p /root/.agent-browser/sessions`, { timeoutMs: 10_000 })
        await handle.writeFile(sessionStatePath(sandboxId), new TextEncoder().encode(state))
      },
      takeover: () => {
        let closed = false
        let frameCounter = 0
        return {
          nextFrame: async () => {
            if (closed) return null
            const framePath = `/tmp/takeover-frame-${frameCounter++ % 2}.png`
            await runBrowserCommand(sandboxId, cli.screenshot(framePath))
            const handle = await handleFor(sandboxId)
            const bytes = await handle.readFile(framePath)
            return { data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }
          },
          input: async (event: TakeoverInputEvent) => {
            if (closed) return
            if (event.kind === 'click') {
              await runBrowserCommand(sandboxId, cli.clickAt(event.x, event.y))
            } else if (event.kind === 'key') {
              await runBrowserCommand(sandboxId, cli.press(event.text))
            } else {
              await runBrowserCommand(sandboxId, cli.scrollBy(event.deltaY))
            }
          },
          close: async () => {
            closed = true
          },
        }
      },
    }
  }

  const bridge: SandboxBridge = {
    load: async (sandboxId, params) => {
      const handle = await handleFor(sandboxId)
      const path = params.path.startsWith('/') ? params.path : `${SCRATCH_DIR}/${params.path}`
      await handle.runCommand(`mkdir -p ${SCRATCH_DIR} ${DOWNLOADS_DIR}`, { timeoutMs: 10_000 })
      await handle.writeFile(path, params.bytes)
      return { path }
    },
    save: async (sandboxId, params) => {
      const handle = await handleFor(sandboxId)
      const path = params.path.startsWith('/') ? params.path : `${SCRATCH_DIR}/${params.path}`
      return { bytes: await handle.readFile(path) }
    },
    pullDownloads: async (sandboxId) => {
      const handle = await handleFor(sandboxId)
      let entries: Array<{ name: string; path: string; isDir: boolean }>
      try {
        entries = await handle.listDir(DOWNLOADS_DIR)
      } catch {
        return [] // no downloads dir → nothing downloaded
      }
      const files = entries.filter((e) => !e.isDir).slice(0, MAX_DOWNLOAD_FILES)
      const out: Array<{ path: string; bytes: Uint8Array }> = []
      for (const file of files) {
        out.push({ path: file.path, bytes: await handle.readFile(file.path) })
      }
      return out
    },
  }

  return {
    name: 'e2b-cloud',

    async create(opts: SandboxCreateOptions): Promise<SandboxHandle> {
      const handle = await runtime.create({
        templateId: config.templateId,
        timeoutMs: (opts.maxLifetimeSeconds ?? config.defaultMaxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS) * 1000,
        metadata: {
          workspaceId: opts.workspaceId,
          taskId: opts.taskId,
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.egressAllowlist?.length ? { egressAllowlist: opts.egressAllowlist.join(',') } : {}),
        },
        // The browser must reach its target site; python isolation never
        // relies on this flag (unshare -rn below).
        allowInternetAccess: true,
      })
      handles.set(handle.id, handle)
      if (opts.proxyUrl) meta(handle.id).proxyUrl = opts.proxyUrl
      return { sandboxId: handle.id }
    },

    async connect(sandboxId: string): Promise<SandboxHandle> {
      await handleFor(sandboxId)
      return { sandboxId }
    },

    async pause(sandboxId: string): Promise<void> {
      const handle = await handleFor(sandboxId)
      await handle.pause()
      handles.delete(sandboxId) // a paused handle must reconnect
    },

    async resume(sandboxId: string): Promise<void> {
      handles.delete(sandboxId)
      await handleFor(sandboxId) // connect resumes transparently
    },

    async kill(sandboxId: string): Promise<void> {
      try {
        const handle = await handleFor(sandboxId)
        await handle.kill()
      } finally {
        handles.delete(sandboxId)
        perSandbox.delete(sandboxId)
      }
    },

    browser,

    async runPython(sandboxId: string, req: RunPythonRequest): Promise<RunPythonResult> {
      const handle = await handleFor(sandboxId)
      const m = meta(sandboxId)
      if (!m.unshareChecked) {
        // Fail-closed egress contract: no unshare → refuse to run at all.
        const probe = await handle.runCommand('command -v unshare', { timeoutMs: 10_000 })
        if (probe.exitCode !== 0) {
          throw new Error(
            'Python isolation unavailable: the sandbox template lacks `unshare`, so egress-denied execution cannot be guaranteed. Refusing to run.',
          )
        }
        m.unshareChecked = true
      }
      m.pythonRunCounter += 1
      const scriptPath = `${SCRATCH_DIR}/.exec-${m.pythonRunCounter}.py`
      await handle.runCommand(`mkdir -p ${SCRATCH_DIR}`, { timeoutMs: 10_000 })
      await handle.writeFile(scriptPath, new TextEncoder().encode(req.code))
      // -rn = new user+net namespace (loopback only, no egress); -I = isolated
      // python (no env vars, no user site-packages beyond the baked template).
      const res = await handle.runCommand(
        `cd ${SCRATCH_DIR} && unshare -rn python3 -I ${scriptPath}`,
        { timeoutMs: req.timeoutMs ?? PYTHON_DEFAULT_TIMEOUT_MS },
      )
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode }
    },

    bridge,
  }
}

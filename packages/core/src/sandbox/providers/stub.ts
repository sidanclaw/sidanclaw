/**
 * In-memory `SandboxProvider` — the seam-swap proof (§4.3) and the unit-test
 * backend. Everything the orchestrator/tools do against E2B works against
 * this with zero code change; tests also use its call recording to assert
 * containment contracts (egress config, storage-state injection, kills).
 */
import type {
  BrowserNavigateResult,
  BrowserSnapshot,
  BrowserUrlResult,
  RunPythonRequest,
  RunPythonResult,
  SandboxBrowser,
  SandboxCreateOptions,
  SandboxHandle,
  SandboxProvider,
  SessionBundle,
  TakeoverFrame,
  TakeoverInputEvent,
} from '../types.js'

type StubSandboxState = {
  id: string
  options: SandboxCreateOptions
  status: 'running' | 'paused' | 'killed'
  url: string
  title: string
  snapshot: BrowserSnapshot
  injectedBundles: SessionBundle[]
  scratch: Map<string, Uint8Array>
  downloads: Array<{ path: string; bytes: Uint8Array }>
  actions: Array<{ op: string; args: Record<string, unknown> }>
  pythonRuns: RunPythonRequest[]
}

export type StubSandboxProviderOptions = {
  /** Snapshot served for any page until a test overrides it. */
  defaultSnapshot?: BrowserSnapshot
  /** Scripted python results, consumed in order (defaults to empty success). */
  pythonResults?: RunPythonResult[]
  /** When true, navigation login-walls UNLESS a session bundle was injected (§4.4 reuse tests). */
  loginWall?: boolean
  /** When true, navigation login-walls even with an injected bundle (silent-death probe tests). */
  loginWallAlways?: boolean
}

const EMPTY_SNAPSHOT: BrowserSnapshot = { url: 'about:blank', title: '', nodes: [] }

export class StubSandboxProvider implements SandboxProvider {
  readonly name = 'stub'
  readonly sandboxes = new Map<string, StubSandboxState>()
  private counter = 0
  private readonly opts: StubSandboxProviderOptions

  constructor(opts: StubSandboxProviderOptions = {}) {
    this.opts = opts
  }

  private must(sandboxId: string): StubSandboxState {
    const s = this.sandboxes.get(sandboxId)
    if (!s) throw new Error(`stub: unknown sandbox ${sandboxId}`)
    if (s.status === 'killed') throw new Error(`stub: sandbox ${sandboxId} is killed`)
    return s
  }

  async create(options: SandboxCreateOptions): Promise<SandboxHandle> {
    const id = `stub-sbx-${++this.counter}`
    this.sandboxes.set(id, {
      id,
      options,
      status: 'running',
      url: 'about:blank',
      title: '',
      snapshot: this.opts.defaultSnapshot ?? EMPTY_SNAPSHOT,
      injectedBundles: [],
      scratch: new Map(),
      downloads: [],
      actions: [],
      pythonRuns: [],
    })
    return { sandboxId: id }
  }

  async connect(sandboxId: string): Promise<SandboxHandle> {
    const s = this.must(sandboxId)
    if (s.status === 'paused') s.status = 'running'
    return { sandboxId }
  }

  async pause(sandboxId: string): Promise<void> {
    this.must(sandboxId).status = 'paused'
  }

  async resume(sandboxId: string): Promise<void> {
    this.must(sandboxId).status = 'running'
  }

  async kill(sandboxId: string): Promise<void> {
    const s = this.sandboxes.get(sandboxId)
    if (s) s.status = 'killed'
  }

  /** Test hook: set the page the sandbox browser reports. */
  setPage(sandboxId: string, page: { url: string; title?: string; snapshot?: BrowserSnapshot }): void {
    const s = this.must(sandboxId)
    s.url = page.url
    s.title = page.title ?? s.title
    if (page.snapshot) s.snapshot = page.snapshot
  }

  browser(sandboxId: string): SandboxBrowser {
    const state = () => this.must(sandboxId)
    const loginWall = () =>
      this.opts.loginWallAlways === true ||
      (this.opts.loginWall === true && state().injectedBundles.length === 0)
    return {
      navigate: async (url: string): Promise<BrowserNavigateResult> => {
        const s = state()
        s.actions.push({ op: 'navigate', args: { url } })
        s.url = loginWall() ? loginWallUrl(url) : url
        return { url: s.url }
      },
      snapshot: async (): Promise<BrowserSnapshot> => {
        const s = state()
        s.actions.push({ op: 'snapshot', args: {} })
        return { ...s.snapshot, url: s.url, title: s.title }
      },
      click: async (ref: string): Promise<void> => {
        state().actions.push({ op: 'click', args: { ref } })
      },
      type: async (ref: string, text: string): Promise<void> => {
        state().actions.push({ op: 'type', args: { ref, text } })
      },
      currentUrl: async (): Promise<BrowserUrlResult> => {
        const s = state()
        return { url: s.url, title: s.title }
      },
      captureStorageState: async (site: string): Promise<SessionBundle> => {
        const s = state()
        s.actions.push({ op: 'captureStorageState', args: { site } })
        return {
          site,
          cookies: [{ name: 'stub-session', value: `cookie-for-${site}`, domain: site }],
          capturedAt: new Date().toISOString(),
        }
      },
      injectStorageState: async (bundle: SessionBundle): Promise<void> => {
        const s = state()
        s.actions.push({ op: 'injectStorageState', args: { site: bundle.site } })
        s.injectedBundles.push(bundle)
      },
      takeover: () => {
        const frames: TakeoverFrame[] = [{ data: 'c3R1Yi1mcmFtZQ==', mimeType: 'image/png' }]
        const inputs: TakeoverInputEvent[] = []
        let closed = false
        state().actions.push({ op: 'takeover', args: {} })
        return {
          nextFrame: async () => (closed ? null : (frames.shift() ?? null)),
          input: async (event: TakeoverInputEvent) => {
            inputs.push(event)
            state().actions.push({ op: 'takeoverInput', args: { kind: event.kind } })
          },
          close: async () => {
            closed = true
          },
        }
      },
    }
  }

  async runPython(sandboxId: string, req: RunPythonRequest): Promise<RunPythonResult> {
    const s = this.must(sandboxId)
    s.pythonRuns.push(req)
    // The containment contract lives in the E2B impl (interpreter created with
    // networking off). The stub mimics the observable behavior: any socket use
    // fails as if egress were denied.
    if (/\b(socket|urllib|requests|http\.client|httpx)\b/.test(req.code)) {
      return {
        stdout: '',
        stderr: 'OSError: [Errno 101] Network is unreachable (egress denied)',
        exitCode: 1,
      }
    }
    const scripted = this.opts.pythonResults?.shift()
    return scripted ?? { stdout: '', stderr: '', exitCode: 0 }
  }

  readonly bridge = {
    load: async (sandboxId: string, params: { path: string; bytes: Uint8Array }) => {
      this.must(sandboxId).scratch.set(params.path, params.bytes)
      return { path: params.path }
    },
    save: async (sandboxId: string, params: { path: string }) => {
      const bytes = this.must(sandboxId).scratch.get(params.path)
      if (!bytes) throw new Error(`stub: no scratch file at ${params.path}`)
      return { bytes }
    },
    pullDownloads: async (sandboxId: string) => {
      return this.must(sandboxId).downloads
    },
  }

  /** Test hook: place a fake browser download in the scratch downloads dir. */
  addDownload(sandboxId: string, path: string, bytes: Uint8Array): void {
    this.must(sandboxId).downloads.push({ path, bytes })
  }
}

function loginWallUrl(target: string): string {
  try {
    const u = new URL(target)
    return `${u.origin}/login?next=${encodeURIComponent(u.pathname)}`
  } catch {
    return 'about:blank#login'
  }
}

/**
 * agent-browser CLI glue (§4.11): the deterministic strings the E2B provider
 * runs INSIDE the sandbox, and the parser for what comes back. Provider-
 * internal — the model never sees or emits these; it only calls the discrete
 * browser tools. Keeping every verb here means a CLI change is a one-file
 * template-version bump.
 *
 * Verb vocabulary matches the agent-browser CLI (`open`, `snapshot -i`,
 * `click @eN`, `fill @eN <text>`, `get url`, `get title`, `screenshot`,
 * `press`, `close`); the daemon auto-starts on first use and persists
 * per-session state under AGENT_BROWSER_SESSION_NAME.
 */
import type { BrowserSnapshot, BrowserSnapshotNode } from '../../types.js'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

const AGENT_BROWSER_BIN = 'agent-browser'

/** One agent-browser session per sandbox — the task's browsing identity. */
export function sessionEnv(sessionName: string): Record<string, string> {
  return { AGENT_BROWSER_SESSION_NAME: sessionName }
}

export const cli = {
  open(url: string): string {
    return `${AGENT_BROWSER_BIN} open ${shellQuote(url)}`
  },
  snapshot(): string {
    // -i = interactive elements with @e refs (the token-cheap a11y list).
    return `${AGENT_BROWSER_BIN} snapshot -i`
  },
  click(ref: string): string {
    return `${AGENT_BROWSER_BIN} click ${shellQuote(ref)}`
  },
  fill(ref: string, text: string): string {
    return `${AGENT_BROWSER_BIN} fill ${shellQuote(ref)} ${shellQuote(text)}`
  },
  getUrl(): string {
    return `${AGENT_BROWSER_BIN} get url`
  },
  getTitle(): string {
    return `${AGENT_BROWSER_BIN} get title`
  },
  screenshot(path: string): string {
    return `${AGENT_BROWSER_BIN} screenshot ${shellQuote(path)}`
  },
  press(key: string): string {
    return `${AGENT_BROWSER_BIN} press ${shellQuote(key)}`
  },
  /** Coordinate click for the Take-Over input relay (element under point). */
  clickAt(x: number, y: number): string {
    const js = `document.elementFromPoint(${Math.round(x)}, ${Math.round(y)})?.click()`
    return `${AGENT_BROWSER_BIN} eval ${shellQuote(js)}`
  },
  scrollBy(deltaY: number): string {
    const js = `window.scrollBy(0, ${Math.round(deltaY)})`
    return `${AGENT_BROWSER_BIN} eval ${shellQuote(js)}`
  },
  close(): string {
    return `${AGENT_BROWSER_BIN} close`
  },
}

/**
 * Parse `snapshot -i` output into the shared BrowserSnapshot node shape.
 * Tolerates both output styles:
 *   - JSON (`--json`-style object with a nodes/elements array)
 *   - the human text list, one element per line:
 *       `@e1 button "Send"` / `- @e2 link "Jane Doe" [disabled]`
 * Unknown lines are skipped — the parser must never throw on real pages.
 */
export function parseSnapshotOutput(raw: string, page: { url: string; title: string }): BrowserSnapshot {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : ((parsed as { nodes?: unknown[]; elements?: unknown[] }).nodes ??
           (parsed as { elements?: unknown[] }).elements ??
           [])
      const nodes: BrowserSnapshotNode[] = []
      for (const item of list) {
        const o = item as { ref?: unknown; role?: unknown; name?: unknown; label?: unknown; value?: unknown; disabled?: unknown }
        if (typeof o.ref !== 'string' || o.ref.length === 0) continue
        nodes.push({
          ref: o.ref.startsWith('@') ? o.ref : `@${o.ref}`,
          role: typeof o.role === 'string' ? o.role : 'node',
          name: typeof o.name === 'string' ? o.name : typeof o.label === 'string' ? o.label : '',
          ...(typeof o.value === 'string' && o.value ? { value: o.value } : {}),
          ...(o.disabled === true ? { disabled: true } : {}),
        })
      }
      return { url: page.url, title: page.title, nodes }
    } catch {
      // fall through to line parsing
    }
  }

  const LINE = /^[-*\s]*(@e\d+)\s+([\w-]+)\s+"((?:[^"\\]|\\.)*)"(?:\s+value="((?:[^"\\]|\\.)*)")?(.*)$/
  const nodes: BrowserSnapshotNode[] = []
  for (const line of trimmed.split('\n')) {
    const m = LINE.exec(line.trim())
    if (!m) continue
    const [, ref, role, name, value, tail] = m
    nodes.push({
      ref,
      role,
      name: name.replace(/\\"/g, '"'),
      ...(value ? { value: value.replace(/\\"/g, '"') } : {}),
      ...(/\[disabled\]/.test(tail ?? '') ? { disabled: true } : {}),
    })
  }
  return { url: page.url, title: page.title, nodes }
}

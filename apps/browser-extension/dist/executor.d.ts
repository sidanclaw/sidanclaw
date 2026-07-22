/**
 * CDP executor (P1.5/P1.6): implements the discrete browser ops against the
 * one user-allowed tab via chrome.debugger. Refs resolve against the LATEST
 * snapshot only — anything older returns `stale_ref` and the agent must
 * re-snapshot.
 */
import { type BuiltSnapshot } from './snapshot.js';
export declare class ExecutorError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
/**
 * True when Chrome is telling us the CDP session is gone. Chrome reports this
 * as a plain Error whose message is the only signal — there is no code on it,
 * which is why every one of these surfaced as `backend_error` in prod.
 */
export declare function isDetachedError(err: unknown): boolean;
/**
 * Whether an op may be replayed after a transparent re-attach.
 *
 * A detach can land *after* the input event was already delivered to the page,
 * so replaying `click`/`type` risks a double submit — on a registration form
 * that is a real, user-visible mistake. Read-only ops and `navigate` (which
 * lands on the same URL) are safe to redo.
 */
export declare function retryableAfterReattach(op: string): boolean;
export declare class TabExecutor {
    private attachedTabId;
    private lastSnapshot;
    attach(tabId: number): Promise<void>;
    detach(): Promise<void>;
    attachedTab(): number | null;
    /**
     * Chrome took the debugger away (banner cancelled, tab crashed, DevTools
     * opened). Forget the attachment so the next op re-attaches instead of
     * issuing CDP calls into a dead session forever — `attach()` short-circuits
     * on the cached id, so without this the executor never recovers.
     *
     * Returns true when the detach was for the tab we were driving.
     */
    onDetached(tabId: number): boolean;
    /**
     * Every CDP call goes through here so a lost session is self-healing: the
     * stale attachment is dropped and the failure carries the `detached` code
     * with an actionable message rather than a raw Chrome string.
     */
    private cdp;
    /** Accessible name of a ref from the latest snapshot (approval previews ride this server-side too). */
    refName(ref: string): string | null;
    private mustTab;
    private resolveRef;
    navigate(url: string): Promise<{
        url: string;
    }>;
    snapshot(): Promise<{
        url: string;
        title: string;
        nodes: BuiltSnapshot['nodes'];
    }>;
    click(ref: string): Promise<void>;
    type(ref: string, text: string): Promise<void>;
    currentUrl(): Promise<{
        url: string;
        title: string;
    }>;
}
//# sourceMappingURL=executor.d.ts.map
/**
 * Per-task consent + stop state (P1.7): the extension acts only in a tab the
 * user explicitly allowed for the current task, and a persistent Stop kills
 * everything in flight. Consent expires after inactivity so a forgotten
 * pairing can't act days later without a fresh allow.
 */
export declare const CONSENT_IDLE_RESET_MS: number;
export declare const CONSENT_PROMPT_TIMEOUT_MS = 60000;
export type ConsentPrompter = () => Promise<{
    allowed: boolean;
    tabId: number | null;
}>;
export declare class TaskGate {
    private allowedTabId;
    private stopped;
    private lastCommandAt;
    private promptInFlight;
    private readonly prompt;
    private readonly now;
    constructor(opts: {
        prompt: ConsentPrompter;
        now?: () => number;
    });
    /**
     * Resolve the tab this command may act in. Prompts the user (once —
     * concurrent commands share the prompt) when no live consent exists.
     * Throws coded errors the command loop returns verbatim.
     */
    requireTab(): Promise<number>;
    /**
     * Drop consent without latching Stop, so the next command asks again.
     *
     * For refusals that came from Chrome's own debugging banner rather than our
     * UI: honouring them means not silently re-attaching, but `stop()` would be
     * disproportionate — it has no resume path, so one stray click would kill
     * browsing for the rest of the session.
     */
    revokeConsent(): void;
    /** The persistent Stop: latches until the user allows a new task. */
    stop(): void;
    /** Tab-closed housekeeping. Returns true when the closed tab was the controlled one. */
    onTabRemoved(tabId: number): boolean;
    currentTab(): number | null;
    isStopped(): boolean;
}
//# sourceMappingURL=task-gate.d.ts.map
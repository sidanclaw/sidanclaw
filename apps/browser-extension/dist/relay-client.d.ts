/**
 * The extension's relay connection (P1.2): one WebSocket, hello on open,
 * ping every 30 s, reconnect with backoff + re-hello on drop. WebSocket
 * construction and token storage are injected so the state machine is
 * unit-testable outside Chrome.
 */
import { type ExtensionToRelay } from './protocol.js';
export type WebSocketLike = {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((ev?: unknown) => void) | null;
    onmessage: ((ev: {
        data: unknown;
    }) => void) | null;
    onclose: ((ev?: unknown) => void) | null;
    onerror: ((ev?: unknown) => void) | null;
};
export type RelayClientDeps = {
    /** Resolved per connection attempt (popup can re-configure without a new client). */
    getUrl: () => Promise<string | null>;
    connect: (url: string) => WebSocketLike;
    /** Session token preferred; falls back to the one-shot pairing token. */
    getToken: () => Promise<string | null>;
    /** Persist the session token the relay hands back in ready. */
    onSessionToken: (token: string) => Promise<void>;
    onCommand: (cmd: {
        id: string;
        op: string;
        args: Record<string, unknown>;
    }) => void;
    onStateChange?: (state: RelayClientState) => void;
    /** Injected timers so tests can drive time. */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
};
export type RelayClientState = 'disconnected' | 'connecting' | 'ready' | 'unpaired';
/** Backoff schedule for reconnects; stays at the last step. */
export declare const BACKOFF_STEPS_MS: readonly [1000, 2000, 5000, 10000, 30000];
export declare class RelayClient {
    private deps;
    private ws;
    private state;
    private attempts;
    private pingTimer;
    private reconnectTimer;
    private enabled;
    constructor(deps: RelayClientDeps);
    getState(): RelayClientState;
    private setState;
    private setTimer;
    private clearTimer;
    /** Turn the connection on (popup enable toggle / boot with stored token). */
    start(): void;
    /** Turn it off (disable toggle / unpair). */
    stop(): void;
    send(message: ExtensionToRelay): void;
    sendResult(result: {
        id: string;
        ok: boolean;
        data?: unknown;
        error?: string;
        code?: string;
    }): void;
    sendEvent(kind: 'stopped' | 'tab_closed' | 'detached'): void;
    private open;
    private schedulePing;
    private scheduleReconnect;
}
//# sourceMappingURL=relay-client.d.ts.map
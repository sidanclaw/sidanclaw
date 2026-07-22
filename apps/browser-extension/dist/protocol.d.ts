/**
 * Extension side of the relay wire protocol (P1.2). Mirror image of
 * apps/browser-relay/src/protocol.ts — keep in sync (the relay
 * zod-validates every inbound frame; the extension validates shape-lite
 * here because it ships without zod).
 */
type HelloMessage = {
    type: 'hello';
    pairingToken: string;
};
type ResultMessage = {
    type: 'result';
    id: string;
    ok: boolean;
    data?: unknown;
    error?: string;
    code?: string;
};
type EventKind = 'stopped' | 'tab_closed' | 'detached';
type EventMessage = {
    type: 'event';
    kind: EventKind;
};
type PingMessage = {
    type: 'ping';
};
export type ExtensionToRelay = HelloMessage | ResultMessage | EventMessage | PingMessage;
type ReadyMessage = {
    type: 'ready';
    sessionToken?: string;
};
type CommandMessage = {
    type: 'command';
    id: string;
    op: string;
    args: Record<string, unknown>;
};
type PongMessage = {
    type: 'pong';
};
type ErrorMessage = {
    type: 'error';
    message: string;
};
export type RelayToExtension = ReadyMessage | CommandMessage | PongMessage | ErrorMessage;
export declare function parseRelayMessage(raw: unknown): RelayToExtension | null;
export {};
//# sourceMappingURL=protocol.d.ts.map
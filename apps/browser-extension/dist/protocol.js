/**
 * Extension side of the relay wire protocol (P1.2). Mirror image of
 * apps/browser-relay/src/protocol.ts — keep in sync (the relay
 * zod-validates every inbound frame; the extension validates shape-lite
 * here because it ships without zod).
 */
export function parseRelayMessage(raw) {
    if (typeof raw !== 'string')
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object')
        return null;
    const type = parsed.type;
    if (type === 'ready' || type === 'pong' || type === 'error')
        return parsed;
    if (type === 'command') {
        const c = parsed;
        if (typeof c.id === 'string' && typeof c.op === 'string') {
            return { type: 'command', id: c.id, op: c.op, args: c.args ?? {} };
        }
    }
    return null;
}
//# sourceMappingURL=protocol.js.map
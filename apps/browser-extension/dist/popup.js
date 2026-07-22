"use strict";
/** Popup UI: connect/disconnect the relay pairing + the persistent Stop (P1.7). */
function el(id) {
    const node = document.getElementById(id);
    if (!node)
        throw new Error(`missing #${id}`);
    return node;
}
const statusBox = el('status');
const statusText = el('status-text');
const relayUrlInput = el('relay-url');
const tokenInput = el('pairing-token');
const STATE_LABELS = {
    ready: 'Connected. The assistant can request browser tasks.',
    connecting: 'Connecting to the relay...',
    disconnected: 'Disconnected. Reconnecting automatically.',
    unpaired: 'Not paired. Paste a pairing token from Use Brian settings.',
};
async function refreshStatus() {
    const status = (await chrome.runtime.sendMessage({ type: 'status' }));
    const state = status?.state ?? 'unpaired';
    statusBox.classList.toggle('ready', state === 'ready');
    const suffix = status?.controlledTab != null ? ' Controlling one allowed tab.' : '';
    statusText.textContent = `${STATE_LABELS[state] ?? state}${suffix}`;
}
async function loadStored() {
    const stored = await chrome.storage.local.get(['relayUrl']);
    if (typeof stored.relayUrl === 'string')
        relayUrlInput.value = stored.relayUrl;
}
el('connect').addEventListener('click', () => {
    void (async () => {
        await chrome.runtime.sendMessage({
            type: 'configure',
            relayUrl: relayUrlInput.value.trim(),
            pairingToken: tokenInput.value.trim() || undefined,
        });
        tokenInput.value = '';
        setTimeout(() => void refreshStatus(), 400);
    })();
});
el('disconnect').addEventListener('click', () => {
    void (async () => {
        await chrome.runtime.sendMessage({ type: 'disconnect' });
        await refreshStatus();
    })();
});
el('stop').addEventListener('click', () => {
    void (async () => {
        await chrome.runtime.sendMessage({ type: 'stop-task' });
        await refreshStatus();
    })();
});
void loadStored();
void refreshStatus();
setInterval(() => void refreshStatus(), 2_000);
//# sourceMappingURL=popup.js.map
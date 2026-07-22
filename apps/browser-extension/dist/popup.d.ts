/** Popup UI: connect/disconnect the relay pairing + the persistent Stop (P1.7). */
declare function el<T extends HTMLElement>(id: string): T;
declare const statusBox: HTMLDivElement;
declare const statusText: HTMLSpanElement;
declare const relayUrlInput: HTMLInputElement;
declare const tokenInput: HTMLInputElement;
declare const STATE_LABELS: Record<string, string>;
declare function refreshStatus(): Promise<void>;
declare function loadStored(): Promise<void>;
//# sourceMappingURL=popup.d.ts.map
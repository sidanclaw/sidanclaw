/**
 * Ref-based accessibility snapshot builder (P1.5): CDP
 * `Accessibility.getFullAXTree` nodes → the `@eN role "name"` interactive
 * list the agent acts on. Shape mirrors agent-browser so the cloud backend
 * matches (spec §3 browserSnapshot). Pure — unit-tested without Chrome.
 */
/**
 * Roles the agent can act on. CDP AX roles come from Chromium's internal
 * role names (lowercased here for matching).
 */
const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'textfield',
    'textfieldwithcombobox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'switch',
    'slider',
    'spinbutton',
    'option',
    'listboxoption',
    'popupbutton',
]);
function asString(v) {
    return typeof v === 'string' ? v : '';
}
function propTrue(node, name) {
    return (node.properties?.some((p) => p.name === name && p.value?.value === true) ?? false);
}
/**
 * Build the interactive-node list. Includes nodes whose role is interactive,
 * plus focusable nodes that carry a name (covers contenteditable message
 * boxes that report generic roles). Skips ignored/nameless-noise nodes.
 */
export function buildSnapshot(axNodes) {
    const nodes = [];
    const refToBackendNodeId = new Map();
    const refToName = new Map();
    let counter = 0;
    for (const ax of axNodes) {
        if (ax.ignored)
            continue;
        if (typeof ax.backendDOMNodeId !== 'number')
            continue;
        const role = asString(ax.role?.value).toLowerCase();
        const name = asString(ax.name?.value).trim();
        const interactive = INTERACTIVE_ROLES.has(role) || (propTrue(ax, 'focusable') && name.length > 0);
        if (!interactive)
            continue;
        if (name.length === 0 && !INTERACTIVE_ROLES.has(role))
            continue;
        counter += 1;
        const ref = `@e${counter}`;
        const value = asString(ax.value?.value);
        const node = {
            ref,
            role: role || 'node',
            name,
            ...(value ? { value } : {}),
            ...(propTrue(ax, 'disabled') ? { disabled: true } : {}),
        };
        nodes.push(node);
        refToBackendNodeId.set(ref, ax.backendDOMNodeId);
        refToName.set(ref, name);
    }
    return { nodes, refToBackendNodeId, refToName };
}
//# sourceMappingURL=snapshot.js.map
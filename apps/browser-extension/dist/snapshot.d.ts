/**
 * Ref-based accessibility snapshot builder (P1.5): CDP
 * `Accessibility.getFullAXTree` nodes → the `@eN role "name"` interactive
 * list the agent acts on. Shape mirrors agent-browser so the cloud backend
 * matches (spec §3 browserSnapshot). Pure — unit-tested without Chrome.
 */
/** The slice of a CDP AXNode this builder reads. */
export type CdpAXNode = {
    nodeId: string;
    ignored?: boolean;
    role?: {
        value?: unknown;
    };
    name?: {
        value?: unknown;
    };
    value?: {
        value?: unknown;
    };
    backendDOMNodeId?: number;
    properties?: Array<{
        name?: string;
        value?: {
            value?: unknown;
        };
    }>;
};
type SnapshotNode = {
    ref: string;
    role: string;
    name: string;
    value?: string;
    disabled?: boolean;
};
export type BuiltSnapshot = {
    nodes: SnapshotNode[];
    /** ref → backendDOMNodeId, for click/type targeting. Valid for this snapshot only. */
    refToBackendNodeId: Map<string, number>;
    /** ref → accessible name, kept for audit/approval previews. */
    refToName: Map<string, string>;
};
/**
 * Build the interactive-node list. Includes nodes whose role is interactive,
 * plus focusable nodes that carry a name (covers contenteditable message
 * boxes that report generic roles). Skips ignored/nameless-noise nodes.
 */
export declare function buildSnapshot(axNodes: CdpAXNode[]): BuiltSnapshot;
export {};
//# sourceMappingURL=snapshot.d.ts.map
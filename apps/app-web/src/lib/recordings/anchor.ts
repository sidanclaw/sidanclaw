/**
 * The page → recording link.
 *
 * A synthesized brief is a `saved_views` row whose `anchor_key` is
 * `recording-synthesis:<recordingId>` (set by the synthesis run so a re-run
 * converges on the same page). That key is the ONLY thing tying a brief back to
 * the recording it was written from — which is what lets the doc shell mount a
 * player and turn the page's `[H:MM:SS]` citations into seek links.
 *
 * Kept as one exported helper so the prefix is written once; the synthesizer
 * builds the same string server-side (`recording-synthesis:${recordingId}`).
 */

const RECORDING_SYNTHESIS_PREFIX = "recording-synthesis:";

/** The recording a page was synthesized from, or null for any other page. */
export function recordingIdFromAnchorKey(anchorKey: string | null | undefined): string | null {
  if (!anchorKey?.startsWith(RECORDING_SYNTHESIS_PREFIX)) return null;
  const id = anchorKey.slice(RECORDING_SYNTHESIS_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

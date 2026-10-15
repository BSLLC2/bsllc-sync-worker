/**
 * The events the dashboard asks a client's site to send, and the name of the
 * custom dimension that carries the section label.
 *
 * MIRRORED from the app's `shared/seo-ux-events.ts` (`PACK_EVENTS`,
 * `SECTION_DIMENSION`). `npm run verify:wiring` there compares the names in both
 * directions, so a name added on one side only fails the run. Nothing outside this
 * list is read, so a site that fires its own `quote_click` is invisible until it is
 * renamed or added here and there on purpose.
 */
export const PACK_EVENT_NAMES: readonly string[] = [
  "page_view",
  "cta_click",
  "form_start",
  "form_submit",
  "scroll_25",
  "scroll_50",
  "scroll_75",
  "scroll_90",
  "section_view",
];
export const SECTION_PARAM = "section";
export const SECTION_DIMENSION = `customEvent:${SECTION_PARAM}`;

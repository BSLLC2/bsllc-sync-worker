/** GA4 Data API filter builders. Pure. The only place a filter's JSON shape is written down. */
export type Filter = Record<string, unknown>;

export const eq = (fieldName: string, value: string): Filter => ({ filter: { fieldName, stringFilter: { matchType: "EXACT", value } } });
export const begins = (fieldName: string, value: string): Filter => ({ filter: { fieldName, stringFilter: { matchType: "BEGINS_WITH", value } } });
export const inList = (fieldName: string, values: readonly string[]): Filter => ({ filter: { fieldName, inListFilter: { values: [...values] } } });
export const not = (f: Filter): Filter => ({ notExpression: f });

export function and(...parts: Array<Filter | null | undefined>): Filter | undefined {
  const list = parts.filter((p): p is Filter => p != null);
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : { andGroup: { expressions: list } };
}
export function or(...parts: Array<Filter | null | undefined>): Filter | undefined {
  const list = parts.filter((p): p is Filter => p != null);
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : { orGroup: { expressions: list } };
}

export const CHANNEL = "sessionDefaultChannelGroup";

/** Leaves out every listed country. */
export const notCountries = (c: readonly string[]): Filter | null => (c.length ? not(inList("country", c)) : null);
/** Leaves out every listed channel group. */
export const notChannels = (c: readonly string[]): Filter | null => (c.length ? not(inList(CHANNEL, c)) : null);

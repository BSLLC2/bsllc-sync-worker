/** A Reply-To is only ever written when it is one plain address: no line breaks, no second
 *  header riding in on it, exactly one @. Anything else is dropped and the reply goes to the sender. */
export function safeReplyTo(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return /^[^\s<>,;\r\n]+@[^\s<>,;\r\n]+\.[^\s<>,;\r\n]+$/.test(t) ? t : null;
}

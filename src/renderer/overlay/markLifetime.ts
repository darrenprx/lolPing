const expiry = new WeakMap<Element, ReturnType<typeof setTimeout>>();

export function removeMark(mark: Element): void {
  clearTimeout(expiry.get(mark));
  expiry.delete(mark);
  mark.remove();
}

/** Registers the expiry of a newly displayed ping or field outline. */
export function expireMark(mark: Element, delayMs: number): void {
  expiry.set(mark, setTimeout(() => removeMark(mark), delayMs));
}

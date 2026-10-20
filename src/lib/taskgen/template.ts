/**
 * STORY-063 — `{placeholder}` substitution for a catalog rule's title and description templates. Single pass: a value
 * that itself contains braces is not expanded again. An unknown placeholder stays visible (a typo in a catalog UPDATE is
 * then seen on the task, rather than silently blanked).
 */
export function renderTemplate(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-z_]+)\}/gu, (whole, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : undefined;
    return value === undefined ? whole : String(value);
  });
}

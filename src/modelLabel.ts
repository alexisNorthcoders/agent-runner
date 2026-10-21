/** Models an issue's `model:<name>` label can ask for, strongest first. */
const MODELS = ['opus', 'sonnet', 'haiku'];

/**
 * The model an issue's `model:` labels ask for. Matching ignores case and surrounding whitespace.
 * An unknown value is ignored with a warning; several valid ones pick the strongest, with a warning.
 */
export function modelFromLabels(labels: string[] | undefined): { model: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const valid = new Set<string>();
  for (const raw of Array.isArray(labels) ? labels : []) {
    const m = /^model:(.*)$/i.exec(String(raw).trim());
    if (!m) continue;
    const value = m[1].trim().toLowerCase();
    if (MODELS.includes(value)) valid.add(value);
    else warnings.push(`Ignored unknown model label "${String(raw).trim()}" (use model:haiku, model:sonnet or model:opus).`);
  }
  const model = MODELS.find((x) => valid.has(x)) ?? null;
  if (valid.size > 1) warnings.push(`Several model labels (${[...valid].map((v) => `model:${v}`).join(', ')}): using the strongest, ${model}.`);
  return { model, warnings };
}

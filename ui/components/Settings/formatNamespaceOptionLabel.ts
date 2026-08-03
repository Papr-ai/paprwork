interface NamespaceOptionLike {
  id: string;
  name: string;
  environmentType?: string;
}

function environmentTypeIsRedundant(name: string, environmentType: string): boolean {
  const normalizedName = name.toLowerCase();
  const normalizedEnvironment = environmentType.toLowerCase();
  if (normalizedName === normalizedEnvironment) {
    return true;
  }
  return [`-${normalizedEnvironment}`, `_${normalizedEnvironment}`, `.${normalizedEnvironment}`, ` ${normalizedEnvironment}`].some(
    (suffix) => normalizedName.endsWith(suffix),
  );
}

/** Avoid "development · development" or "papr-ai-production · production" when env is already in the name. */
export function formatNamespaceOptionLabel(namespace: NamespaceOptionLike): string {
  const name = namespace.name.trim();
  const environmentType = namespace.environmentType?.trim();
  const showEnvironment =
    environmentType !== undefined &&
    environmentType.length > 0 &&
    !environmentTypeIsRedundant(name, environmentType);
  const label = showEnvironment ? `${name} · ${environmentType}` : name;
  return `${label} (${namespace.id})`;
}

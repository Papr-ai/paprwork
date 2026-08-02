interface NamespaceOptionLike {
  id: string;
  name: string;
  environmentType?: string;
}

/** Avoid "development · development (id)" when name and environment type match. */
export function formatNamespaceOptionLabel(namespace: NamespaceOptionLike): string {
  const name = namespace.name.trim();
  const environmentType = namespace.environmentType?.trim();
  const showEnvironment =
    environmentType !== undefined &&
    environmentType.length > 0 &&
    environmentType.toLowerCase() !== name.toLowerCase();
  const label = showEnvironment ? `${name} · ${environmentType}` : name;
  return `${label} (${namespace.id})`;
}

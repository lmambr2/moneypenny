export type LlmCatalogModel = {
  id: string;
  ownedBy?: string;
  maxModelLen?: number;
  root?: string;
};

export type LlmCatalog = {
  url: string;
  available: boolean;
  error?: string;
  models: LlmCatalogModel[];
};

export function formatModelCtx(n?: number): string {
  if (!n || !Number.isFinite(n) || n <= 0) return '';
  if (n >= 1024) return `${Math.round(n / 1024)}k ctx`;
  return `${n} tok`;
}

export function formatModelLabel(m: LlmCatalogModel): string {
  const ctx = formatModelCtx(m.maxModelLen);
  return ctx ? `${m.id} · ${ctx}` : m.id;
}

export function modelAliases(catalog: LlmCatalog | null, selectedId: string): LlmCatalogModel[] {
  if (!catalog) return [];
  const selected = catalog.models.find((m) => m.id === selectedId);
  if (!selected?.root) {
    return catalog.models.filter((m) => m.id !== selectedId);
  }
  return catalog.models.filter((m) => m.root === selected.root && m.id !== selectedId);
}

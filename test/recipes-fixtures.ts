/* Siren's recipe answers, from feat/apps 76d5bbdf83 (PreviewRecipe and RecipeImportJobProjection). */

export const RECIPE = {
  version: '1.0.0',
  name: 'Partner launch',
  programs: { gold: { name: 'Gold partners', status: 'active' } },
  collaborators: { ana: { email: 'ana@example.com', status: 'active', bindings: [{ targetType: 'program', targetKey: 'gold' }] } },
};

export const PREVIEW = {
  name: 'Partner launch',
  description: null,
  version: '1.0.0',
  sections: [
    { type: 'programs', label: 'Programs', count: 1, samples: [{ key: 'gold', name: 'Gold partners', meta: ['saleTransactionPercentage', 'active'] }], category: 'setup' },
    { type: 'collaborators', label: 'Collaborators', count: 1, samples: [{ key: 'ana', name: 'ana@example.com', meta: [] }], category: 'people' },
  ],
  variables: [],
};

export function importDetail(over: Record<string, unknown> = {}) {
  return {
    jobId: 'job7f3a',
    status: 'complete',
    totalItems: 2,
    processedItems: 2,
    failedItems: 0,
    perStanzaTotals: { programs: 1, collaborators: 1 },
    perStanzaProcessed: { programs: 1, collaborators: 1 },
    created: { programs: { gold: 41 } },
    collaboratorResults: [{ key: 'ana', email: 'ana@example.com', outcome: 'added' }],
    collaboratorSummary: { added: 1, updated: 0, skipped: 0, failed: 0, emailed: 0 },
    productResults: [],
    productSummary: { added: 0, updated: 0, skipped: 0, failed: 0 },
    programResults: [],
    source: { kind: 'cli', fileName: 'launch.recipe.json', mapping: {} },
    errorMessage: null,
    linkedRecords: [],
    failureKind: null,
    dateCreated: '2026-11-25T18:00:00+00:00',
    ...over,
  };
}

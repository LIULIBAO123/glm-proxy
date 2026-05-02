/**
 * Handler for GET /v1/models
 * Returns available GLM models.
 */

const GLM_MODELS = [
  { id: 'glm-4-plus', owned_by: 'zhipu', context: 128000 },
  { id: 'glm-4-0520', owned_by: 'zhipu', context: 128000 },
  { id: 'glm-4-air', owned_by: 'zhipu', context: 128000 },
  { id: 'glm-4-airx', owned_by: 'zhipu', context: 8192 },
  { id: 'glm-4-long', owned_by: 'zhipu', context: 1000000 },
  { id: 'glm-4-flash', owned_by: 'zhipu', context: 128000 },
  { id: 'glm-4-flashx', owned_by: 'zhipu', context: 128000 },
  { id: 'glm-4', owned_by: 'zhipu', context: 128000 },
  { id: 'glm-3-turbo', owned_by: 'zhipu', context: 128000 },
  { id: 'glm-zero-preview', owned_by: 'zhipu', context: 16000 },
  { id: 'codegeex-4', owned_by: 'zhipu', context: 128000 },
  { id: 'charglm-4', owned_by: 'zhipu', context: 4096 },
  { id: 'emohaa', owned_by: 'zhipu', context: 8192 },
];

export function handleModels(req, res) {
  const models = GLM_MODELS.map(m => ({
    id: m.id,
    object: 'model',
    created: 1700000000,
    owned_by: m.owned_by,
  }));

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: models }));
}

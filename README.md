# GLM Proxy

多账号 GLM (智谱AI) API 轮询代理，对外暴露统一的 OpenAI 兼容接口。

```
┌─────────────┐   /v1/chat/completions   ┌────────────┐
│ 外部调用者  │ ──────────────────────→  │ GLM-Proxy  │      ┌──────────────┐
│ (Cursor等)  │ ←──────────────────────  │ Node.js    │ ───→ │ GLM API 1    │
└─────────────┘   OpenAI JSON + SSE      │            │ ───→ │ GLM API 2    │
                                         │ 账号池轮询 │ ───→ │ GLM API 3    │
                                         │ 速率限制   │      └──────────────┘
                                         │ 故障转移   │
                                         └────────────┘
```

## 功能

- **多账号池** — 支持绑定多个 GLM API Key，round-robin 轮询分发
- **健康检测** — 自动追踪错误次数，连续失败自动冷却
- **故障转移** — 遇到 429/5xx 自动重试其他账号
- **速率限制** — 每账号独立 RPM 限制
- **OpenAI 兼容** — 直接对接 Cursor / ChatGPT Next Web / 任何 OpenAI SDK
- **Web Dashboard** — 可视化管理账号池
- **零依赖** — 纯 Node.js，无 npm 包
- **Docker 支持** — 一键部署

## 快速开始

### 本地运行

```bash
cd glm-proxy
cp .env.example .env
# 编辑 .env 设置 API_KEY 等

node src/index.js
```

### Docker 运行

```bash
docker compose up -d
```

## API 端点

### 聊天补全（OpenAI 兼容）

```bash
curl http://localhost:3003/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "glm-4-flash",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 模型列表

```bash
curl http://localhost:3003/v1/models
```

### 添加账号

```bash
curl -X POST http://localhost:3003/auth/accounts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "name": "My GLM Account",
    "apiKey": "xxxxx.yyyyy",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4"
  }'
```

### 查看账号

```bash
curl http://localhost:3003/auth/accounts \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### 删除账号

```bash
curl -X DELETE http://localhost:3003/auth/accounts/ACCOUNT_ID \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Dashboard

访问 `http://localhost:3003/` 打开管理面板，可以：
- 查看账号池状态
- 添加/删除账号
- 启用/禁用账号
- 监控 RPM 使用和错误率

## 在 Cursor 中使用

Settings → Models → OpenAI API:
- API Key: 你在 .env 中设置的 `API_KEY`
- Base URL: `http://localhost:3003/v1`
- Model: `glm-4-flash` 或其他 GLM 模型

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| PORT | 服务端口 | 3003 |
| HOST | 绑定地址 | 0.0.0.0 |
| API_KEY | 外部调用认证 key | (空=不验证) |
| DASHBOARD_PASSWORD | Dashboard 密码 | (空=不验证) |
| DEFAULT_MODEL | 默认模型 | glm-4-flash |
| MAX_TOKENS | 默认 max_tokens | 4096 |
| LOG_LEVEL | 日志级别 | info |
| DATA_DIR | 数据目录 | ./data |

## 支持的 GLM 模型

- glm-4-plus
- glm-4-0520
- glm-4-air / glm-4-airx
- glm-4-long (100万 token 上下文)
- glm-4-flash / glm-4-flashx
- glm-4
- glm-3-turbo
- glm-zero-preview
- codegeex-4
- charglm-4
- emohaa

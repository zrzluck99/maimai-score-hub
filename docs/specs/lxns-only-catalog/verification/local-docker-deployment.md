# 本机 Docker 部署记录

2026-11-11 部署了当前阶段 0–3 的后端，容器为 `mai-local-backend-1`，镜像为 `mai-score-hub-backend:local`，Node 为 22.23.4。

- API：`http://127.0.0.1:9050/api/v1`
- Swagger：`http://127.0.0.1:9050/api/v1/swagger/`
- 健康检查：`http://127.0.0.1:9050/api/v1/health`
- Compose：`backend/docker-compose.local.yml`

复用 `mai-test-mongo`、`mai-test-redis` 和原数据卷，通过新增的 `mai-local-network` 连接。数据库容器未重建，未操作其他项目容器。后端仅绑定本机回环端口，密钥沿用 `backend/.env`，不写入镜像或本文档。后端原有定时任务仍存在，当前不是阶段 4–8 完成后的 Bot 专用运行模式；前端、DX NET Worker、SDGB Worker 未在本次启动。

## 验证结果

- `/health` 返回 HTTP 200，Docker 健康检查通过。
- 通过已有管理 API 执行曲库、别名和封面同步；曲库源固定落雪。
- 曲库 1,421 条展开记录，源歌曲 1,360 首，单一修订；本次曲库内容与已有落雪快照相同，因此没有替换。
- 别名 2,997 条，公开查询覆盖 1,114 个本地曲目 ID；35 条无法映射的落雪别名保留计数并排除于有效查询结果。
- 1,421 个封面已存在于落雪独立缓存，增量同步失败数 0；抽查歌曲 30 的 PNG、WebP 均返回 HTTP 200。
- 未携带密钥的管理请求返回 401，Swagger 返回 200。
- 旧曲库与当前落雪曲库分别对照候选数据，成绩、历史记录、任务和别名引用无缺失、歧义；另核查了 1,421 个落雪封面引用。
- 本机 1 份玩家快照和 1,847 条历史记录的内容摘要在部署前后相同。旧曲库与候选曲库存在 1 项新旧曲标记变化：宴谱 `131852` 的 `isNew` 从 true 改为 false，单谱 Rating 均为 null。B50 总 Rating 前后均为 16125，没有数值变化，原始记录未改写。最初部署汇报将这项标记变化误称为 Rating 变化，现已更正。
- 工作区 `shared/openapi/openapi.yaml` 与部署前摘要相同；镜像内部按原 Dockerfile 的构建钩子生成 OpenAPI，不覆盖宿主文件。

部署前数据库完整备份保存在 `.local-dev/deploy-lxns/maimai_web.before.archive.gz`。引用审计、原始记录摘要和 API 验证报告也在该目录；其中含本地数据，不应提交或公开。

## 日常操作

在仓库根目录执行：

```powershell
docker compose -f backend/docker-compose.local.yml ps
docker compose -f backend/docker-compose.local.yml logs --tail 100 backend
docker compose -f backend/docker-compose.local.yml up -d --no-build backend
docker compose -f backend/docker-compose.local.yml stop backend
```

更新代码后重新构建并启动：

```powershell
docker compose -f backend/docker-compose.local.yml build backend
docker compose -f backend/docker-compose.local.yml up -d --no-build backend
```

本次 Docker Hub 直连超时，通过已运行的本机代理完成官方镜像构建。需要相同构建代理时，仅在当前 PowerShell 会话设置：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:1081'
$env:HTTPS_PROXY = 'http://127.0.0.1:1081'
docker compose -f backend/docker-compose.local.yml build --build-arg HTTP_PROXY=http://host.docker.internal:1081 --build-arg HTTPS_PROXY=http://host.docker.internal:1081 backend
```

运行容器未设置代理，也未修改 Docker 或系统的全局代理配置。`backend/Dockerfile.dockerignore` 排除宿主密钥、依赖、缓存及运行数据。

## 回退

本次是首次创建后端容器，没有旧后端镜像可回切。停止该 Compose 中的后端即可撤下服务，现有 MongoDB/Redis 及数据卷仍保留。数据库备份可用于按需恢复，但不能在未核对部署后新增数据时直接覆盖当前库。

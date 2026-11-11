# QQ Bot 辅助 API：接口与最小改造方案

状态：设计提案，尚未实现。本文的路径、字段、配置项属于建议，不表示现有接口已可调用。

实施顺序见 [顺序实施计划](./implementation-plan.md)。当前边界是 asdfbot 保留 Provider 管理并新增 mai_hub，本项目不集中接管其他成绩来源。

优先级更新：用户要求歌曲数据一律采用落雪。先完成 [落雪唯一曲库来源适配](../lxns-only-catalog/README.md)，再继续本方案；下文“曲库沿用”仅指保留接口路径和同步能力，不再表示保留水鱼源、混合别名或水鱼封面回退。

下游更新：消费方已明确为 asdfbot，接入以 [asdfbot 消费契约补充](./asdfbot-integration.md) 为准。保留本文通用接口，但不能直接把 latest 成绩作为 asdfbot 的全量替换快照；新增普通 SD/DX 完整快照视图，保持原始数据和宴谱能力。

## 1. 范围与职责

用户要求：好友码由 QQ Bot 管理，一次绑定长期有效；不使用 SDGB；不清好友；前端暂不使用；不用的功能保留代码。

- QQ Bot 持久化 QQ 用户与好友码的映射，决定谁能绑定、更换或查询谁的账号，并负责 QQ 消息交互。
- API 只接收好友码，不新增 QQ 用户表、不把游戏好友关系当作 QQ 身份证明。
- DX NET Worker 负责游戏好友申请和成绩抓取。下文的“抓取账号”指项目现有 Bot 游戏账号，与 QQ Bot 不同。
- API 不签发永久用户 JWT；QQ Bot 使用独立服务凭证。
- 游戏好友关系长期保留，但玩家主动删好友、账号失效等外部变化不能保证永远不发生。这些情况不删除 QQ 绑定。
- 首版沿用普通好友申请，由抓取账号发送、用户接受。暂不新增第二套“用户发送申请”的 Bot API；原有功能保留。
- 暂不新增定时更新、回调、取消任务、解绑、管理账号、图片生成接口。曲库沿用已有接口；图片等能力以后按需要接入。

## 2. 现有实现与需要改变的行为

| 现有实现 | Bot 模式需要的行为 |
| --- | --- |
| `/me/*` 从 JWT 取好友码 | 专用服务鉴权后显式传好友码 |
| 网站好友验证任务签发 30 天 JWT | QQ 绑定由 Bot 保存，API 不要求网站登录 |
| 好友快照存在 MongoDB 的 Bot 状态记录中 | 复用现有持久化快照，不新增重复的永久绑定表 |
| 更新要求 5 分钟内快照或 10 分钟内任务证明，否则尝试 SDGB | 过期快照可用于选择候选账号，执行前由 DX NET 核实；不要求重新绑定，不调用 SDGB |
| 新任务默认取消该好友码的旧任务 | Bot 入口复用相同活动任务；冲突请求返回 409，不取消旧任务 |
| 定时、共享队列容量检查、发送失败重试都可能清好友 | 保留好友模式下全部禁止删除已建立好友 |
| 自动更新和 SDGB 有后台调度 | 辅助 API 部署中不启动这些执行链，保留曲库同步和 Worker 健康任务 |

## 3. 鉴权和通用契约

新接口前缀：`/api/v1/bot`。

```http
Authorization: Bearer <BOT_API_TOKEN>
Content-Type: application/json
```

新增独立 `BotApiGuard`，只验证服务密钥，不复用用户 AuthGuard，也不把管理员/Worker 共用密钥交给 QQ Bot。未配置密钥时拒绝访问；服务密钥轮换不影响好友码绑定。首版是一个受信任 QQ Bot 服务，不引入多租户权限系统；持有该密钥即可操作本 API 下任意好友码，QQ 用户权限由 QQ Bot 校验。

好友码作为字符串传递，去除首尾空白后校验 15 位数字，禁止转成数字。时间均为 ISO 8601 UTC；成绩数值字符串和 null 语义沿用当前存储。新响应使用白名单映射，不返回 Cookie、导入令牌、机台 ID、队列路由或执行凭证。

错误结构：

```json
{"error":{"code":"friendship_required","message":"请先建立游戏好友关系","retryable":false}}
```

| HTTP | code | Bot 的处理 |
| --- | --- | --- |
| 400 | invalid_request | 提示参数错误 |
| 401 | unauthorized | 检查服务凭证 |
| 404 | player_not_found / job_not_found / scores_not_found | 区分无用户、无任务、从未同步 |
| 409 | friendship_required | 首次建立游戏好友，或恢复已丢失的关系 |
| 409 | job_conflict | 等待已有不同任务完成，返回 activeJobId |
| 503 | bot_unavailable | 抓取账号不可用，稍后重试，不重新绑定 |
| 503 | friend_capacity_full | 没有新增好友容量；已有好友不受此错误限制 |
| 503 | friendship_check_unavailable | 暂时不能确认关系，不等同被删除 |
| 503 | bot_assignment_busy | 保留已有分配锁冲突语义和 Retry-After |

上游故障、超时和快照过期不能映射为“好友已删除”。队列执行失败通过任务的 error 字段返回，任务查询本身仍返回 200。既有接口的错误结构不修改。

## 4. 接口

### 4.1 建立或复用游戏好友关系

```http
POST /api/v1/bot/players/:friendCode/friendship
```

请求体为空。先复用已有用户；不存在时按唯一好友码创建最小用户记录，处理并发创建的唯一键冲突。不要求设置密码或机台 ID。

新鲜快照已确认存在关系时返回 200：

```json
{"friendCode":"123456789012345","status":"ready","botFriendCode":"987654321098765","jobId":null}
```

需要核实或申请时返回 202：

```json
{"friendCode":"123456789012345","status":"pending","botFriendCode":"987654321098765","jobId":"job-uuid","reused":false,"pollAfterMs":3000}
```

- 同好友码已有相同好友任务时返回该任务，reused=true。
- 旧快照含好友时优先在原账号核实；已是好友直接完成，不发送、不删除、不重新申请。
- 找不到已有关系且可以确认快照有效后，才选择有容量账号发送申请。
- 全部候选快照未知/过期时，先复用或创建内部全量好友列表刷新任务。刷新完成前返回 friendship_check_unavailable 及 Retry-After；不直接判断未绑定。
- 请求响应中 pending 可能只是核实中。Bot 应看任务 action 决定是否提示用户接受申请，不能只看到 202 就要求操作。
- 用户完成接受后，任务通过 DX NET 确认真实好友关系，更新本地快照并上报后端，再完成任务。
- QQ Bot 在自己的绑定流程完成后持久化 QQ 映射。API 的 ready 只证明游戏好友存在，不证明 QQ 归属。

### 4.2 查询好友关系

```http
GET /api/v1/bot/players/:friendCode/friendship
```

```json
{"friendCode":"123456789012345","status":"ready","available":true,"botFriendCode":"987654321098765","checkedAt":"2026-11-11T08:00:00.000Z","activeJobId":null}
```

status：ready（近期确认存在）、pending（建立中）、missing（有效快照确认无关系）、unknown（证据不足或过期）。available 独立表示候选抓取账号在线状态；checkedAt 是证据时间，不用当前时间伪装新检查。GET 只读，不发申请、不创建用户。已保存的关系不会因账号离线而变成 missing。无注册记录返回 player_not_found。

### 4.3 创建成绩更新

```http
POST /api/v1/bot/players/:friendCode/score-jobs

{"diffsToScrape":[2,3,4,10]}
```

请求体可为 `{}`。首版只开放 diffsToScrape，可选值为 0/1/2/3/4/10；省略沿用现有默认 2/3/4/10，不声称默认抓取全部难度。传入六个值才是所有现有难度。数组去重、排序后参与活动任务比较。定向谱面和仅 FC/FS 参数暂不新增 Bot 接口支持，原功能保留。

响应 202：

```json
{"jobId":"job-uuid","reused":false,"status":"queued","pollAfterMs":3000}
```

- 不自动发好友申请，也不等待 SDGB；无用户/无好友分别返回 404/409。
- 有已保存关系但快照过期：允许按候选账号创建 pinned 更新任务，在抓取前核实。核实请求失败是可重试故障，明确无好友才是 friendship_required。
- 已有同参数 Bot 更新任务时返回原 jobId；不同参数或不同任务返回 job_conflict，不扩大范围、不取消任务。
- “检查活动任务→创建”在好友码级 Redis 锁内完成，保持多后端实例一致；已有分配容量锁和执行代次检查保留。
- 这是活动任务去重，不承诺请求永久幂等。旧任务完成后再次 POST 表示发起新更新；Bot 应持久化 jobId 并优先查询。首版不新增幂等记录表。

### 4.4 查询任务与唤醒好友检查

```http
GET /api/v1/bot/players/:friendCode/jobs/:jobId
POST /api/v1/bot/players/:friendCode/jobs/:jobId/verify
```

GET 返回 200：

```json
{
  "id":"job-uuid",
  "friendCode":"123456789012345",
  "kind":"friendship",
  "status":"processing",
  "stage":"wait_acceptance",
  "botFriendCode":"987654321098765",
  "action":"accept_friend_request",
  "progress":null,
  "error":null,
  "createdAt":"2026-11-11T08:00:00.000Z",
  "updatedAt":"2026-11-11T08:00:10.000Z",
  "pollAfterMs":3000
}
```

- kind 为 friendship 或 score_update。status 沿用 queued/processing/completed/failed/canceled。
- action 为 none 或 accept_friend_request；仅确认申请已发出、等待玩家接受时使用后者。
- progress 对成绩任务映射现有 completedDiffs、totalDiffs，不虚构精确百分比。error 为 null 或统一 code/message/retryable 对象。
- 查询要求任务好友码匹配，且任务标记属于 Bot API；否则返回 job_not_found。不能暴露内部 QR、维护任务。
- verify 请求体为空，只对等待中的 Bot 好友任务复用 jobs.wake；返回 200 及最新任务，不直接标记验证成功。终态调用返回原任务；成绩任务调用返回 400。
- 任务等待和超时沿用现有期限；“永久”只指绑定，不指申请任务永久挂起。
- 成绩任务 completed 必须在成绩落库后出现，保持现有提交顺序。之后调用 latest 读取最新成绩；latest 是当前合并结果，不承诺是某次任务的历史快照。

### 4.5 最新成绩

```http
GET /api/v1/bot/players/:friendCode/scores/latest
```

返回 200，包含 friendCode、白名单 profile（无资料时 null）以及现有 getLatestWithScores 的 id、createdAt、updatedAt、lastMergedAt、scoreUpdatedAt、scoreVersion、scores。

scores 保留当前 musicId/cid/chartIndex/type/score/dxScore/fc/fs/rating/isNew/observedAt 字段及原类型，不重新计算、不修改成绩合并含义。歌曲 ID 与谱面 cid 明确区分。无同步记录返回 scores_not_found；已同步且无成绩返回空数组。读取不自动触发抓取。

### 4.6 曲库

直接复用：

```http
GET /api/v1/catalog/music
GET /api/v1/catalog/music/aliases
```

这两个现有公共接口不迁入 Bot 鉴权。默认每 30 分钟的曲库/封面/别名同步继续保留。首次空库可通过现有管理接口初始化；管理员密钥不交给 QQ Bot。

## 5. 长期好友与容量

复用 bot-status 中持久化的 friends/friendsUpdatedAt 和用户 friendCode。快照是游戏好友事实的缓存，不是 QQ 授权凭证。不新增永久有效的 friendshipJobId，也不把短期任务证明有效期改成无限。

Bot 路由策略：近期确认存在的在线账号优先，其次曾有关系的在线账号，并在 Worker 执行前核实。已知好友只在离线账号上时返回 bot_unavailable，不静默换账号重复申请。存在多个已是好友的账号时可以选择另一个在线账号。

新申请与现有好友更新分别处理容量：只有真正可能新增关系的任务占新增容量；已存在关系的核实/更新不应因为软上限被拒绝。保留已有后端分配锁、健康检查、并发预留和上限常量，首版不擅自提高 50/80 等现有门槛。不清好友后容量满就明确返回错误，不循环清理或无限重试。

旧快照选择的候选必须在执行时真实确认。保留模式下，“关系核实”与“发送新申请”的容量判定分开，不能为了核实跳过容量检查后又直接新增好友。

## 6. 配置与部署（拟新增）

| 配置 | 兼容默认值 | 辅助 API 部署值 | 作用 |
| --- | --- | --- | --- |
| BOT_API_ENABLED | false | true | 注册 Bot API |
| BOT_API_TOKEN | 无 | 独立密钥 | Bot 服务鉴权 |
| SDGB_ENABLED | true | false | 停用 SDGB 调度和调用入口 |
| AUTO_UPDATE_ENABLED | true | false | 停用现有依赖 SDGB 的自动更新生产者 |
| DXNET_FRIEND_POLICY | legacy | retain | Worker 与后端一致启用保留好友策略 |

Bot 新入口始终使用 dxnet_only 策略，无论旧模块配置如何，都不能自动回退到 SDGB；该策略为内部参数/任务上下文，不允许 HTTP 任意覆盖。任务 context 使用明确命名空间标识 Bot 来源及关系策略，复用原 user_interaction/user_sync lane，不新建队列。

SDGB_ENABLED=false 时保留模块代码和注入结构，给入口及后台启动/恢复逻辑加最小开关；旧 SDGB 接口明确返回 service_disabled，不允许仍投递任务后永久等待。覆盖注册监控、维护、修复、积压探测，以及自动更新 scheduler、daily-full、FC/FS 等生产者。不能只停外部 SDGB 进程。已有 SDGB 在途任务在切换前按现有管理方式排空，不在本改造中清库或强制改状态。

retain 模式下停止整个周期 CleanupService（包含自动取消/拒绝申请），同时禁止 shared-eligibility 的临时清理和 send_request 的删好友重试。这是该部署模式的明确行为变化；legacy 默认维持原行为。失败申请不会靠全局清理回收，重试必须识别已有申请并继续等待，不能制造重复申请。模式不覆盖旧网站登录验证语义，Bot 任务的复用分支必须与旧登录验证分离。

不设置 BOT_BACKGROUND_TASKS_DISABLED=true，因为它同时关闭健康检查和快照上报。Cookie 持久化、好友快照刷新、任务看门狗、任务缓存清理继续工作；“不清好友”不等于停掉所有名为 cleanup 的逻辑。

只启动 backend、DX NET worker、MongoDB、Redis 和项目原本必要的运行依赖；前端、SDGB、Android 自动化不启动。增加单独 Bot 启动配置，保留旧脚本和默认部署行为。曲库外部访问及抓取账号 Cookie 登录仍需可用。

## 7. 文件级改造计划

| 位置 | 最小改动 |
| --- | --- |
| shared/src/modules/bot-api/（新增） | Zod 请求响应、错误及接口契约；导出并生成文档 |
| backend/src/api/bot/（新增） | 专用控制器，参数验证和响应映射 |
| backend/src/modules/bot-api/（新增） | 服务密钥 Guard、任务去重、好友状态协调；复用现有服务 |
| backend/src/api/backend-api.module.ts | 按配置挂载 Bot 模块；原模块保留 |
| backend/src/modules/job/services/job.service.ts | 增加内部 dxnet_only 策略，关闭此分支 cabinet fallback；Bot 调用 cancelActiveJobs=false |
| job-friendship.service.ts、bot-friend-snapshot.service.ts | 区分新鲜/过期/离线/缺失；复用快照和已有刷新任务 |
| 现有成绩创建锁所在服务 | 将纯 Redis 创建锁小范围抽出为可复用服务，原入口沿用同一锁键和语义；Bot 增加好友码级协调，避免依赖机台业务服务 |
| Worker send_request/等待接受/update_score 准备步骤 | Bot 分支先检查已有关系、复用待接受申请；抓取前核实，不删除好友 |
| Worker background-tasks/index.ts、shared-eligibility.ts、friend-api.ts | retain 策略覆盖所有删好友入口，底层兜底禁止 removeFriend；不影响快照内部移除已不存在记录 |
| SDGB/auto-update 入口和后台生命周期 | 按开关停止生产和调度，保留代码和默认行为 |
| 配置示例、独立启动脚本、接入说明 | 提供仅运行辅助 API 的配置，不改用户环境文件 |

不新增 QQ 映射表，不清理旧用户或成绩，不删除机台字段，不重做任务系统、曲库或成绩计算。任务来源使用现有 context；终态历史任务保留原清理策略，查询过期返回 job_not_found，QQ 绑定不依赖它。

## 8. 实施顺序与验收

1. 固化接口契约和模式配置；新增鉴权、控制器、响应映射，现有路由保持不变。
2. 完成好友复用和活动任务去重；保证相同参数重复请求不取消/重复创建任务，进程重启仍能查询任务与好友快照。
3. 增加 retain 策略，覆盖定时清理、容量触发、发送失败重试，并验证全部路径不会请求删除好友。
4. 完成 dxnet_only 路由和 SDGB/auto-update 停用；校验模块仍能启动，后台无 SDGB 投递。
5. 提供独立启动方式，执行 Bot 真实调用路径验证。

必须覆盖的行为测试：

- 无密钥/错误密钥拒绝；Bot 密钥不能用于管理和 Worker 接口。
- 已好友重复建立立即复用；有申请时复用；申请完成后无需 friendshipJobId 即可更新。
- 两个并发同参数更新只产生一个活动任务；不同参数不会取消旧任务。
- 好友快照过期自动核实；账号离线返回暂不可用；只有确定无关系才提示恢复。
- 好友容量满时老用户更新成功，新申请明确失败；无隐式删除请求。
- 等待过期、失败重试、服务重启均不删除 QQ 绑定或游戏好友。
- Bot 无法通过任务路径读取不匹配好友码或内部任务。
- 默认难度保持 2/3/4/10，显式全难度生效，已有成绩合并和历史记录预期不变。
- 无成绩返回 404，合法空成绩返回 200；任务完成后结果已经落库。
- SDGB 停用时不产生 SDGB 新任务；曲库同步、快照、Cookie 持久化仍工作。
- legacy 模式原有测试预期不削弱；Bot 行为另增测试。

运行 shared/backend/worker 对应 typecheck、build 和相关测试；真实环境再验证一次“申请→用户接受→更新→查询成绩→重启→再次更新”。没有运行真实 DX NET 路径时，不声称完整兼容。部署、重启和真实好友申请不是本次设计文档操作的一部分。

## 9. 本次设计检查记录

已静态阅读 API、任务创建/路由、好友清理、快照存储、成绩读取和曲库调度代码。业务代码未修改，未运行测试或外部服务。

工作区原有 shared/openapi/openapi.yaml 修改，本次保持不动；未来生成 OpenAPI 前必须保留并核对该修改。

# 面向 asdfbot 的消费契约补充

状态：设计提案，未实施。补充并优先于原 Bot API 文档中“直接返回原始成绩即可接入”的建议。曲库统一落雪仍是前置任务。

## 1. 实际消费者约束

参考 asdfbot 提交 d6676775ce99e14d8b3d61dc703ce7e56af631ba 的真实代码：

- providers/interfaces.py：Provider.fetch_full 返回 MaimaiPlayerSnapshot。
- models/player_snapshot.py：记录使用 music_id、diff_index、achievements、ra、rank_id、fc_id、fs_id、dxscore；普通 SD/DX 的本地 ID，难度 0..4，不支持宴谱。
- repositories/player_snapshots.py：仅接受 is_full=True，先校验谱面存在，再在事务中 DELETE 该来源玩家的全部旧记录后写入。
- services/data_sync_service.py：校验 provider 身份，不接受伪装成另一个来源的结果。
- score_sources/models.py、routing.py 和 SQLite player.provider CHECK：当前只支持 diving_fish / luoxue，新成绩源需要同步注册和数据库迁移。
- best_service.py：先按数据库 br.ra 排序取旧 35、新 15，再用本地定数重算展示 Rating。导入 ra 错误会导致取错歌曲，仅在展示时重算不能弥补。

因此兼容必须包含字段类型、全量语义、来源身份和入库排序，而不只是 JSON 改名。

## 2. 职责与推荐接入方式

本项目负责：好友关系、DX NET 抓取、队列进度、持久化原始成绩和稳定快照、落雪曲库同步。

asdfbot 负责：QQ 与好友码的绑定、命令/权限/消息、SQLite 成绩导入、按本地落雪曲库计算 B50、牌子、查歌和图片。

推荐在 asdfbot 新增 MaiHubMaimaiProvider（建议来源键 mai_hub），将本项目视为独立成绩源。catalog_source='lxns' 与 score_source='dxnet' 分开标记，不能因采用落雪曲库就把 DX NET 抓取成绩写成 provider='luoxue'。否则会覆盖真正的落雪源账号数据，并错误依赖其 OAuth 绑定。

不伪装落雪玩家 API：现有 LuoxueMaimaiProvider 还校验 class_rank、star、trophy、upload_time 等字段，本项目不能为兼容而编造这些值。新 Provider 直接映射共同的领域模型，HTTP 客户端、异步任务轮询独立于命令层。

新增来源只用于 maimai，不自动修改其他游戏、现有默认来源、权限或查询命令语义；默认选择新来源仍是另一个明确配置选择。

## 3. 数据 ID 与输出格式

数据库内部格式保留，Bot 边界增加专用响应映射；不强制改写现有 /me、/catalog 或 MongoDB 的字符串 ID/百分数字符串。

asdfbot 视图采用其现有字段和数值类型：

| 字段 | 输出约定 |
| --- | --- |
| music_id | 整数，本地 SD 原 ID / DX 源 ID+10000，避免 Bot 再加一次 |
| diff_index | 整数 0..4 |
| achievements | 数字，100.5000% → 100.5，不转成 1.005；保留四位精度语义 |
| dxscore | 非负整数；缺失不能变成 0 |
| ra | 整数，基于当前落雪定数；用于校验，Bot 入库时以其本地曲库重算值为准 |
| rank_id | d,c,b,bb,bbb,a,aa,aaa,s,sp,ss,ssp,sss,sssp 对应 0..13 |
| fc_id | 空、fc、fcp、ap、app 对应 0..4 |
| fs_id | 空、sync、fs、fsp、fsd、fsdp 对应 0..5 |

状态编号固定为本契约 v1 的枚举表，不能依赖任意版本 Python 列表的动态下标。空成就状态表示已确认没有 FC/FS；字段未知是另一回事，必须保留质量信息，不能直接映射成 0。未知枚举拒绝导入并报告。

achievements/ra/rank/dxscore 的缺失、NaN、不合法数字必须被捕获。不能为了适配全非空 dataclass 统一填零、丢弃记录后继续宣称全量。

宴谱保留在本项目原始成绩及通用接口中，但从 asdfbot 的普通成绩视图中排除，并返回 excluded_utage_count。此处 is_full 指“全部普通 SD/DX 范围”，不是“包含所有宴谱”；不修改 Bot 的普通成绩模型来塞 chartIndex=10。

## 4. 专用刷新与快照接口（建议）

保留原有好友申请、状态查询、任务轮询接口。补充：

```http
POST /api/v1/bot/players/:friendCode/snapshot-jobs
GET /api/v1/bot/players/:friendCode/snapshot
```

使用既定 BotApiGuard。POST 请求体 {}，固定 scope='standard_dx_all'，明确抓取普通难度 [0,1,2,3,4]；任务内部复用现有 update_score。复用同一普通全量刷新任务；遇到部分难度/FCFS-only 等活动任务返回 job_conflict，不能把它认成等价任务。

GET 的成功响应示意（记录示例省略，不填虚构上游数据）：

```json
{
  "schema_version": 1,
  "provider": "mai_hub",
  "provider_user_id": "123456789012345",
  "catalog_source": "lxns",
  "score_source": "dxnet",
  "catalog_version": "catalog-revision",
  "score_version": 12,
  "scope": "standard_dx_all",
  "is_full": true,
  "source_job_id": "job-uuid",
  "fetched_at": "2026-11-11T08:00:00.000Z",
  "upstream_updated_at": null,
  "excluded_utage_count": 0,
  "player": {},
  "records": []
}
```

player 应明确提供有依据的 nickname、rating 等资料；provider_user_id/username 使用好友码。机台段位、牌子等没有可靠来源时保留缺失信息，不冒充落雪接口已有字段。Bot 若需把未获取的展示项映射为自身默认值，应在适配器中明确记录该显示规则；不当成上游已确认事实。缺少构建合法玩家对象所必需的信息时，返回 snapshot_incomplete，不提交入库。

fetched_at 表示实际抓取时间；upstream_updated_at 只有掌握上游更新时间时才填，不能把后端抓取时间伪装为玩家最后游玩时间。重复 GET 不改变 fetched_at。

新视图只服务可安全导入的完整快照：没有完整快照/必要字段未知/最近全量构建失败时返回 409 snapshot_incomplete 或结构化故障，不把当前合并库标成全量。有旧的完整快照可以继续查询，但必须返回它自己的版本和时间，不拼接成虚假的新快照。

### 全量证明与一致性

仅看到某个 update_score completed 不足以证明全量。必须在发布快照前确认：

1. 本次任务类型为普通全量，难度 0..4 均完成，成绩类型页面和分页已穷尽。
2. 未出现网络失败后跳过页面、未知曲目静默丢弃、缺失必要字段等情况。
3. 已完成原始成绩合并提交，生成的普通视图通过记录唯一性和类型校验。
4. 保存与该版本对应的完整覆盖标记、源任务、曲库版本、抓取时间。

建议为每位玩家保存最后一次验证通过的 asdfbot 快照（独立小型 Mongo 集合，一份最新快照，不复用短期任务 TTL）。在源数据版本和曲库版本校验通过后一次性替换整个快照文档；失败保留旧文档。通过版本条件阻止较旧任务覆盖较新快照，GET 返回同一份已发布文档，避免 records 与 score_version 来自不同读取时刻。

部分难度、定向或 FC/FS-only 更新继续按原逻辑入库，但不自动发布新的完整快照。该约束让 asdfbot 可以保留其已有全量替换仓储，不必本次另造部分合并机制。

不能用“所有难度历史上曾经抓过”直接证明本次全量，也不能将空成绩和抓取失败都表示为空数组。真实全量扫描确认没有成绩时才允许发布空 records，并由 Bot 正常替换。

## 5. 曲库一致性与 Rating

两端共享落雪数据来源和普通 SD/DX 的 ID/主版本规则。当前 asdfbot 已有正式曲库构建/切换流程，首版不强制由辅助 API 接管 SQLite 曲库；可继续各自读取落雪，但必须检测兼容性。

建议 catalog_version 是固定规范的普通曲库投影哈希，覆盖 ID/难度、定数、主版本/isNew、disabled/配信信息等参与结果的字段，排序和序列化规则写进契约，并提供跨语言相同样本测试。不要用同步时间充当数据版本，也不要用不同 HTTP 响应字节哈希直接宣称两端一致。

可在 Bot 专用 catalog-meta 接口暴露版本、目标游戏版本、同步时间及普通曲目数量；不改现有公共 /catalog/music 的数组格式。两端不一致时由适配器报告 catalog_mismatch，保留旧成绩；按 asdfbot 原有曲库构建/审核流程更新后重试，不在查询命令中自动重建正式库。

Bot 导入前用本地曲库重算每条 ra，再调用 replace_full_snapshot。原因：其 B50 SQL 使用 ra 预排序，若定数版本不一致，后面的展示重算已经无法纠正被 SQL 漏选的曲目。核对后再持久化可避免两套算法或旧缓存造成错误。

rank_id 与 FC/FS 编号可在 API 端统一输出；Bot 只做契约验证和构造模型，不再处理百分号、源 ID 转换等重复工作。重算 ra 属于消费端必须保证的本地排序一致性，不将 API 的 Rating 当作落雪官方返回值。

## 6. asdfbot 端必要改动

| 位置 | 改动 |
| --- | --- |
| maimai/providers/mai_hub.py（新增） | 服务鉴权、任务创建/轮询、读取完整快照、异常映射、契约检查 |
| score_sources/models.py、routing.py | 注册 mai_hub，限制为 maimai 支持；保留原默认来源 |
| SQLite 来源约束及迁移脚本 | 允许新 provider，迁移保留两种旧来源记录、外键和唯一约束 |
| runtime/bootstrap.py/相关服务组装 | 注入新 Provider 和超时/轮询配置 |
| QQ 绑定存储/解析 | 永久保存 QQ→好友码，从绑定解析 PlayerQuery；不要求每次 OAuth |
| Provider 入库边界 | 验证 catalog_version、完整性、ID、数值/状态枚举；按本地曲库算 ra |
| 错误翻译与必要命令入口 | 复用现有展示机制，区分待接受、账号离线、曲库不一致、抓取未完成 |

轮询等待以任务 deadline 为界，可取消本地等待并保留 jobId 下次续查；轮询超时不清除绑定、不发起第二次好友申请。已有 ProviderGuard 的整次请求超时要核对，不能沿用短 HTTP 超时覆盖整个分钟级抓取过程。

不能只加 Python 枚举就认定支持新来源：当前 SQLite CHECK 也会拒绝，PlayerRef 和 normalize_source 也会拒绝。迁移与默认源切换分开，不能覆盖 luoxue 数据来规避迁移。

本方案不修改 asdfbot 的旧水鱼/落雪成绩获取权限，不删除其他 Provider，不自动让其他游戏接受 mai_hub，不重写命令体系、B50 renderer 或牌子逻辑。

## 7. 验收优先级

1. 关键防丢分：只有 [2,3,4] 或 FC/FS-only 更新时不得发布全量快照；导入失败后旧成绩原样存在。
2. 全量分页/难度完成、空记录合法性、未识别歌曲、缺失字段、重复 (music_id,diff_index) 的发布测试。
3. 跨语言字段与枚举契约，尤其 sync/fsd/fsdp、百分数精度、DX ID 不重复偏移、宴谱排除范围。
4. 新来源迁移前后旧数据保持不变，来源隔离，不借用 luoxue OAuth。
5. 同步后曲库一致与 B50 SQL 预排序正确；乱序快照不覆盖新数据，反复读取快照时间不变化。
6. 一次真实链路：QQ 绑定→游戏好友→五难度抓取→专用快照→asdfbot SQLite 事务导入→B50/牌子查询。

本次仅静态核查上述代码与更新方案。没有修改 asdfbot、本项目业务代码、数据库或执行运行测试。

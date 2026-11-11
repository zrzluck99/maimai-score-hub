# 曲库统一落雪来源：接口核查与适配报告

状态：研究与设计，未修改业务代码或数据库。优先级高于 QQ Bot API 改造。

下游已明确为 asdfbot。两端的 ID、版本、Rating 与全量成绩语义，另见 [asdfbot 消费契约补充](../qq-bot-api/asdfbot-integration.md)；不要将本项目的部分难度成绩直接用于 Bot 的全量替换。

## 1. 结论与范围

用户要求歌曲数据一律使用落雪。可以实现，但不能仅把 MUSIC_DATA_URL 改成落雪地址：响应格式、SD/DX ID、版本、新旧曲、宴谱、别名、封面及导出映射均需适配。

本方案把曲目信息、谱面定数与物量、版本/分类字典、歌曲别名、曲绘统一到落雪；禁止水鱼或其他曲库来源作为自动回退。落雪故障时继续提供上一次验证通过的落雪快照，并报告同步失败；首次尚无落雪快照时不把旧水鱼库冒充落雪数据。

玩家实测成绩仍来自现有 DX NET，不改抓取渠道。向水鱼导出玩家成绩是另一种外部操作，本要求不等于删除该功能；其实现必须与“读取水鱼曲库”解耦，无法确定的目标 ID 要明确报错，不得恢复水鱼曲库请求。旧代码可保留，但不能在启用后的曲库执行链中调用。

## 2. 官方接口与实际验证

主要依据：[落雪官方舞萌 DX API 文档](https://maimai.lxns.net/docs/api/maimai)。以下均进行了不带凭证的只读 GET，返回 HTTP 200。

| 用途 | 接口 | 结果与参数 |
| --- | --- | --- |
| 全曲库 | https://maimai.lxns.net/api/v0/maimai/song/list?version=25500&notes=true | 返回 songs、genres、versions；本次 1,360 首 |
| 单曲详情 | https://maimai.lxns.net/api/v0/maimai/song/30?version=25500 | 返回单个 Song，包含标准和 DX 两组谱面 |
| 别名 | https://maimai.lxns.net/api/v0/maimai/alias/list | 返回 aliases，每项 song_id + aliases[]；本次 1,077 组 |
| 曲绘 | https://assets2.lxns.net/maimai/jacket/30.png | 返回 image/png |

这些接口属于公共 API，读取曲库不要求玩家 Token 或好友绑定。开发者/个人玩家成绩接口的认证规则不在本次替换范围。

- version 为游戏版本参数，文档当前默认 25500；建议显式配置当前国服版本，避免默认版本升级时悄悄切换计算口径。
- notes 默认 false，完整曲库同步必须明确传 notes=true，才能拿到物量。
- 单曲接口文档仅列出 version 参数；批量入库使用已核实的列表接口，不依赖未声明的单曲 notes 参数。
- 官方游戏资源基础 URL 当前为 https://assets2.lxns.net/maimai。现有代码的 assets.lxns.net 和 .png!webp 不是本次选用的文档路径；下载 PNG 后可沿用本地 sharp 生成 WebP。
- 文档明确资源访问有频率限制，但本页未给出数值配额。曲库沿用低频同步，封面按缺失下载、缓存和有限重试，不在每次查歌时下载全库。
- API 包含未配信内容。release_date 按北京时间当日 07:00 判断；缺失日期不限制。locked 只是需要解锁，不等于禁用；disabled 曲目不进入落雪 B50。

官方文档文本摘取见 research/official-api.txt；真实响应的代表样本见 research/song-samples.json。全量响应仅用于本地分析，保存其 SHA-256 与统计到 research/sample-summary.json，不将完整曲库当成长期静态源。

## 3. asdfbot 的参考实现

已通过 SSH 静态读取用户指定仓库 zrzluck99/asdfbot，参考提交：

`d6676775ce99e14d8b3d61dc703ce7e56af631ba`

公开 GitHub API 返回 404，但本机已配置的 SSH 身份可读取。独立浅克隆位于工作区根目录的 .reference-asdfbot，没有修改或推送参考仓库业务文件。

| 参考位置 | 已实现的规则 | 本项目的采用方式 |
| --- | --- | --- |
| src/libraries/maimai/identity.py | standard ID 不变，dx ID +10000；严格区分 ID 和谱面类型 | 采用普通谱面规则，增加本项目宴谱分支 |
| src/libraries/maimai/catalog/luoxue.py | 校验响应、显式 difficulty、物量分项和；按谱面版本归主版本；SD/DX 分开入库 | 用 TypeScript/Zod 实现同等边界，不照搬 Python/SQLite 架构 |
| src/libraries/maimai/catalog/constants.py | 实时同步必须使用响应中的分类/版本，离线常量不能修补无效响应 | 采用；保留本地展示兼容值时明确区分展示映射与数据源 |
| src/libraries/maimai/providers/alias/luoxue.py | 只读落雪别名，严格校验 song_id 和 aliases | 采用，按源 ID 关联本地 SD/DX 记录 |
| scripts/sync_maimai_covers.py | assets2.lxns.net，临时文件完成后替换 | 采用落雪唯一下载源和完整文件替换 |
| src/db/maimai/build_luoxue_catalog_db.py | 旁路构建，检查历史成绩引用后再切换 | 在 MongoDB 中做临时曲库和只读引用核对，不能直接运行其 SQLite 迁移 |
| src/test/test_maimai_luoxue_catalog*.py、test_maimai_luoxue_assets.py | ID、版本、物量、迁移引用、封面测试 | 借鉴测试场景，不宣称已运行这些测试 |

不能照搬的行为：参考插件主动跳过全部宴谱，并把 release_date 写成 None。本项目现有宴谱功能须保留，官方配信日期也应保留。参考插件版本号字段及类型为自身约定，不能直接替换本项目现有字符串类型。

## 4. ID 与谱面兼容：保持现有内部 ID 形状

落雪同一首歌的 standard、dx 共用源 ID。建议明确保存 source='lxns'、sourceSongId，同时保持当前内部 id/cid 格式：

| 落雪数据 | 本地音乐 id | 本地谱面 cid |
| --- | --- | --- |
| song 30，standard，difficulty 3 | 30 | 30_3 |
| song 30，dx，difficulty 3 | 10030 | 10030_3 |
| song 100018，utage，difficulty 0 | 100018 | 100018_0 |

普通谱面原 ID 和 DX +10000 是本项目的兼容编号规则，不表示继续信任水鱼曲目内容。歌曲名称、定数、分类等全部来自落雪。

宴谱不执行普通歌曲的取余或 +10000；继续保留本项目成绩 chartIndex=10、曲库数组槽位 0、cid 后缀 _0 的既有适配。未来若落雪返回同歌曲多个宴谱，应报契约不兼容并保留旧快照，不能静默覆盖。

本次真实样本验证：

- 1,360 个源歌曲，61 个同时含 SD/DX，65 个宴会场歌曲。
- 拆分得到 1,421 个本地音乐记录、5,623 个谱面；上述兼容编号下没有重复音乐 ID 或 cid。
- 16 个 BUDDY 宴谱；本次没有同一宴曲的多个谱面。
- 这只证明落雪样本转换不冲突，未与当前生产 MongoDB 的历史 ID 做比对，不能声称历史映射已经全部兼容。

现有 convertLxnsSongToDocument 直接合并 SD/DX 时会重复 cid；现有 buildLxnsDocs 虽拆两条记录，仍给两条相同音乐 id。它们原本服务跨源匹配，不能原样用于唯一 id 入库。

## 5. 字段转换与正确性

| 本项目字段 | 落雪来源/规则 |
| --- | --- |
| title、artist、bpm | Song 原字段；不继承水鱼 ITEM_OVERRIDES |
| type | standard / dx / utage 分组，沿用本项目小写类型 |
| category | 响应 genres 的 genre → title；与 DX NET 分类兼容层分开 |
| charts[].level | difficulty.level，保留宴谱的问号等原值 |
| charts[].detailLevel | difficulty.level_value，0 是合法宴谱值，不因是假值而覆盖 |
| charts[].charter | difficulty.note_designer，允许空字符串 |
| charts[].notes | 显式 notes.total/tap/hold/slide/touch/break；BUDDY 保留 left/right |
| version | 对该 SD/DX/宴谱组的 difficulty.version 找所属主版本 |
| isNew | 主版本与配置的当前版本相同；不能统一 null，也不能直接用歌曲首次版本 |
| sourceSongId、source | 新增明确来源标识，服务别名、曲绘和导出映射 |
| releaseDate/locked/disabled、原始谱面版本 | 保留落雪信息；不能丢弃后猜测或用水鱼补齐 |

### 5.1 版本与 B50

版本映射采用参考插件的区间规则：对谱面版本 v，取响应 versions 中不大于 v 的最大 version。例如 25506 归 25500，24010 归 24000。不能精确 Map.get，也不能简单整除 1000，因为存在 18500、19500、19900、25500。

本次 1,360 首里有 1,086 首歌曲版本不能被现有精确查询命中。按区间匹配，样本所有谱面均有主版本。

song 30 的歌曲首次版本是 10000，但 DX 谱面版本为 25500：标准谱属于旧曲，DX 谱属于当前版本。必须以拆分后的谱面组版本判定，不用 song.version 给两组同时赋值。

参考插件要求同组谱面属于同一主版本；本次样本同组版本一致。适配器遇到未来同组不同主版本时应拒绝不支持的批次并报告，或单独设计谱面级 isNew；不能擅自挑一个版本。

本项目历史展示使用 green/green+ 等名称，落雪使用 GreeN/GreeN PLUS。为避免无关展示变更，可保留既有显示格式映射，同时记录来源主版本码；这不是额外曲库来源。

定数更正会改变由定数计算的 Rating，这是切换可信曲库的直接影响。当前成绩内已存 rating/isNew，换曲库不会自动让这些派生值更新：需从玩家原始达成率和落雪定数重新计算当前派生结果，保持成绩数值、观测时间、FC/FS、历史原始记录不变。历史展示按发生时还是当前版本计算须沿用原有约定，不能顺便重写历史。

disabled 与未来 release_date 应保存并用于防止不适用谱面参与当前计算；它们带来的 B50/理论值筛选变化须在实施清单与回归结果中明确展示，不能暗称完全无行为变化。locked=true 不能作为排除理由。宴谱仍不参与普通 B50。

### 5.2 难度和物量

不能把数组遍历下标当 difficulty，必须显式读取字段。当前 SyncService 多处使用 charts[chartIndex]，转换后应按难度固定槽位，缺项不能挤压索引；遇到目前结构无法表达的缺项必须明确处理。

普通 Notes 的 total 与五类分项和校验；缺失 notes 时不要填成零。BUDDY 为 {left: Notes, right: Notes}，不符合现有平面类型。需扩展 ChartPayload/消费者；现有 getNotesTotal 无法理解左右结构。左右物量如何用于该项目 DX 分数上限，必须对照 DX NET 宴谱真实成绩验证，不能直接相加假定为一个人的满分；未确认时返回未知而非错误满分。

## 6. 必须覆盖的实际依赖

| 文件/模块 | 必要适配 |
| --- | --- |
| backend/src/modules/music/services/music.service.ts | 将数组式水鱼拉取改为落雪对象式全量同步；notes=true、版本参数；严格校验完整批次再写入 |
| backend/src/common/prober/lxns/transform.ts | 重做为入库可用的分组转换器，修复 ID、版本、isNew、宴谱和 Notes |
| backend/src/modules/music/schemas/music.schema.ts | 明确 sourceSongId、来源、版本/配信信息及 BUDDY 类型；不改已有 ID 字符串格式 |
| backend/src/modules/cover/services/cover.service.ts | 停止 buildCrossIdMap 的水鱼曲库请求和水鱼优先封面；按 sourceSongId 读 assets2 |
| backend/src/modules/music-alias/services/music-alias.service.ts | 仅同步/返回 source=lxns；无需水鱼↔落雪标题匹配，也不混入 YuzuChan |
| backend/src/modules/sync/services/prober-export-map.service.ts | 从本地落雪来源字段构建 toLxnsId；去掉每 6 小时同时请求两源的隐式依赖 |
| backend/src/modules/sync/services/sync.service.ts | 核对分类+标题+类型的成绩匹配、难度槽位和 rating/isNew 物化；失配不静默丢分 |
| backend/src/modules/score-export、shared 的 B50/物量工具 | 核对新旧曲、禁用/未配信、普通物量和 BUDDY；保持原始成绩不变 |
| 环境变量、文档、相关测试 | 使用落雪专用曲库 URL/版本配置，禁止旧 MUSIC_DATA_URL 把在线主源改回水鱼 |

封面不能只改下载 URL：现有 syncAll 会跳过已存在文件，旧水鱼封面会一直留在服务中。建议落雪独立缓存命名空间/来源版本，重新获取并逐步切换；失败时只用已验证的落雪缓存或本地通用占位图，不读取来源不明的旧曲绘。兼容旧对外图片 URL 可在服务内部做映射。

别名不能只停 YuzuChan 同步：现有数据库和 Redis 聚合缓存还可能包含它的旧记录。旧记录可保留归档，但公共查询必须筛选落雪来源、重建缓存。落雪 song_id 同时映射到存在的 SD/DX 记录，不按曲名猜测。

落雪导出映射直接用 sourceSongId 和 type。水鱼导出保留代码，但不得为了它再抓水鱼 music_data；普通曲可验证既有兼容 ID，特殊/无法确认映射的曲目报告不支持。不能以“兼容导出”为由重新信任水鱼曲名或定数。

DX NET 是成绩抓取源，网页标题与落雪显示名可能不同。允许建立经 DX NET 真实页面验证的匹配别名作为内部匹配规则，但不能将水鱼覆盖表原样当成事实来源。必须把失配列表写入验收报告。

## 7. 推荐实施顺序

1. 先编写单一落雪入库适配器与纯转换验证，借鉴 asdfbot 的 ID/版本/物量校验；补齐本项目宴谱支持。
2. 用落雪完整响应构建临时曲库，报告 ID/cid 重复、缺失字段、未知版本/分类、同组多版本、宴谱异常。
3. 读取现有 MongoDB 做只读对照：用户成绩、成绩历史、任务目标 CID、别名、封面索引；确定每个旧引用是否仍可解析。不能只用同名匹配或未经验证的取余替换历史 ID。
4. 将曲库、封面、别名和导出映射一起改为落雪来源，清理/隔离旧缓存读取路径；旧功能代码不删除。
5. 对临时数据执行定数与新旧曲重算对照；列出因来源更正而改变的 Rating/B50，确认不改原始成绩。
6. 执行可回滚的曲库切换并统一失效缓存。现有 persistDocuments 的 bulkWrite 后 deleteMany 不能直接用于首次迁移；校验/网络失败不得清空现有库，也不得部分新库混合旧水鱼数据对外宣称成功。
7. 完成真实 DX NET 抓取与落雪曲库关联验证，再继续 QQ Bot API 改造。

运行期只接受经过完整校验的落雪快照；建议临时集合构建完成后切换，沿用现有同步锁防止双副本并发切换。实际生产切换、派生值重算和服务重启需另行执行，不属于本次报告操作。

首次迁移前的旧水鱼数据可以作为历史引用核查对象与回滚备份，不能作为新曲库缺失字段的补充来源。新库缺少但历史成绩引用的曲目保留原始历史数据并明确列为待处理引用，不擅自删除玩家成绩。

## 8. 验收与本次工作边界

应新增/执行：

- 同歌 SD/DX（30/10030）、小版本（25506）、合法 0 定数、宴谱、BUDDY、乱序/缺失难度、重复 ID/cid 的转换测试。
- 空库/结构损坏/超时不覆盖已有落雪快照；无任何水鱼或其他曲库回退请求。
- 曲库、曲绘、别名、落雪导出端到端只依赖落雪及本地数据；旧水鱼封面/别名缓存不会被误用。
- 历史成绩引用检查、B50 新旧分组和定数重算对照、封面源 ID、宴谱满分语义验证。
- shared/backend/worker 的相关 typecheck、build、tests，以及一次真实 DX NET 更新到成绩查询/图片生成链路。

本次实际完成：官方文档检索；四类公共接口 HTTP 200 验证；全量样本 ID/cid/版本统计；asdfbot 指定提交的静态对照。没有请求水鱼曲库，没有访问生产数据库，没有执行生产迁移，也没有运行项目测试。

尚未验证：现有生产数据与落雪 ID 的完整对应、DX NET 标题匹配覆盖率、BUDDY 满分规则、切换后历史 Rating 展示。不能用本次静态样本统计代替这些验收。

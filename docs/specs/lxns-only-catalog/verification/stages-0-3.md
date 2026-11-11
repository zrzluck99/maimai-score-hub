# 阶段 0–3 实施与验证

本轮实现落雪唯一来源及迁移验证工具。好友保留策略、SDGB 停用、Bot API、完整快照及 asdfbot Provider 接入属于阶段 4–8，本轮未实现。asdfbot 保留 Provider 管理，后续新增 `mai_hub`，不集中迁移其他 Provider。

## 实际变化

- 曲库固定请求落雪 `song/list?version=25500&notes=true`；版本由 `LXNS_GAME_VERSION` 配置。旧 `MUSIC_DATA_URL` 不再影响当前曲库路径。
- 保留 SD 原 ID、DX +10000、宴谱原 ID；难度显式定位，宴谱抓取难度 10 对应本地 CID 的 `_0`。版本按区间归属，旧曲新增 DX 独立计算新曲标记。
- 校验完整批次，保留普通 Notes、BUDDY 左右分项、来源元信息、禁用、锁定和配信日期。BUDDY 的总分上限仍不猜测。
- 使用新集合 `musics_lxns`，候选集合完成写入与索引后原子更名。保留旧 `musics` 和每次切换前的落雪备份；失败不会将部分批次暴露给读者。初次成功同步前不回退旧水鱼曲库。
- 封面只请求 `assets2.lxns.net`；宴谱缺图可尝试落雪同源普通曲绘。缓存目录改为 `covers/lxns-v1`，旧文件保留但不被当前路径读取。图片解码成功后才替换本地文件。
- 别名只请求落雪公开接口，严格校验后原子替换 `music_aliases_lxns`；旧集合和 YuzuChan 代码保留、不进入当前调用链。同步摘要中 YuzuChan 为 `skipped`。
- 导出映射来自本地 `sourceSongId`。水鱼成绩上传功能保留，但只映射可确认的普通 SD/DX 编号，宴谱不猜测，未映射条目继续通过已有 `skipped` 计数报告。
- 曲库、成绩映射、导出映射和别名读取不再复用跨请求旧曲库缓存；并发导出请求仍共用一次进行中的读取。成本是增加本地数据库读取，尚未做生产负载测试。
- 成绩查询和图片当前 Rating 从当前曲库推导；禁用、未配信和宴谱不计入 B50。配信日按 UTC+8 07:00，缺失日期不额外限制，锁定不等于禁用。原始成绩、历史差异、成绩版本和观察时间不因读取而更新。
- DX NET 已观察到成绩但曲目/CID 不匹配时明确失败，不再跳过后提交部分结果。同分类、标题、类型的歧义也会失败，不按同名猜测。未游玩、无任何观察字段的行仍按原逻辑忽略。

## 迁移检查与回滚

所有示例从 `backend` 目录运行。先在数据库副本检查，不要直接部署到旧生产数据上。首次迁移的生产引用核查目前**未完成**。

1. 保存数据库副本、旧封面目录和配置；保存旧 `musics`，不要覆盖它。
2. 获取落雪完整响应至 JSON，显式指定相同游戏版本。
3. 离线检查：

   ```text
   node -r ts-node/register src/scripts/audit-lxns-catalog.ts catalog.json references.json 25500
   ```

   `references.json` 包含 `oldCatalog`、`syncs[].scores`、`scoreChanges`、`jobs[].musicIds`、`aliases[].musicIds`、`covers`。结构见 `backend/test/fixtures/lxns/audit-references.json`。报告列出缺失、歧义、改名、类型变化、Rating 与 B50 差异；发现引用问题退出码为 2。它不会修复、删除或迁移数据。

4. 可用数据库副本的只读账号设置 `CATALOG_AUDIT_MONGO_URI` 和 `CATALOG_AUDIT_DATABASE`，以 `--mongo-copy` 替换 `references.json`。工具读取 `musics/syncs/score_changes/jobs/music_aliases`，不执行写操作；文件系统封面索引需另行提供离线输入。未提供封面索引会明确标为 `not-provided`，不能当作完整验收。
5. 逐项解释报告，验证实际 DX NET 分类、标题和类型匹配。测试通过不等于生产历史兼容。当前自动同步不会替维护者批准历史引用差异，首次部署前必须完成本步骤。
6. 在持有现有 `catalog-sync` 租约的同步路径发布候选库。`publishLxnsCatalog` 返回本次备份集合名。各进程下次读取直接看到新集合；进行中的请求可完成其已读取的旧快照。
7. 回滚同样必须持有该租约：对已记录的 `musics_lxns_backup_<32位十六进制>` 调用 `restoreLxnsCatalog(db, backupName)`。它校验来源、单一修订和内容摘要，通过新候选集合恢复，并保留备份。恢复后重新同步别名；封面独立同源缓存可保留。此函数不是开放的管理 API。
8. 首次切换前还没有落雪备份时，恢复旧部署与配置即可继续使用保留的旧 `musics`；新实现绝不自动回退水鱼。没有生产部署、迁移或重启在本轮执行。

测试数据库演练使用固定独立端口 `127.0.0.1:37029` 和随机 `lxns_test_*` 数据库：

```text
node -r ts-node/register test/lxns-store-smoke.ts
```

它不读取项目的 `MONGODB_URI`，只删除自己创建的随机测试数据库。可额外传入完整曲库和别名 JSON 验证真实响应。

## 跨语言曲库标识

`catalogRevision` 是本项目完整展开记录的摘要，含宴谱与来源元信息、不含同步时间；用于本地批次一致性和备份校验。

`catalogVersion` 是普通 SD/DX 消费契约 `lxns-standard-dx-v1` 的 SHA-256。输入为 UTF-8 紧凑 JSON 数组，无 BOM、无空白、不转义中文；曲目按本地数值 ID 排序，谱面按难度排序。所有数值用十进制字符串，空日期/Notes 用 null：

```text
[协议名, 游戏版本, [
  [本地ID, 落雪ID, standard或dx, 原始标题, 主版本, isNew, disabled, [
    [难度, 定数, 等级, 原始谱面版本, 配信日期, locked, 谱师,
     [total, tap, hold, slide, touch, break]或null]
  ]]
]]
```

此标识校验 ID、评分和谱面消费字段，不代表封面、别名或所有展示字段完全一致。改协议字段必须升级协议名。Python 参考实现在 `backend/test/catalog-compatibility.py`；可传入 asdfbot 只读检出目录，对照其现有解析器的 ID、标题、类型、主版本、新旧曲、禁用和定数。

asdfbot 目前尚未实现该哈希协议，且其解析器未保留谱面配信日期；阶段 7 必须接入同一协议及配信约束，不能把本轮离线一致性测试描述为已完成 Bot 接入。

## 验证证据与限制

- 2026-11-11 最终相关 Jest 验证：15 个套件、86 项测试全部通过。命令：`node node_modules/jest/bin/jest.js --runInBand --silent music.service catalog-sync music-alias cover.service prober-export-map sync.service rating.spec lxns/catalog score-export`。
- `node node_modules/typescript/bin/tsc --noEmit` 通过；改动和新增 TypeScript 文件的 ESLint 检查通过；直接运行 `node node_modules/@nestjs/cli/bin/nest.js build -b swc` 编译 248 个文件成功，未触发 OpenAPI 生成钩子。`git diff --check` 通过。
- 检查环境为 Node 24.21.0，低于项目声明的 Node 版本范围；兼容版本上的部署验证仍需执行。Mongoose 原有 `isNew` 保留字段警告仍存在，本轮未扩大范围重命名该字段。
- 基线见 `baseline.md`；原 OpenAPI 修改另存备份和摘要，本轮未重新生成或覆盖。
- 真实公开响应验证数据见 `live-validation.json`；离线历史引用和派生值对照见 `audit-fixture-report.json`，其中玩家和任务均为合成测试数据。
- 完整落雪响应：1,360 首、1,421 条展开记录、5,623 谱面；未发现 ID/CID 和 DX NET 匹配键冲突。
- MongoDB 7 临时容器实测：完整发布、回滚、索引写入失败、取消、旧集合不变、候选清理；独立别名读写实例看到新快照，非法响应保留上一份。完整真实曲库/别名也通过同一演练。
- 临时容器已停止并自动删除，测试库已清理；公开完整响应仅保留摘要与小型离线样本。asdfbot 参考检出的工作区未发生修改。OpenAPI 文件与实施前备份逐字节相同，SHA-256 为 `d73c51df63f985815d348162b45cf3fcc7e1aa06dfd976a49dc05421ae81dedd`。
- 原始成绩保持、未知曲目失败、当前定数 Rating/B50、图片头部 Rating、同源请求、图片解码失败保留、跨语言哈希均有回归覆盖。
- 仍需生产副本引用审计、真实游戏抓取验证及负载评估。本轮未发送好友申请、删除好友、上传查分器成绩、修改 asdfbot 业务代码或改变默认 Provider。

# 阶段 0 基线

范围固定为实施计划 0–3。asdfbot 保留 Provider 管理，本轮不实现 Bot 接口、不改好友/登录行为。

## 实际检查

- 本项目工作区原有 shared/openapi/openapi.yaml 修改，另有本任务设计文档；已保存原始文件副本与 SHA-256。后续不得通过生成器覆盖该修改。
- asdfbot 参考 HEAD 为 d6676775ce99e14d8b3d61dc703ce7e56af631ba，检查时工作区干净。
- 系统 Node v24.21.0 低于项目声明的 v24.22.1；worker 已安装自己的 Node，可用兼容版本执行后续验证。
- 原始 npm 正则参数被 Windows cmd 解释为管道，未运行测试；改为直接调用 Jest 后成功。
- backend：`node node_modules/jest/bin/jest.js --runInBand --silent music.service catalog-sync music-alias cover.service prober-export-map sync.service rating.spec`：10 suites，53 tests 通过。
- asdfbot：`python -m unittest src.test.test_maimai_luoxue_catalog src.test.test_maimai_luoxue_catalog_migration`：11 tests 通过。
- 基线已有 Mongoose isNew 保留字段警告；本轮不顺手重命名该公共字段。

## 行为保护对象

- 登录好友验证与 30 天 JWT、任务创建默认取消旧任务的原行为本轮不改。
- QQ 绑定、游戏好友关系、网站登录是不同状态；本轮只涉及曲库来源和相关成绩元数据。
- 原始达成率、DX 分数、FC/FS、观测时间、历史成绩记录不因切库改写。
- 本地普通 ID：SD 源 ID、DX 源 ID+10000；宴谱保留原 ID，现有 chartIndex=10 与 cid 后缀 _0 规则不变。
- asdfbot 全量导入为事务替换；需要完整 0..4 普通难度、唯一谱面和合法状态，不能把部分成绩当全量。
- rank：d/c/b/bb/bbb/a/aa/aaa/s/sp/ss/ssp/sss/sssp；FC：空/fc/fcp/ap/app；FS：空/sync/fs/fsp/fsd/fsdp。

## 有意改变的行为

- 在线曲库与歌曲资源只用落雪。旧水鱼、YuzuChan 代码保留但不参与活动同步/查询路径。
- 曲库来源更正可能影响定数、版本、新旧曲、禁用/未配信判定和派生 Rating，必须单独报告。
- 旧封面与别名缓存不得混入落雪结果。首次无有效落雪库时不冒充已有可信数据。

生产数据库未访问、未迁移；真实 DX NET 与历史数据核查不以 fixture 验证替代。

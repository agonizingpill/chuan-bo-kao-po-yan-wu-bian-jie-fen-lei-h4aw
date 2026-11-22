# 初始 schema

`src.models.Base.metadata.create_all()` 按外键顺序建表，由 `src.main` 在 API 首次启动时执行。已有开发卷不执行自动字段迁移。项目 README 记录了模型与首次建库入口。

`create_all` 只为新库创建 `retime_adoptions` 表；已有开发卷需要手动补建该表（含 `candidates` JSON 列与 `idempotency_key` 唯一约束）后才能使用改期预演采纳。

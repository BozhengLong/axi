# 参考源码与校准副本

E基于MIT项目p-memoize，提交49be452fa90183f04d7225b0f46ddd25a915febf。D基于MIT项目p-retry，提交ac3c4cdb7f015e1f71825e4274e2323a49b615eb。原许可证保存在reference/E-license.fixture和reference/D-license.fixture。

primary是对上一轮参考的修正；alternative是对上一轮新Axi产物的人工修复副本，用另一种结构验证契约。它们都是验收校准材料，不是上游已接受的API，也不计为模型成功。原始历史产物、原参考及机判保持原样。原始出处和逐次身份见docs/verification/2026-11-14-v1-review-results.json。

这些文件和保留检查不投递给运行中的候选。公开开发题面在evals/specs/v1-reentry-dev-v1/。

本轮E主参考新增按调用记录的登记资格，替代参考改用预先建立的所有权对象；其登记/失效机制有实质差异。人工修复由同一助手完成，不称独立盲审。

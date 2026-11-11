# 只读目录检查

只检查 `data/` 中的普通文件，包含子目录，文件数不包含目录。计算所有文件内容的总字节数，并读取 `data/project.txt`。

不要创建、修改或删除任何文件。最终回复一个 JSON 对象，不使用 Markdown 代码围栏。字段必须为 `fileCount`、`totalBytes`、`project`、`owner`、`deadline`。后三项来自 project.txt。必须实际读取文件，不能猜测。

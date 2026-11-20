export const version = "0.0.2";

// 发布构建将源提交写入二进制，源码模式无需调用 Git。
declare const AXI_BUILD_COMMIT: string;
export const buildCommit = typeof AXI_BUILD_COMMIT === "string" ? AXI_BUILD_COMMIT : "source";

/**
 * 配置相关错误：API key 缺失、配置文件格式错误、必需字段缺失。
 * 由 src/config/config.ts 抛出。
 *
 * 继承自 Error；构造函数无需重写——Error 已支持 (message, { cause }) 签名。
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

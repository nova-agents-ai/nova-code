/**
 * services/analytics —— 复刻 claude-code 的两层架构。
 *
 * 对齐 claude-code/src/services/analytics/index.ts 的设计：
 *   Layer 1（本文件）：极简门面 —— 零依赖、单一 sink、启动前 eventQueue 暂存
 *   Layer 2（sink.ts）：实际投递 —— ringBuffer + 可选 JSONL 落盘 / 未来可扩 Datadog 等
 *
 * 设计决策（直接复刻 claude-code 文件头注释里的几条）：
 *   1. **DESIGN: This module has NO dependencies to avoid import cycles.** 本文件只用
 *      原生 TS / 标准库内置（`queueMicrotask`），不 import 任何 nova-code 内部模块。
 *   2. Sink attach 前所有 logEvent / logEventAsync 调用入队 `eventQueue`；attach 时
 *      `queueMicrotask` 异步排空，不阻塞启动路径。
 *   3. attachAnalyticsSink **幂等**：已有 sink 时直接 no-op，允许 ChatCommand / AskCommand
 *      / 未来 setup 钩子各自调用而不需要协调谁先谁后。
 *   4. logEvent（同步）与 logEventAsync（返回 Promise）双接口对齐 claude-code，
 *      让需要等待持久化的调用方能 await（如关键退出前的 flush）。
 *
 * 与 claude-code 的差异（M4 简化）：
 *   - 不实现 stripProtoFields / PII proto 字段路由（无 1P / Datadog 后端）
 *   - LogEventMetadata 允许 string —— claude-code 用 marker 类型阻止 string 入参
 *     避免误传 PII；nova-code 暂相信调用方自律（CLAUDE.md §4 风格也提倡显式审查）
 *   - 不做 sample_rate / dynamic config sampling
 */

/** 事件 payload：扁平的 string/number/boolean/null 字典。 */
export type LogEventPayload = Readonly<Record<string, string | number | boolean | null>>;

/** 落盘到 JSONL 时的事件形态。 */
export interface LogEventRecord {
  readonly name: string;
  readonly timestamp: string;
  readonly payload: LogEventPayload;
}

/**
 * Sink 接口 —— 对齐 claude-code AnalyticsSink。
 *
 * - logEvent       同步投递；失败由 sink 内部吸收，永不抛
 * - logEventAsync  返回 Promise，调用方可 await（如退出前 flush）
 *
 * 其他自定义 sink（M9+ 接 Datadog / OTEL 等）只要实现这个 shape 即可。
 */
export interface AnalyticsSink {
  readonly logEvent: (eventName: string, payload?: LogEventPayload) => void;
  readonly logEventAsync: (eventName: string, payload?: LogEventPayload) => Promise<void>;
}

interface QueuedEvent {
  readonly eventName: string;
  readonly payload: LogEventPayload;
  readonly async: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// 内部状态：单一 sink + attach 前的暂存队列
// ────────────────────────────────────────────────────────────────────────────

const eventQueue: QueuedEvent[] = [];
let sink: AnalyticsSink | null = null;

// ────────────────────────────────────────────────────────────────────────────
// 公共 API
// ────────────────────────────────────────────────────────────────────────────

/**
 * 把 sink 接到本门面层。
 *
 * - 幂等：已有 sink 时直接 no-op
 * - 排空 queue：用 `queueMicrotask` 异步排空，**不阻塞启动**
 * - sink 内部抛错被吞，不影响门面层
 *
 * 由 chat / ask 命令在启动时调用一次。库使用者也可注入自定义 sink。
 */
export function attachAnalyticsSink(newSink: AnalyticsSink): void {
  if (sink !== null) return;
  sink = newSink;

  if (eventQueue.length > 0) {
    const drained = [...eventQueue];
    eventQueue.length = 0;
    queueMicrotask(() => {
      for (const ev of drained) {
        try {
          if (ev.async) {
            void newSink.logEventAsync(ev.eventName, ev.payload);
          } else {
            newSink.logEvent(ev.eventName, ev.payload);
          }
        } catch {
          // sink 抛错不能影响其它事件继续 drain
        }
      }
    });
  }
}

/**
 * 同步投递事件。Sink 未附着时入队，attach 时再 queueMicrotask 排空。
 *
 * 永不抛：sink 抛错被本函数吸收。
 */
export function logEvent(eventName: string, payload: LogEventPayload = {}): void {
  if (sink === null) {
    eventQueue.push({ eventName, payload, async: false });
    return;
  }
  try {
    sink.logEvent(eventName, payload);
  } catch {
    // never throw
  }
}

/**
 * 异步投递事件 —— 给"需要等待持久化"的调用方用（如退出前 flush）。
 *
 * Sink 未附着时入队（async=true），attach 时还是用 queueMicrotask 排空，
 * 但这种排空走的是 fire-and-forget；调用方在 attach 之前的 await 不会等到真正写盘。
 * 这是 claude-code 同款语义。
 */
export async function logEventAsync(
  eventName: string,
  payload: LogEventPayload = {},
): Promise<void> {
  if (sink === null) {
    eventQueue.push({ eventName, payload, async: true });
    return;
  }
  try {
    await sink.logEventAsync(eventName, payload);
  } catch {
    // never throw
  }
}

/**
 * 重置门面层。仅用于单测；不在生产路径暴露。
 *
 * 与 claude-code 的 `_resetForTesting` 对齐。命名加下划线前缀强调"非公共 API"。
 */
export function _resetAnalyticsForTests(): void {
  sink = null;
  eventQueue.length = 0;
}

/**
 * 仅给单测窥探当前队列长度的 helper。
 * 生产代码不应读这个；但单测要断言"sink 未 attach 前事件确实入队"必须有这个口子。
 */
export function _peekQueueSizeForTests(): number {
  return eventQueue.length;
}

/** 仅给单测：判断当前 sink 是否已附着。 */
export function _hasSinkForTests(): boolean {
  return sink !== null;
}

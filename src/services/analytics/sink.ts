/**
 * 默认 AnalyticsSink 实现 —— 对齐 claude-code/src/services/analytics/sink.ts
 * 的层级位置（在 index.ts 门面之外的"实际投递层"）。
 *
 * 本 sink 不接任何外部分析后端；nova-code 仅做本地化遥测：
 *   1. 256 条环形 buffer（最近事件）—— 给 future /events 命令准备
 *   2. 可选 JSONL 落盘到 `NOVA_TELEMETRY_FILE`（用 promise 链串行化避免 race）
 *   3. `NOVA_DISABLE_TELEMETRY=1/true` 整体关闭 → 返回 noop sink
 *
 * 与 claude-code 的差异：
 *   - claude-code sink.ts 还做 stripProtoFields + Datadog fanout + 1P firstParty exporter；
 *     本实现仅本地，故 logEvent / logEventAsync 行为等价（async 直接 await 落盘完成）。
 */

import type { AnalyticsSink, LogEventPayload, LogEventRecord } from "./index.ts";

const RING_BUFFER_CAPACITY = 256;

export interface DefaultSinkOptions {
  /** 注入文件路径覆盖 NOVA_TELEMETRY_FILE 的读取，仅用于单测。 */
  readonly telemetryFile?: string;
  /** 注入"是否禁用"覆盖 NOVA_DISABLE_TELEMETRY 的读取，仅用于单测。 */
  readonly disabled?: boolean;
  /** ring buffer 容量（默认 256）；单测可调成更小值便于测溢出。 */
  readonly capacity?: number;
}

/**
 * 创建默认 sink。
 *
 * - 若 disabled = true（或 NOVA_DISABLE_TELEMETRY 设置）→ 返回 noop sink
 *   （logEvent / logEventAsync 都是空函数，buffer 不再积累）
 * - 否则返回带 ringBuffer + 可选 JSONL 落盘的 sink
 *
 * sink 携带 `getBuffer()` 让 future /events 命令能查询最近事件 —— 对齐 claude-code
 * sink 自身持有 fanout state 的分层：buffer 是 sink 的实现细节，门面层 index.ts
 * 不应感知。
 */
export function createDefaultAnalyticsSink(opts: DefaultSinkOptions = {}): DefaultAnalyticsSink {
  const disabled = opts.disabled ?? isDisabledByEnv();
  if (disabled) {
    return {
      logEvent: () => {},
      logEventAsync: async () => {},
      getBuffer: () => [],
    };
  }

  const capacity = opts.capacity ?? RING_BUFFER_CAPACITY;
  const buffer: LogEventRecord[] = [];
  let cursor = 0;

  const telemetryFile = opts.telemetryFile ?? process.env["NOVA_TELEMETRY_FILE"] ?? "";
  // 用 promise 链串行化磁盘写入；Bun.write 是覆盖语义，read-modify-write 在并发下会丢条
  let writeQueue: Promise<void> = Promise.resolve();

  const writeToBuffer = (record: LogEventRecord): void => {
    if (buffer.length < capacity) {
      buffer.push(record);
    } else {
      buffer[cursor] = record;
      cursor = (cursor + 1) % capacity;
    }
  };

  const writeToFile = async (record: LogEventRecord): Promise<void> => {
    if (telemetryFile === "") return;
    try {
      const existing = await safeReadText(telemetryFile);
      await Bun.write(telemetryFile, `${existing}${JSON.stringify(record)}\n`);
    } catch {
      // never throw
    }
  };

  const buildRecord = (eventName: string, payload: LogEventPayload): LogEventRecord => ({
    name: eventName,
    timestamp: new Date().toISOString(),
    payload,
  });

  return {
    logEvent: (eventName, payload = {}) => {
      const record = buildRecord(eventName, payload);
      try {
        writeToBuffer(record);
      } catch {
        // never throw
      }
      // 同步路径：不 await，给 promise 链
      writeQueue = writeQueue.then(() => writeToFile(record));
    },
    logEventAsync: async (eventName, payload = {}) => {
      const record = buildRecord(eventName, payload);
      try {
        writeToBuffer(record);
      } catch {
        // never throw
      }
      writeQueue = writeQueue.then(() => writeToFile(record));
      // async 路径：await 整条 chain，确保返回时该事件已落盘
      await writeQueue;
    },
    getBuffer: () => {
      if (buffer.length < capacity) return [...buffer];
      return [...buffer.slice(cursor), ...buffer.slice(0, cursor)];
    },
  };
}

/** 默认 sink 在 AnalyticsSink 之上多暴露一个 getBuffer，便于 future /events 命令查询。 */
export interface DefaultAnalyticsSink extends AnalyticsSink {
  readonly getBuffer: () => readonly LogEventRecord[];
}

// ────────────────────────────────────────────────────────────────────────────
// 内部
// ────────────────────────────────────────────────────────────────────────────

function isDisabledByEnv(): boolean {
  const v = process.env["NOVA_DISABLE_TELEMETRY"];
  if (v === undefined) return false;
  return v === "1" || v.toLowerCase() === "true";
}

async function safeReadText(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

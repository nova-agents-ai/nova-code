/**
 * Agent loop 超出 maxTurns 上限。
 * 通常意味着模型陷入了工具调用循环，需要人工介入。
 */
export class MaxTurnsExceededError extends Error {
  override readonly name = "MaxTurnsExceededError";
  readonly turns: number;

  constructor(turns: number) {
    super(
      `Agent loop exceeded maxTurns=${turns}. The model kept calling tools without producing a final answer.`,
    );
    this.turns = turns;
  }
}

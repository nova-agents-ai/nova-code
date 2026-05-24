import type { PermissionMode } from "../../types/permissions.ts";

/** Plan Mode 的运行状态。 */
export enum PlanModeStatusEnum {
  INACTIVE = "inactive",
  PLANNING = "planning",
  AWAITING_APPROVAL = "awaitingApproval",
  EXECUTING = "executing",
  REJECTED = "rejected",
}

/** ExitPlanMode 向用户请求批准时的请求体。 */
export interface PlanApprovalRequest {
  readonly plan: string;
}

/** 用户对 plan 的审批结果。 */
export type PlanApprovalDecision = "approved" | "rejected";

/** ExitPlanMode 审批结果。 */
export interface PlanApprovalResult {
  readonly decision: PlanApprovalDecision;
  readonly feedback?: string;
}

/** Plan 审批 provider；chat 走交互式，headless ask 走自动拒绝。 */
export interface PlanApprovalProvider {
  requestPlanApproval(request: PlanApprovalRequest): Promise<PlanApprovalResult>;
}

/** Plan Mode 当前快照；用于 system prompt 注入和 /plan status 展示。 */
export interface PlanModeSnapshot {
  readonly status: PlanModeStatusEnum;
  readonly previousPermissionMode: PermissionMode;
  readonly pendingPlan?: string;
  readonly approvedPlan?: string;
  readonly rejectedPlan?: string;
  readonly rejectionFeedback?: string;
}

/** 进入 Plan Mode 时保留进入前权限模式，批准后恢复。 */
export interface EnterPlanModeParams {
  readonly previousPermissionMode: PermissionMode;
}

/** ExitPlanMode 执行后的状态变更结果。 */
export interface SubmitPlanResult {
  readonly approval: PlanApprovalResult;
  readonly snapshot: PlanModeSnapshot;
}

/** QueryEngine 与工具共享的 Plan Mode 运行时接口。 */
export interface PlanModeRuntime {
  enter(params: EnterPlanModeParams): PlanModeSnapshot;
  submitPlan(plan: string): Promise<SubmitPlanResult>;
  getSnapshot(): PlanModeSnapshot;
  getSystemInstructions(): string | undefined;
  getEffectivePermissionMode(fallback: PermissionMode | undefined): PermissionMode | undefined;
}

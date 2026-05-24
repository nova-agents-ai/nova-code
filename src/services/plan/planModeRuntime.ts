import type { PermissionMode } from "../../types/permissions.ts";
import { formatPlanModeSystemInstructions } from "./prompt.ts";
import {
  type PlanApprovalProvider,
  type PlanApprovalResult,
  type PlanModeRuntime,
  type PlanModeSnapshot,
  PlanModeStatusEnum,
  type SubmitPlanResult,
} from "./types.ts";

const MAX_PLAN_CHARS = 60_000;
const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

export interface CreatePlanModeRuntimeOptions {
  readonly initialPermissionMode?: PermissionMode;
  readonly approvalProvider?: PlanApprovalProvider;
  readonly onPermissionModeChange?: (mode: PermissionMode) => void;
}

/** 构造一次 chat/ask 会话内共享的 Plan Mode 状态机。 */
export function createPlanModeRuntime(options: CreatePlanModeRuntimeOptions = {}): PlanModeRuntime {
  return new DefaultPlanModeRuntime(options);
}

class DefaultPlanModeRuntime implements PlanModeRuntime {
  private snapshot: PlanModeSnapshot;
  private readonly approvalProvider: PlanApprovalProvider | undefined;
  private readonly onPermissionModeChange: ((mode: PermissionMode) => void) | undefined;

  constructor(options: CreatePlanModeRuntimeOptions) {
    const initial = normalizePreviousMode(options.initialPermissionMode);
    this.snapshot = {
      status: PlanModeStatusEnum.INACTIVE,
      previousPermissionMode: initial,
    };
    this.approvalProvider = options.approvalProvider;
    this.onPermissionModeChange = options.onPermissionModeChange;
  }

  enter(params: { readonly previousPermissionMode: PermissionMode }): PlanModeSnapshot {
    const previous = normalizePreviousMode(params.previousPermissionMode);
    this.snapshot = {
      status: PlanModeStatusEnum.PLANNING,
      previousPermissionMode: previous,
    };
    this.onPermissionModeChange?.("plan");
    return this.snapshot;
  }

  async submitPlan(plan: string): Promise<SubmitPlanResult> {
    const normalizedPlan = normalizePlan(plan);
    ensurePlanCanBeSubmitted(this.snapshot);
    this.snapshot = {
      status: PlanModeStatusEnum.AWAITING_APPROVAL,
      previousPermissionMode: this.snapshot.previousPermissionMode,
      pendingPlan: normalizedPlan,
    };
    const approval = await this.requestApproval(normalizedPlan);
    this.snapshot = toPostApprovalSnapshot(this.snapshot, normalizedPlan, approval);
    this.onPermissionModeChange?.(this.getEffectiveModeAfterApproval(approval));
    return { approval, snapshot: this.snapshot };
  }

  getSnapshot(): PlanModeSnapshot {
    return this.snapshot;
  }

  getSystemInstructions(): string | undefined {
    return formatPlanModeSystemInstructions(this.snapshot);
  }

  getEffectivePermissionMode(fallback: PermissionMode | undefined): PermissionMode | undefined {
    if (isBlockingPlanStatus(this.snapshot.status)) return "plan";
    if (this.snapshot.status === PlanModeStatusEnum.EXECUTING) {
      return this.snapshot.previousPermissionMode;
    }
    return fallback;
  }

  private async requestApproval(plan: string): Promise<PlanApprovalResult> {
    if (this.approvalProvider === undefined) {
      return {
        decision: "rejected",
        feedback: "Plan approval provider is not configured.",
      };
    }
    return await this.approvalProvider.requestPlanApproval({ plan });
  }

  private getEffectiveModeAfterApproval(approval: PlanApprovalResult): PermissionMode {
    if (approval.decision === "approved") return this.snapshot.previousPermissionMode;
    return "plan";
  }
}

function normalizePreviousMode(mode: PermissionMode | undefined): PermissionMode {
  if (mode === undefined || mode === "plan") return DEFAULT_PERMISSION_MODE;
  return mode;
}

function normalizePlan(plan: string): string {
  const trimmed = plan.trim();
  if (trimmed === "") {
    throw new Error("ExitPlanMode requires a non-empty plan.");
  }
  if (trimmed.length > MAX_PLAN_CHARS) {
    throw new Error(`ExitPlanMode plan must be at most ${MAX_PLAN_CHARS} characters.`);
  }
  return trimmed;
}

function ensurePlanCanBeSubmitted(snapshot: PlanModeSnapshot): void {
  if (
    snapshot.status === PlanModeStatusEnum.PLANNING ||
    snapshot.status === PlanModeStatusEnum.REJECTED ||
    snapshot.status === PlanModeStatusEnum.AWAITING_APPROVAL
  ) {
    return;
  }
  throw new Error("ExitPlanMode can only be used while Plan Mode is active.");
}

function toPostApprovalSnapshot(
  current: PlanModeSnapshot,
  plan: string,
  approval: PlanApprovalResult,
): PlanModeSnapshot {
  if (approval.decision === "approved") {
    return {
      status: PlanModeStatusEnum.EXECUTING,
      previousPermissionMode: current.previousPermissionMode,
      approvedPlan: plan,
    };
  }
  return {
    status: PlanModeStatusEnum.REJECTED,
    previousPermissionMode: current.previousPermissionMode,
    rejectedPlan: plan,
    ...(approval.feedback !== undefined ? { rejectionFeedback: approval.feedback } : {}),
  };
}

function isBlockingPlanStatus(status: PlanModeStatusEnum): boolean {
  return (
    status === PlanModeStatusEnum.PLANNING ||
    status === PlanModeStatusEnum.AWAITING_APPROVAL ||
    status === PlanModeStatusEnum.REJECTED
  );
}

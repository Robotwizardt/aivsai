/**
 * 工作台服务：邀请码兑换、工作台凭证与恢复码管理（ADR 0002）。
 *
 * 首版数据全部保存在内存 Map 中，接口按可替换存储设计，后续可换 DB。
 * 凭证与恢复码只在创建/重置时以明文返回一次，存储层仅保留 sha256 哈希。
 */

import { createHash, randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';

/** 工作台记录（存储层视角，不含任何明文凭证）。 */
export interface WorkspaceRecord {
  readonly id: string;
  nickname: string | null;
  readonly createdAt: number;
  /** 当前工作台凭证哈希；重置即替换，旧凭证随之失效。 */
  credentialHash: string;
  /** 当前恢复码哈希；每次成功恢复后更换。 */
  recoveryCodeHash: string;
  /** 首次出厂恢复码是否已被使用过（历史标记，不影响新恢复码继续使用）。 */
  recoveryUsed: boolean;
  status: 'active';
}

/** 兑换/重置成功时一次性返回的明文凭据。 */
export interface CredentialBundle {
  readonly workspaceId: string;
  readonly credential: string;
  readonly recoveryCode: string;
}

export interface WorkspaceServiceDeps {
  /**
   * 工作台凭证恢复时触发的联动失效（ADR 0002 恢复规则）：
   * 作废该工作台下全部对象凭证与既有会话。
   */
  onWorkspaceReset?: (workspaceId: string) => void;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class WorkspaceService {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  /** credentialHash -> workspaceId */
  private readonly credentialIndex = new Map<string, string>();
  /** 未使用的邀请码 */
  private readonly inviteCodes = new Set<string>();
  /** 已兑换（一次性作废）的邀请码 */
  private readonly consumedInviteCodes = new Set<string>();
  private readonly deps: WorkspaceServiceDeps;

  constructor(deps: WorkspaceServiceDeps = {}) {
    this.deps = deps;
  }

  /** 管理员预置邀请码。 */
  addInviteCode(code: string): void {
    const trimmed = code.trim();
    if (!trimmed) throw new Error('邀请码不能为空');
    this.inviteCodes.add(trimmed);
  }

  /** 管理概览统计（仅计数，不含任何凭证哈希）。 */
  stats(): {
    workspaces: number;
    pendingInviteCodes: number;
    consumedInviteCodes: number;
  } {
    return {
      workspaces: this.workspaces.size,
      pendingInviteCodes: this.inviteCodes.size,
      consumedInviteCodes: this.consumedInviteCodes.size,
    };
  }

  /** 工作台概览（管理视角，不含凭证）。 */
  listWorkspaces(): Array<{
    id: string;
    nickname: string | null;
    createdAt: number;
  }> {
    return [...this.workspaces.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((w) => ({ id: w.id, nickname: w.nickname, createdAt: w.createdAt }));
  }

  /** 未兑换邀请码列表（管理视角；已兑换的码一次性作废，不再返回）。 */
  listPendingInviteCodes(): string[] {
    return [...this.inviteCodes];
  }

  /**
   * 校验邀请码（一次性作废）并创建工作台。
   * 邀请码无效或已被兑换时返回 null。
   */
  createWorkspace(inviteCode: string, nickname?: string | null): CredentialBundle | null {
    const code = typeof inviteCode === 'string' ? inviteCode.trim() : '';
    if (!code) return null;
    if (this.consumedInviteCodes.has(code) || !this.inviteCodes.has(code)) return null;
    this.inviteCodes.delete(code);
    this.consumedInviteCodes.add(code);

    const id = randomUUID();
    const credential = nanoid(32);
    const recoveryCode = nanoid(32);
    const record: WorkspaceRecord = {
      id,
      nickname: typeof nickname === 'string' && nickname.trim() ? nickname.trim() : null,
      createdAt: Date.now(),
      credentialHash: sha256(credential),
      recoveryCodeHash: sha256(recoveryCode),
      recoveryUsed: false,
      status: 'active',
    };
    this.workspaces.set(id, record);
    this.credentialIndex.set(record.credentialHash, id);
    return { workspaceId: id, credential, recoveryCode };
  }

  /**
   * 凭恢复码重置工作台凭证（ADR 0002 恢复规则）：
   * - 验证 recoveryCodeHash，不匹配返回 null；
   * - 生成新工作台凭证与新恢复码，旧凭证/旧恢复码随之失效；
   * - 通过 onWorkspaceReset 联动作废该工作台下全部对象凭证与既有会话。
   *
   * 本实现中凭证为无状态 Bearer（哈希即会话），替换哈希即等于吊销旧会话；
   * 会话表留待引入有状态会话时扩展。
   */
  resetCredential(
    workspaceId: string,
    recoveryCode: string,
    newCredential?: string,
  ): CredentialBundle | null {
    const record = this.workspaces.get(workspaceId);
    if (!record) return null;
    if (typeof recoveryCode !== 'string' || !recoveryCode) return null;
    if (sha256(recoveryCode) !== record.recoveryCodeHash) return null;

    const credential = newCredential ?? nanoid(32);
    const nextRecoveryCode = nanoid(32);

    this.credentialIndex.delete(record.credentialHash);
    record.credentialHash = sha256(credential);
    record.recoveryCodeHash = sha256(nextRecoveryCode);
    record.recoveryUsed = true;
    this.credentialIndex.set(record.credentialHash, workspaceId);

    this.deps.onWorkspaceReset?.(workspaceId);

    return { workspaceId, credential, recoveryCode: nextRecoveryCode };
  }

  /** 由明文凭证定位工作台（认证用）。 */
  findByCredential(token: string): WorkspaceRecord | null {
    const id = this.credentialIndex.get(sha256(token));
    if (!id) return null;
    return this.workspaces.get(id) ?? null;
  }

  get(workspaceId: string): WorkspaceRecord | null {
    return this.workspaces.get(workspaceId) ?? null;
  }
}

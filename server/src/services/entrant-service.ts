/**
 * 参赛对象服务：工作台内按配额创建参赛对象、对象凭证的颁发与吊销（ADR 0002）。
 *
 * 外观 appearance 仅存储展示信息，不参与战斗（由界面层决定）。
 * 首版数据保存在内存 Map，接口按可替换存储设计。
 */

import { createHash, randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';

/** 参赛对象外观：仅影响展示，不参与战斗。 */
export interface Appearance {
  preset: string;
  color: string;
  name: string;
  customImageUrl?: string;
}

export interface EntrantRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly gameId: string;
  name: string;
  appearance: Appearance;
  readonly createdAt: number;
}

export interface CreateEntrantInput {
  gameId: string;
  name: string;
  appearance: Appearance;
}

export class EntrantQuotaExceededError extends Error {
  constructor(readonly workspaceId: string, readonly quota: number) {
    super(`参赛对象配额已满（上限 ${quota}）`);
    this.name = 'EntrantQuotaExceededError';
  }
}

export interface EntrantServiceDeps {
  /** 每工作台参赛对象配额，默认 10。 */
  defaultQuota?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class EntrantService {
  private readonly entrants = new Map<string, EntrantRecord>();
  /** workspaceId -> entrantId[] */
  private readonly byWorkspace = new Map<string, string[]>();
  /** entrantCredentialHash -> entrantId */
  private readonly credentialIndex = new Map<string, string>();
  /** entrantId -> 该对象当前有效的凭证哈希集合 */
  private readonly activeCredentialHashes = new Map<string, Set<string>>();
  private readonly quota: number;

  constructor(deps: EntrantServiceDeps = {}) {
    this.quota = deps.defaultQuota ?? 10;
  }

  /** 在工作台下创建参赛对象（受配额限制）。 */
  createEntrant(workspaceId: string, input: CreateEntrantInput): EntrantRecord {
    const existing = this.byWorkspace.get(workspaceId);
    if (existing && existing.length >= this.quota) {
      throw new EntrantQuotaExceededError(workspaceId, this.quota);
    }
    const record: EntrantRecord = {
      id: randomUUID(),
      workspaceId,
      gameId: input.gameId,
      name: input.name,
      appearance: input.appearance,
      createdAt: Date.now(),
    };
    this.entrants.set(record.id, record);
    const list = this.byWorkspace.get(workspaceId) ?? [];
    list.push(record.id);
    this.byWorkspace.set(workspaceId, list);
    return record;
  }

  listByWorkspace(workspaceId: string): EntrantRecord[] {
    return (this.byWorkspace.get(workspaceId) ?? []).map((id) => this.entrants.get(id)!);
  }

  get(entrantId: string): EntrantRecord | null {
    return this.entrants.get(entrantId) ?? null;
  }

  /** 全部参赛对象（管理/诊断用）。 */
  listAll(): EntrantRecord[] {
    return [...this.entrants.values()];
  }

  countByWorkspace(workspaceId: string): number {
    return this.byWorkspace.get(workspaceId)?.length ?? 0;
  }

  /**
   * 为参赛对象颁发对象凭证（委托外部 Agent 管理该对象时使用的凭据）。
   * 明文只返回一次，存储层仅保留哈希；归属该对象所在工作台。
   */
  issueEntrantCredential(entrantId: string): string | null {
    if (!this.entrants.has(entrantId)) return null;
    const token = nanoid(32);
    const hash = sha256(token);
    this.credentialIndex.set(hash, entrantId);
    const hashes = this.activeCredentialHashes.get(entrantId) ?? new Set<string>();
    hashes.add(hash);
    this.activeCredentialHashes.set(entrantId, hashes);
    return token;
  }

  /** 吊销该参赛对象的全部对象凭证。 */
  revokeEntrantCredentials(entrantId: string): void {
    const hashes = this.activeCredentialHashes.get(entrantId);
    if (!hashes) return;
    for (const hash of hashes) this.credentialIndex.delete(hash);
    this.activeCredentialHashes.set(entrantId, new Set());
  }

  /** 工作台凭证恢复时联动吊销（ADR 0002）：作废该工作台下全部对象凭证。 */
  revokeAllForWorkspace(workspaceId: string): void {
    for (const entrantId of this.byWorkspace.get(workspaceId) ?? []) {
      this.revokeEntrantCredentials(entrantId);
    }
  }

  /** 由明文对象凭证定位参赛对象；无效返回 null。 */
  findByCredential(token: string): { entrantId: string; workspaceId: string } | null {
    const entrantId = this.credentialIndex.get(sha256(token));
    if (!entrantId) return null;
    const record = this.entrants.get(entrantId);
    if (!record) return null;
    return { entrantId, workspaceId: record.workspaceId };
  }
}

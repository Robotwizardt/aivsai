/**
 * 策略服务：草稿保存与不可变的策略版本（ADR 0002 / 0004）。
 *
 * - 策略源码默认私密；公开是版本级选择（publish 的 publicVisible，默认 false）。
 * - 对局创建时固定策略版本（版本不可变），后续发布不影响既有版本。
 * - 首版数据保存在内存 Map，接口按可替换存储设计。
 */

export interface StrategyVersion {
  /** 从 1 开始递增。 */
  readonly versionId: number;
  readonly entrantId: string;
  readonly source: string;
  /** 版本级可见性：默认 false（源码私密，ADR 0002）。 */
  readonly publicVisible: boolean;
  readonly createdAt: number;
}

export interface EntrantDraft {
  readonly entrantId: string;
  source: string;
  readonly updatedAt: number;
}

export class StrategyService {
  /** entrantId -> 按发布顺序排列的版本（版本不可变，仅追加）。 */
  private readonly versions = new Map<string, StrategyVersion[]>();
  /** entrantId -> 草稿 */
  private readonly drafts = new Map<string, EntrantDraft>();

  /** 保存草稿（不产生版本，不参与对局，可反复覆盖）。 */
  saveDraft(entrantId: string, source: string): EntrantDraft {
    const draft: EntrantDraft = { entrantId, source, updatedAt: Date.now() };
    this.drafts.set(entrantId, draft);
    return draft;
  }

  /** 发布策略：生成新版本（versionId 递增），版本内容不可变。 */
  publish(entrantId: string, source: string, publicVisible = false): StrategyVersion {
    const list = this.versions.get(entrantId) ?? [];
    const version: StrategyVersion = {
      versionId: list.length + 1,
      entrantId,
      source,
      publicVisible,
      createdAt: Date.now(),
    };
    list.push(version);
    this.versions.set(entrantId, list);
    return version;
  }

  listVersions(entrantId: string): StrategyVersion[] {
    return [...(this.versions.get(entrantId) ?? [])];
  }

  /** 全平台已发布版本总数（管理概览用）。 */
  countAllVersions(): number {
    let total = 0;
    for (const list of this.versions.values()) total += list.length;
    return total;
  }

  getVersion(entrantId: string, versionId: number): StrategyVersion | null {
    return (this.versions.get(entrantId) ?? []).find((v) => v.versionId === versionId) ?? null;
  }

  getDraft(entrantId: string): EntrantDraft | null {
    return this.drafts.get(entrantId) ?? null;
  }
}

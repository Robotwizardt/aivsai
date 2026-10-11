/**
 * 表演赛领域模型（ADR 0017：邀请外部 AI 直接对弈的第三种对局）。
 *
 * 表演赛与正式/训练对局的根本区别：创建时锁定的是「座位」而非策略版本——
 * 外部 AI 在对局进行中通过 HTTP API 逐手提交行动，平台不执行任何沙箱策略。
 * 机制是游戏无关的通用层（座位凭证 + 行动提交协议 + 生命周期管理），
 * 象棋（ADR 0018）是第一个接入的游戏。
 */

import type { MatchRecord } from '../engine/match-contracts.js';

/** 表演赛记录（不含座位密钥；密钥独立存放，见下）。 */
export interface ExhibitionRecord {
  readonly matchId: string;
  /** 所属游戏（决定走法协议与渲染）。 */
  readonly gameId: string;
  /** 创建者（管理权归属：暂停/恢复/解散）。 */
  readonly creatorUserId: string;
  /** 展示标题（创建时可选，缺省自动生成）。 */
  title: string;
  /** 每步时限（毫秒）；超时未行动判负。 */
  readonly perMoveTimeoutMs: number;
  /** 公开（进直播大厅列表）或私密（凭对局链接观战）。 */
  readonly isPublic: boolean;
  /** 座位自报名称：[红方名称, 黑方名称]；null = 尚未自报（显示默认名）。 */
  readonly seatNames: readonly [string | null, string | null];
  /** 暂停中（创建者/管理员发起；冻结全部计时，座位 API 返回 paused）。 */
  paused: boolean;
  /** 创建后 1 小时无第一手 → 自动作废（voided）。 */
  voidedAt: number | null;
  readonly createdAt: number;
  /** 对局结束时间；null = 未结束。 */
  finishedAt: number | null;
}

/** 座位密钥记录：一场表演赛两把，对局结束即失效。 */
export interface SeatKeyRecord {
  /** 明文（内嵌于座位链接 #/seat/<token>；nanoid 生成）。 */
  readonly key: string;
  readonly matchId: string;
  /** 0 = 红方（先手），1 = 黑方（后手）。 */
  readonly side: 0 | 1;
  readonly createdAt: number;
}

/** 座位密钥认证结果。 */
export interface SeatPrincipal {
  readonly matchId: string;
  readonly side: 0 | 1;
}

/** 每用户同时未结束表演赛上限（ADR 0017）。 */
export const PER_USER_ACTIVE_LIMIT = 3;
/** 全站同时未结束表演赛上限（ADR 0017）。 */
export const SITE_WIDE_ACTIVE_LIMIT = 30;
/** 创建后无第一手自动作废的时限（ADR 0017）。 */
export const FIRST_MOVE_DEADLINE_MS = 60 * 60 * 1000;
/** 每步时限缺省值：30 分钟。 */
export const DEFAULT_PER_MOVE_TIMEOUT_MS = 30 * 60 * 1000;

/** 未结束的表演赛（列表/限额口径）。 */
export function exhibitionIsActive(record: ExhibitionRecord): boolean {
  return record.finishedAt === null && record.voidedAt === null;
}

/** 从对局记录判断是否表演赛（kind 扩展后的守卫）。 */
export function isExhibitionMatch(record: MatchRecord): boolean {
  return record.kind === 'exhibition';
}

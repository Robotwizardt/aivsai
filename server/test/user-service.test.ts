/**
 * UserService 单元测试（ADR 0015：账号密码体系）。
 * 覆盖：注册（邀请码）、登录（会话令牌）、恢复码重置密码、
 * 昵称、admin 管理（角色/封禁/兜底重置）、会话吊销、持久化。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, type SQLiteDatabase } from '../src/db/database.js';
import { UserService } from '../src/services/user-service.js';

let db: SQLiteDatabase;
let service: UserService;

beforeEach(() => {
  db = initDatabase(':memory:');
  service = new UserService(db);
  service.addInviteCode('INVITE-A');
  service.addInviteCode('INVITE-B');
  service.addInviteCode('INVITE-C');
  service.addInviteCode('INVITE-D');
  service.addInviteCode('INVITE-E');
  service.addInviteCode('INVITE-F');
});

describe('注册', () => {
  it('凭有效邀请码注册：返回恢复码（一次性展示），用户名唯一', () => {
    const result = service.register('INVITE-A', 'alice', 'password-123', '爱丽丝');
    expect(result).not.toBeNull();
    expect(result!.recoveryCode).toBeTruthy();
    const user = service.get(result!.userId);
    expect(user).toMatchObject({
      username: 'alice',
      nickname: '爱丽丝',
      role: 'user',
      banned: false,
    });
    // 密码哈希不落明文
    expect(JSON.stringify(user)).not.toContain('password-123');
  });

  it('无昵称可注册（昵称可后补）', () => {
    const result = service.register('INVITE-A', 'bob', 'pw-123');
    expect(result).not.toBeNull();
    expect(service.get(result!.userId)?.nickname).toBeNull();
  });

  it('邀请码无效/已兑换 → null；兑换后码作废', () => {
    expect(service.register('NOPE', 'x', 'pw-123')).toBeNull();
    expect(service.register('INVITE-A', 'alice', 'pw-123')).not.toBeNull();
    // 同一码第二次兑换失败
    expect(service.register('INVITE-A', 'bob', 'pw-123')).toBeNull();
  });

  it('用户名重复 → taken', () => {
    service.register('INVITE-A', 'alice', 'pw-123');
    const dup = service.register('INVITE-B', 'alice', 'pw-456');
    expect(dup).toBe('taken');
  });

  it('用户名/密码/邀请码空白 → null', () => {
    expect(service.register('INVITE-A', '', 'pw-123')).toBeNull();
    expect(service.register('INVITE-A', '  ', 'pw-123')).toBeNull();
    expect(service.register('INVITE-A', 'x', '')).toBeNull();
    expect(service.register('  ', 'x', 'pw-123')).toBeNull();
  });
});

describe('登录与会话', () => {
  it('登录成功返回会话令牌；令牌可定位用户；登出后令牌失效', () => {
    const { userId } = service.register('INVITE-A', 'alice', 'password-123')!;
    const session = service.login('alice', 'password-123');
    expect(session).not.toBeNull();
    expect(session!.userId).toBe(userId);
    expect(session!.token).toBeTruthy();

    // 会话定位
    const byToken = service.findBySessionToken(session!.token);
    expect(byToken?.id).toBe(userId);

    // 登出（吊销）
    expect(service.logout(session!.token)).toBe(true);
    expect(service.findBySessionToken(session!.token)).toBeNull();
    expect(service.logout(session!.token)).toBe(false);
  });

  it('密码错误/用户不存在 → null', () => {
    service.register('INVITE-A', 'alice', 'password-123');
    expect(service.login('alice', 'wrong-pw')).toBeNull();
    expect(service.login('nobody', 'password-123')).toBeNull();
  });

  it('同一用户可多会话并存，吊销一个不影响另一个', () => {
    const { userId } = service.register('INVITE-A', 'alice', 'pw-123')!;
    const s1 = service.login('alice', 'pw-123')!;
    const s2 = service.login('alice', 'pw-123')!;
    expect(service.findBySessionToken(s1.token)?.id).toBe(userId);
    expect(service.findBySessionToken(s2.token)?.id).toBe(userId);
    service.logout(s1.token);
    expect(service.findBySessionToken(s2.token)?.id).toBe(userId);
  });

  it('封禁用户无法登录；已有会话立即失效', () => {
    const { userId } = service.register('INVITE-A', 'alice', 'pw-123')!;
    const session = service.login('alice', 'pw-123')!;
    service.setBanned(userId, true);
    expect(service.login('alice', 'pw-123')).toBeNull();
    expect(service.findBySessionToken(session.token)).toBeNull();
    // 解封后可再登录
    service.setBanned(userId, false);
    expect(service.login('alice', 'pw-123')).not.toBeNull();
  });
});

describe('恢复码', () => {
  it('凭恢复码重置密码：旧密码失效、新密码可登录、旧会话全部吊销、恢复码轮换', () => {
    const reg = service.register('INVITE-A', 'alice', 'old-pw-123')!;
    const session = service.login('alice', 'old-pw-123')!;
    const reset = service.resetPasswordByRecoveryCode('alice', reg.recoveryCode, 'new-pw-456');
    expect(reset).toBe(true);
    // 旧密码失效
    expect(service.login('alice', 'old-pw-123')).toBeNull();
    expect(service.login('alice', 'new-pw-456')).not.toBeNull();
    // 旧会话吊销
    expect(service.findBySessionToken(session.token)).toBeNull();
    // 旧恢复码作废，新恢复码在管理员视角可查
    expect(service.resetPasswordByRecoveryCode('alice', reg.recoveryCode, 'x')).toBe(false);
    expect(service.getRecoveryCode('alice')).toBeTruthy();
    expect(service.getRecoveryCode('alice')).not.toBe(reg.recoveryCode);
  });

  it('恢复码错误/用户不存在 → false', () => {
    service.register('INVITE-A', 'alice', 'pw-123');
    expect(service.resetPasswordByRecoveryCode('alice', 'wrong-code', 'x')).toBe(false);
    expect(service.resetPasswordByRecoveryCode('nobody', 'whatever', 'x')).toBe(false);
  });
});

describe('昵称', () => {
  it('改昵称即时生效；空昵称拒绝；不存在用户 → null', () => {
    const { userId } = service.register('INVITE-A', 'alice', 'pw-123', '旧名')!;
    expect(service.rename(userId, '新名')).toBe(true);
    expect(service.get(userId)?.nickname).toBe('新名');
    expect(service.rename(userId, '  ')).toBe(false);
    expect(service.rename('no-such-user', 'x')).toBeNull();
  });

  it('昵称不要求唯一（用户名才是唯一标识）', () => {
    const a = service.register('INVITE-A', 'alice', 'pw-123', '同名')!;
    const b = service.register('INVITE-B', 'bob', 'pw-123', '同名')!;
    expect(service.rename(a.userId, '还是同名')).toBe(true);
    expect(service.rename(b.userId, '还是同名')).toBe(true);
  });
});

describe('管理员', () => {
  it('首个 admin 由种子创建；重复种子幂等', () => {
    expect(service.seedAdmin('root', 'root-pw-123')).toBe(true);
    const root = service.getByUsername('root');
    expect(root?.role).toBe('admin');
    // 重复种子：已存在则更新密码，不报错
    expect(service.seedAdmin('root', 'new-pw-789')).toBe(true);
    expect(service.login('root', 'new-pw-789')).not.toBeNull();
  });

  it('角色切换：提权/降级；不存在用户 → null', () => {
    const { userId } = service.register('INVITE-A', 'alice', 'pw-123')!;
    expect(service.setRole(userId, 'admin')).toBe(true);
    expect(service.get(userId)?.role).toBe('admin');
    expect(service.setRole(userId, 'user')).toBe(true);
    expect(service.get(userId)?.role).toBe('user');
    expect(service.setRole('no-such', 'admin')).toBeNull();
  });

  it('降级 admin 时其现有会话保留但失去 admin 权限（会话解析带角色）', () => {
    service.seedAdmin('root', 'root-pw-123');
    service.register('INVITE-A', 'alice', 'pw-123');
    const session = service.login('root', 'root-pw-123')!;
    expect(service.findBySessionToken(session.token)?.role).toBe('admin');
    const root = service.getByUsername('root')!;
    service.setRole(root.id, 'user');
    expect(service.findBySessionToken(session.token)?.role).toBe('user');
  });

  it('admin 兜底重置：生成一次性新密码，旧会话吊销，恢复码轮换', () => {
    const reg = service.register('INVITE-A', 'alice', 'old-pw-123')!;
    const session = service.login('alice', 'old-pw-123')!;
    const reset = service.adminResetPassword(reg.userId);
    expect(reset).not.toBeNull();
    expect(reset!.newPassword).toBeTruthy();
    expect(service.login('alice', 'old-pw-123')).toBeNull();
    expect(service.login('alice', reset!.newPassword)).not.toBeNull();
    expect(service.findBySessionToken(session.token)).toBeNull();
    // 旧恢复码作废
    expect(service.resetPasswordByRecoveryCode('alice', reg.recoveryCode, 'x')).toBe(false);
    // 新恢复码可查
    expect(service.getRecoveryCode('alice')).toBeTruthy();
  });

  it('管理列表：列出全部用户（含角色与封禁状态）', () => {
    service.seedAdmin('root', 'root-pw-123');
    const { userId } = service.register('INVITE-A', 'alice', 'pw-123')!;
    service.setBanned(userId, true);
    const list = service.listUsers();
    expect(list).toHaveLength(2);
    const alice = list.find((u) => u.username === 'alice');
    expect(alice).toMatchObject({ role: 'user', banned: true });
    const root = list.find((u) => u.username === 'root');
    expect(root?.role).toBe('admin');
  });

  it('邀请码管理：增/撤销/未兑换列表', () => {
    service.addInviteCode('EXTRA-1');
    service.addInviteCode('EXTRA-2');
    expect(service.listPendingInviteCodes()).toEqual(
      expect.arrayContaining(['INVITE-A', 'EXTRA-1', 'EXTRA-2']),
    );
    expect(service.revokeInviteCode('EXTRA-1')).toBe(true);
    expect(service.revokeInviteCode('EXTRA-1')).toBe(false); // 已撤销
    service.register('INVITE-B', 'x_user', 'pw-123');
    expect(service.revokeInviteCode('INVITE-B')).toBe(false); // 已兑换不可撤
    expect(service.revokeInviteCode('NOT-EXIST')).toBe(false); // 不存在
    expect(service.revokeInviteCode('INVITE-C')).toBe(true); // 未兑换可撤
  });
});

describe('持久化', () => {
  it('用户/会话/恢复码/邀请码跨重开仍在，会话仍可认证', () => {
    const path = `./.scratch/user-service-persist-${Date.now()}.db`;
    const first = new UserService(initDatabase(path));
    first.addInviteCode('PERSIST-1');
    const reg = first.register('PERSIST-1', 'carol', 'pw-123', '卡罗尔')!;
    const session = first.login('carol', 'pw-123')!;

    const second = new UserService(initDatabase(path));
    expect(second.get(reg.userId)).toMatchObject({
      username: 'carol',
      nickname: '卡罗尔',
      role: 'user',
      banned: false,
    });
    expect(second.findBySessionToken(session.token)?.id).toBe(reg.userId);
    expect(second.login('carol', 'pw-123')).not.toBeNull();
    expect(second.getRecoveryCode('carol')).toBeTruthy();
    // 邀请码已兑换
    expect(second.register('PERSIST-1', 'dave', 'pw')).toBeNull();
  });
});

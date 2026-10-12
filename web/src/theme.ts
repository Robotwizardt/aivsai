/** 网页主题只影响界面，不改变游戏画面或参赛方颜色。 */
export const THEMES = [
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' },
  { id: 'paper', name: '暖纸' },
  { id: 'forest', name: '森林' },
] as const;

export type Theme = (typeof THEMES)[number]['id'];
export const THEME_STORAGE_KEY = 'aivsai:theme';

export function parseTheme(value: unknown): Theme {
  return THEMES.find((theme) => theme.id === value)?.id ?? 'light';
}

export function readTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // 浏览器禁用存储时，仍可正常使用页面和切换主题。
    return 'light';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 存储不可用时，本次页面内的选择仍然生效。
  }
}

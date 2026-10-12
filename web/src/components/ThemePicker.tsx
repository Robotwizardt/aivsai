import { useEffect, useState } from 'react';
import { applyTheme, parseTheme, readTheme, saveTheme, THEMES, THEME_STORAGE_KEY } from '../theme';

/** 原生选择框保留键盘操作和手机系统选择器。 */
export function ThemePicker(): JSX.Element {
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      const next = readTheme();
      applyTheme(next);
      setTheme(next);
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  return (
    <label className="theme-picker">
      <span>主题</span>
      <select
        aria-label="切换主题"
        value={theme}
        onChange={(event) => {
          const next = parseTheme(event.target.value);
          saveTheme(next);
          setTheme(next);
        }}
      >
        {THEMES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
  );
}

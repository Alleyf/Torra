/**
 * 主题：用户选的「模式」与系统实际渲染出来的「明暗」是两件事。
 *
 * mode 是持久化的意图（白天 / 黑夜 / 跟随系统），resolved 是这一刻该套哪套
 * token —— 只有 resolved 会写进 <html data-theme>。分开是因为「跟随系统」
 * 会随操作系统变，而用户的选择不能跟着被改写。
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export type ThemeResolved = 'light' | 'dark'

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system']

/** 默认黑夜：应用长期只有深色外观，切主题不能顺带改变用户的既有观感 */
export const DEFAULT_THEME_MODE: ThemeMode = 'dark'

export const THEME_LABEL: Record<ThemeMode, string> = {
  light: '白天',
  dark: '黑夜',
  system: '跟随系统',
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value)
}

export function resolveTheme(mode: ThemeMode, systemDark: boolean): ThemeResolved {
  if (mode === 'system') return systemDark ? 'dark' : 'light'
  return mode
}

/**
 * 内置外观预设：启动动画与主背景各一份，随程序分发，用户可一键切回。
 *
 * 为什么要内置：用户自己选的那份存在 `media/` 里，一旦「恢复默认」或换机器就没了；
 * 而「默认长什么样」本来就不该取决于谁曾经上传过什么。所以预设是一份**只读清单**
 * （文件在 resources/media/），用户选过的媒体仍然是用户自己的 —— 两者并列，不互相覆盖。
 *
 * 预设文件为什么压过：原始素材 21.9MB + 6.5MB，直接入库会让仓库与安装包都变重。
 * 视频压到 1280x720 / CRF 30（1.7MB），背景压到 1920x1080 JPEG（128KB）——
 * 启动动画只闪几秒、背景还压着一层遮罩，这个尺寸看不出差别。
 */

export type PresetSlot = 'startup' | 'background'

/** 一份内置预设。`file` 是 resources/media/ 下的文件名，不含路径 */
export interface MediaPreset {
  id: string
  /** 界面上显示的名字 */
  label: string
  /** 一句话说清这是什么 */
  blurb: string
  slot: PresetSlot
  file: string
  kind: 'video' | 'image'
  /** 背景预设的默认遮罩浓度（启动动画不用） */
  dim?: number
}

/**
 * 清单只此一份：渲染层与主进程各引一次，不在两边各抄一遍。
 * 加预设要同时把文件放进 resources/media/，否则界面上能选、选中了打不开。
 */
export const MEDIA_PRESETS: readonly MediaPreset[] = [
  {
    id: 'startup-default',
    label: '默认片头',
    blurb: '随程序分发的那一支，开机时铺满整屏，播完自动收',
    slot: 'startup',
    file: 'startup-default.mp4',
    kind: 'video',
  },
  {
    id: 'background-default',
    label: '默认背景',
    blurb: '深色主界面下的一层底图，正文区压着遮罩保证可读',
    slot: 'background',
    file: 'background-default.jpg',
    kind: 'image',
    dim: 0.62,
  },
]

export function presetsFor(slot: PresetSlot): MediaPreset[] {
  return MEDIA_PRESETS.filter((p) => p.slot === slot)
}

export function findPreset(id: unknown): MediaPreset | undefined {
  if (typeof id !== 'string' || !id) return undefined
  return MEDIA_PRESETS.find((p) => p.id === id)
}

/** 预设文件名必须是清单里出现过的：挡住手改 preferences.json 指到任意文件 */
export function isPresetFile(file: unknown): boolean {
  return typeof file === 'string' && MEDIA_PRESETS.some((p) => p.file === file)
}

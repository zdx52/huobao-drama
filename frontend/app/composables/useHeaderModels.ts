/**
 * 顶部导航里的「文本 / 图片 / 视频」模型选择器。
 *
 * 选择器的取值其实是**每个 MV 项目自己的 config_id**（跟着项目走），所以布局层不自己拉配置：
 * 由当前页面把「选项 / 当前值 / 写入函数」塞进这个共享状态，页头只负责显示。
 * 页面卸载时清空 → 不在 MV 页时导航栏不出现这一组。
 */
export type HeaderModelKind = 'text' | 'image' | 'video'

export interface HeaderModelsState {
  options: Record<HeaderModelKind, any[]>
  value: Record<HeaderModelKind, string>
  defaultLabel: Record<HeaderModelKind, string>
  multi: Record<HeaderModelKind, boolean>
  set: (kind: HeaderModelKind, v: string) => void
}

export const useHeaderModels = () => useState<HeaderModelsState | null>('header-models', () => null)

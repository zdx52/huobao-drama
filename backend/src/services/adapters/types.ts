/**
 * 图片生成 Provider Adapter 接口
 */
export interface ImageProviderAdapter {
  /** 厂商标识 */
  provider: string

  /**
   * 构建图片生成请求
   * @param config AI 配置 { baseUrl, apiKey, model }
   * @param record 图片生成记录
   */
  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest

  /**
   * 解析生成响应，判断是同步还是异步
   */
  parseGenerateResponse(result: any): ImageGenResponse

  /**
   * 构建轮询请求
   * @param config AI 配置
   * @param taskId 任务 ID
   */
  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  /**
   * 解析轮询响应
   */
  parsePollResponse(result: any): ImagePollResponse

  /**
   * 从响应中提取图片 URL（用于直接下载）
   * 返回 null 表示图片数据是 base64 格式，需要用 extractImageBase64 处理
   */
  extractImageUrl(result: any): string | null

  /**
   * 从响应中提取 base64 图片数据
   * 仅用于 Gemini 等只返回 base64 的厂商
   */
  extractImageBase64(result: any): { data: string; mimeType: string } | null
}

/**
 * 视频生成 Provider Adapter 接口
 */
export interface VideoProviderAdapter {
  provider: string

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest

  parseGenerateResponse(result: any): VideoGenResponse

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest

  parsePollResponse(result: any): VideoPollResponse

  extractVideoUrl(result: any): string | null
}

// ============ 通用类型 ============

export interface ProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  /**
   * 普通请求为可 JSON 序列化的对象（generation.ts 统一 JSON.stringify）；
   * multipart 上传（如 OpenAI /v1/images/edits）直接返回 FormData，
   * 此时 headers 不要设置 Content-Type，边界由 fetch 自动生成。
   */
  body: any
}

export interface AIConfig {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface ImageGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  size?: string | null
  frameType?: string | null
  referenceImages?: string | null
  // ... 其他字段
}

export interface VideoGenerationRecord {
  id: number
  model?: string | null
  prompt?: string | null
  referenceMode?: string | null
  imageUrl?: string | null
  firstFrameUrl?: string | null
  lastFrameUrl?: string | null
  referenceImageUrls?: string | null
  referenceVideoUrls?: string | null
  referenceAudioUrls?: string | null
  referenceFileUrl?: string | null
  referenceLinkUrl?: string | null
  generateAudio?: number | boolean | null
  duration?: number | null
  aspectRatio?: string | null
  resolution?: string | null
  seed?: number | null
  promptExtend?: number | boolean | null
  watermark?: number | boolean | null
  /** 续拍链（可选）：同场景多镜头链式生成时透传给供应商 */
  chainId?: string | null
  chainSegment?: number | null
  chainSegments?: number | null
  /** 音乐 MV（2026-10-18）：MV 专用透传字段，适配器原样并进请求体 */
  mvExtras?: Record<string, unknown> | null
  /** RefMod 卡（2026-10-08）：随请求下发的身份/场景/道具卡，服务器侧落盘后按序填槽 */
  refmodFiles?: Array<{ name: string; data: string }> | null
  /** 角色声音源 wav（2026-10-11）：单独下发，服务器落盘成 voice_<卡名>.wav(32k) → 官方 ref_audios */
  voiceWavFiles?: Array<{ name: string; data: string }> | null
  // ... 其他字段
}

export interface ImageGenResponse {
  isAsync: boolean
  taskId?: string
  /** 同步模式下直接返回的图片 URL */
  imageUrl?: string
  /** 上游（本地中转）回报的真实耗时（同步生图时带上，用于显示真实生成/排队时间） */
  timing?: { genSeconds?: number; queueSeconds?: number }
}

export interface ImagePollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  imageUrl?: string
  error?: string
}

export interface VideoGenResponse {
  isAsync: boolean
  taskId?: string
  videoUrl?: string
}

export interface VideoPollResponse {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  videoUrl?: string
  duration?: number
  error?: string
  /** 上游（本地中转）回报的真实耗时：genSeconds = 真正生成多久，queueSeconds = 排队多久。
   *  2026-10-14 加：本地单卡串行排队时，「提交→完成」会把排队时间算进生成时间（实测同批
   *  显示 4m/7m/10m/14m，而每条真实生成都是 3.2~3.9 分钟）→ 有这个字段就用它显示。 */
  timing?: { genSeconds?: number; queueSeconds?: number }
  /** 2026-10-14（任务栏计时）：上游回报这条任务**是不是真在渲染**。
   *  本地单卡串行 —— 批量提交时除拿到锁的那条外都在排队，而任务表里它们同样显示「生成中」，
   *  光看 status 分不出来。state='running' 带 startedAt（**本机** epoch 毫秒，由上游 elapsed
   *  反推，避免 服务器与本机时钟偏差），前端据此给那一条走秒表；'waiting' = 排队中，不显示计时。 */
  progress?: { state: 'running' | 'waiting'; startedAt?: number }
}

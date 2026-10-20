/**
 * Drizzle schema - SQLite column mappings.
 * 自 MySQL 迁移：varchar(x)→text（SQLite 不校验长度）、int→integer、
 * boolean→integer boolean mode、时间戳仍为 text 存 ISO 字符串，表/列名不变。
 */
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core'

export const dramas = sqliteTable('dramas', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),
  genre: text('genre'),
  style: text('style').default('3d'),
  aspectRatio: text('aspect_ratio').default('16:9'),
  totalEpisodes: integer('total_episodes').default(1),
  totalDuration: integer('total_duration').default(0),
  status: text('status').notNull().default('draft'),
  thumbnail: text('thumbnail'),
  tags: text('tags'),
  metadata: text('metadata'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const episodes = sqliteTable('episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeNumber: integer('episode_number').notNull(),
  title: text('title').notNull(),
  content: text('content'),
  scriptContent: text('script_content'),
  description: text('description'),
  duration: integer('duration').default(0),
  status: text('status').default('draft'),
  videoUrl: text('video_url'),
  thumbnail: text('thumbnail'),
  imageConfigId: integer('image_config_id'),
  videoConfigId: integer('video_config_id'),
  resolution: text('resolution').default('720p'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const characters = sqliteTable('characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  role: text('role'),
  description: text('description'),
  appearance: text('appearance'),
  styling: text('styling'),
  finalPrompt: text('final_prompt'),
  personality: text('personality'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  seedValue: text('seed_value'),
  sortOrder: integer('sort_order'),
  localPath: text('local_path'),
  /** 换装造型变体：指回基准角色 id（null = 基准角色本身） */
  variantOf: integer('variant_of'),
  /** 造型名（如「正装」「晚礼服」「工装」），仅变体角色有值 */
  costumeLabel: text('costume_label'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

// Episode-Character many-to-many
export const episodeCharacters = sqliteTable('episode_characters', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  characterId: integer('character_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Episode-Scene many-to-many
export const episodeScenes = sqliteTable('episode_scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id').notNull(),
  createdAt: text('created_at').notNull(),
})

// Episode-Prop many-to-many
export const episodeProps = sqliteTable('episode_props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  propId: integer('prop_id').notNull(),
  createdAt: text('created_at').notNull(),
})

export const scenes = sqliteTable('scenes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  episodeId: integer('episode_id'),
  location: text('location').notNull(),
  time: text('time').notNull(),
  prompt: text('prompt').notNull(),
  lighting: text('lighting'),
  finalPrompt: text('final_prompt'),
  storyboardCount: integer('storyboard_count').default(1),
  imageUrl: text('image_url'),
  status: text('status').default('pending'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboards = sqliteTable('storyboards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id').notNull(),
  sceneId: integer('scene_id'),
  storyboardNumber: integer('storyboard_number').notNull(),
  title: text('title'),
  location: text('location'),
  time: text('time'),
  shotType: text('shot_type'),
  angle: text('angle'),
  movement: text('movement'),
  result: text('result'),
  atmosphere: text('atmosphere'),
  imagePrompt: text('image_prompt'),
  videoPrompt: text('video_prompt'),
  videoPromptEn: text('video_prompt_en'),
  bgmPrompt: text('bgm_prompt'),
  soundEffect: text('sound_effect'),
  description: text('description'),
  duration: integer('duration').default(0),
  composedImage: text('composed_image'),
  firstFrameImage: text('first_frame_image'),
  lastFrameImage: text('last_frame_image'),
  referenceImages: text('reference_images'),
  videoUrl: text('video_url'),
  subtitleUrl: text('subtitle_url'),
  composedVideoUrl: text('composed_video_url'),
  status: text('status').default('pending'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const storyboardCharacters = sqliteTable('storyboard_characters', {
  storyboardId: integer('storyboard_id').notNull(),
  characterId: integer('character_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyboardId, table.characterId] }),
])

export const storyboardProps = sqliteTable('storyboard_props', {
  storyboardId: integer('storyboard_id').notNull(),
  propId: integer('prop_id').notNull(),
}, (table) => [
  primaryKey({ columns: [table.storyboardId, table.propId] }),
])

export const aiServiceConfigs = sqliteTable('ai_service_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  serviceType: text('service_type').notNull(),
  provider: text('provider'),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull(),
  model: text('model'),
  endpoint: text('endpoint'),
  queryEndpoint: text('query_endpoint'),
  priority: integer('priority').default(0),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  settings: text('settings'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 注意: 此表无 deleted_at
})

export const aiServiceProviders = sqliteTable('ai_service_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  displayName: text('display_name'),
  serviceType: text('service_type').notNull(),
  provider: text('provider').notNull(),
  defaultUrl: text('default_url'),
  presetModels: text('preset_models'),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const stylePresets = sqliteTable('style_presets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  value: text('value').notNull(),
  prompt: text('prompt').notNull(),
  description: text('description'),
  sortOrder: integer('sort_order').default(0),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // 注意: 此表无 deleted_at（硬删除），value 列有唯一索引（见 sqlite-schema.ts DDL）
})

// 统一生成任务表：图片/视频生成共用，type 区分，生成参数存 params(JSON)
export const sysTask = sqliteTable('sys_task', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // image | video
  storyboardId: integer('storyboard_id'),
  dramaId: integer('drama_id'),
  sceneId: integer('scene_id'),
  characterId: integer('character_id'),
  propId: integer('prop_id'),
  provider: text('provider'),
  prompt: text('prompt'),
  model: text('model'),
  // image: {size, frameType, referenceImages[]}
  // video: {referenceMode, firstFrameUrl, lastFrameUrl, referenceImageUrls[], referenceVideoUrls[], referenceAudioUrls[], referenceFileUrl, referenceLinkUrl, generateAudio, duration, aspectRatio, resolution, seed, promptExtend, watermark}
  params: text('params'),
  taskId: text('task_id'),
  resultUrl: text('result_url'),
  localPath: text('local_path'),
  status: text('status').default('processing'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
})

export const videoMerges = sqliteTable('video_merges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  episodeId: integer('episode_id'),
  dramaId: integer('drama_id'),
  title: text('title'),
  provider: text('provider'),
  model: text('model'),
  status: text('status').default('pending'),
  scenes: text('scenes'), // JSON
  mergedUrl: text('merged_url'),
  duration: integer('duration'),
  taskId: text('task_id'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  deletedAt: text('deleted_at'),
})

export const props = sqliteTable('props', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id').notNull(),
  name: text('name').notNull(),
  type: text('type'),
  description: text('description'),
  prompt: text('prompt'),
  finalPrompt: text('final_prompt'),
  imageUrl: text('image_url'),
  referenceImages: text('reference_images'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const assets = sqliteTable('assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dramaId: integer('drama_id'),
  episodeId: integer('episode_id'),
  storyboardId: integer('storyboard_id'),
  storyboardNum: integer('storyboard_num'),
  name: text('name'),
  description: text('description'),
  type: text('type'),
  category: text('category'),
  url: text('url'),
  thumbnailUrl: text('thumbnail_url'),
  localPath: text('local_path'),
  fileSize: integer('file_size'),
  mimeType: text('mime_type'),
  width: integer('width'),
  height: integer('height'),
  duration: integer('duration'),
  format: text('format'),
  imageGenId: integer('image_gen_id'),
  videoGenId: integer('video_gen_id'),
  isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
  viewCount: integer('view_count').default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// ===== 音乐 MV（2026-10-18 新增，与短剧链路完全隔离）=====
/**
 * 2026-10-19：照短剧结构补上「上一级项目」——短剧是 项目(dramas) → 集(episodes)，资产挂项目级；
 * MV 之前只有「一首歌」这一层，资产也挂在歌上 → 换一首歌就什么都没了。
 * 现在：mv_series（MV 项目）→ mv_projects（一首歌，= 短剧的集）→ mv_shots（段，= 分镜）；
 *      mv_assets 挂 series_id（= 短剧角色的 drama_id），**同一项目下的歌共用同一套人物/场景**。
 */
export const mvSeries = sqliteTable('mv_series', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title'),
  style: text('style'),
  aspectRatio: text('aspect_ratio'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const mvProjects = sqliteTable('mv_projects', {
  seriesId: integer('series_id'),               // 属于哪个 MV 项目（上一级）
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title'),
  idea: text('idea'),
  songFile: text('song_file'),
  songRemoteName: text('song_remote_name'),
  vocalStem: text('vocal_stem'),      // 人声分离产物（服务器绝对路径；NULL=还没分离）
  songTitle: text('song_title'),      // 片头主创：曲名
  lyricist: text('lyricist'),         // 片头主创：作词
  composer: text('composer'),         // 片头主创：作曲
  lyricLrc: text('lyric_lrc'),        // 歌词自动对轴结果（LRC 文本，合成时烧字幕）
  songSeconds: real('song_seconds'),
  lyrics: text('lyrics'),
  aspectRatio: text('aspect_ratio'),      // 画幅 9:16 / 16:9（人物板固定 16:9；场景图与成片按它）
  textConfigId: integer('text_config_id'),   // 按项目锁通道（NULL = 跟随当前启用）
  imageConfigId: integer('image_config_id'),
  videoConfigId: integer('video_config_id'),
  maxShotSeconds: real('max_shot_seconds'),
  characterPrompt: text('character_prompt'),
  scenePrompt: text('scene_prompt'),
  characterImage: text('character_image'),
  sceneImage: text('scene_image'),
  characterCard: text('character_card'),
  sceneCard: text('scene_card'),
  outline: text('outline'),          // JSON
  style: text('style'),
  storyPrompt: text('story_prompt'), // 用户填的 MV 分镜提示词（人物/场景从它提取）
  status: text('status').default('draft'),
  outputUrl: text('output_url'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
})

/** 音乐 MV 自带的人物 / 场景资产（不写短剧的 characters / scenes，避免污染） */
export const mvAssets = sqliteTable('mv_assets', {
  seriesId: integer('series_id'),               // 资产库归属的 MV 项目（= 短剧角色的 drama_id）；同一项目下的歌共用
  scope: text('scope').default('project'),      // project = 本项目专用；library = 公共素材库（所有 MV 可见/可引用，2026-10-19）
  sourceAssetId: integer('source_asset_id'),    // 从素材库引用进本项目时记下来源 id（图共用，不复制文件）
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  kind: text('kind').notNull(),          // character | scene
  name: text('name'),
  description: text('description'),
  appearance: text('appearance'),
  styling: text('styling'),
  image: text('image'),                  // static/ 相对路径（人物板 / 场景图）
  card: text('card'),                    // RefMod 卡名
  imageStatus: text('image_status'),     // processing | failed（后台排队出图）
  prompt: text('prompt'),                // 生图提示词（描述 → 生成提示词 → 出图）
  sortOrder: integer('sort_order').default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const mvShots = sqliteTable('mv_shots', {
  taskIds: text('task_ids'),        // 本段历次生成的任务 id（JSON 数组，新的在前）——历史视频只认它，别用 storyboard_id（会和短剧撞号）
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id').notNull(),
  shotNumber: integer('shot_number').notNull(),
  outlineIndex: integer('outline_index'),
  startSeconds: real('start_seconds'),
  endSeconds: real('end_seconds'),
  frames: integer('frames').default(124),
  seconds: real('seconds'),
  shotSize: text('shot_size'),
  camera: text('camera'),
  vocalState: text('vocal_state').default('vocal_active'),
  lyric: text('lyric'),
  prompt: text('prompt'),            // 中文六段稿（界面显示/可编辑）
  promptEn: text('prompt_en'),       // 英文六段稿（真正发给 H3，按钮展开看）
  beats: text('beats'),               // 段内拍点（JSON：[{start,end,size,camera,action,action_zh}]）
  history: text('history'),           // 这一段历次生成过的视频（JSON 数组，最新在前）
  elapsedSeconds: integer('elapsed_seconds'),   // 这一段上一次生成用了多少秒
  refIds: text('ref_ids'),          // 这一段绑定的参考图（资产 id，JSON 数组；空=人物卡+场景卡）
  promptExtra: text('prompt_extra'),// 补充说明（英文，编译后原样追加到提示词末尾）
  firstFrameImage: text('first_frame_image'),
  taskId: text('task_id'),
  videoUrl: text('video_url'),
  status: text('status').default('pending'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})


/** MV 成片（拼接记录）：一条一次拼接，多家并存（照短剧 video_merges） */
export const mvMerges = sqliteTable('mv_merges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id'),
  shotIds: text('shot_ids'),
  mergedUrl: text('merged_url'),
  duration: real('duration'),
  seconds: integer('seconds'),
  status: text('status').default('completed'),
  errorMsg: text('error_msg'),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'),
})

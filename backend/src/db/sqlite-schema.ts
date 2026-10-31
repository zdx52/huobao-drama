/**
 * SQLite 启动建表 DDL + 种子数据（自 mysql-schema.ts 翻译）
 * - AUTO_INCREMENT → AUTOINCREMENT；删除 ENGINE/CHARSET；TINYINT(1) → INTEGER
 * - MySQL 内联 INDEX 拆为独立 CREATE INDEX IF NOT EXISTS
 * - 种子语句去掉 FROM DUAL（SQLite 非法），幂等语义（WHERE NOT EXISTS）保留
 */
import type Database from 'better-sqlite3'

export const sqliteSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS mv_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    shot_ids TEXT,
    merged_url TEXT,
    duration REAL,
    seconds INTEGER,
    status TEXT DEFAULT 'completed',
    error_msg TEXT,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS dramas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    genre TEXT,
    style TEXT DEFAULT '3d',
    aspect_ratio TEXT DEFAULT '16:9',
    total_episodes INTEGER DEFAULT 1,
    total_duration INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    thumbnail TEXT,
    tags TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    script_content TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    video_url TEXT,
    thumbnail TEXT,
    image_config_id INTEGER,
    video_config_id INTEGER,
    resolution TEXT DEFAULT '720p',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    description TEXT,
    appearance TEXT,
    styling TEXT,
    final_prompt TEXT,
    personality TEXT,
    image_url TEXT,
    reference_images TEXT,
    seed_value TEXT,
    sort_order INTEGER,
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER,
    location TEXT NOT NULL,
    time TEXT NOT NULL,
    prompt TEXT NOT NULL,
    lighting TEXT,
    final_prompt TEXT,
    storyboard_count INTEGER DEFAULT 1,
    image_url TEXT,
    status TEXT DEFAULT 'pending',
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS storyboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER,
    storyboard_number INTEGER NOT NULL,
    title TEXT,
    location TEXT,
    time TEXT,
    shot_type TEXT,
    angle TEXT,
    movement TEXT,
    result TEXT,
    atmosphere TEXT,
    image_prompt TEXT,
    video_prompt TEXT,
    video_prompt_en TEXT,
    bgm_prompt TEXT,
    sound_effect TEXT,
    description TEXT,
    duration INTEGER DEFAULT 0,
    composed_image TEXT,
    first_frame_image TEXT,
    last_frame_image TEXT,
    reference_images TEXT,
    video_url TEXT,
    subtitle_url TEXT,
    composed_video_url TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  // 2026-10-09 双语提示词：video_prompt_en 存 H3 官方 Ref2VA 六段式英文版（发送侧优先用它），
  // video_prompt 仍是中文工作版（界面显示/编辑/补充说明）。老库幂等补列，老数据为 NULL。
  `ALTER TABLE storyboards ADD COLUMN video_prompt_en TEXT`,

  // 2026-10-14 换装造型变体：variant_of 指回「基准角色」id、costume_label 记造型名（如「正装」）。
  // 变体是**独立角色行**（自带 RefMod 卡 / 分镜绑定 / 参考图槽位），基准角色与它的卡全程不动；
  // 变体的 appearance 由代码强制逐字复制基准角色 → 脸的文字描述不可能被改坏。
  `ALTER TABLE characters ADD COLUMN variant_of INTEGER`,
  `ALTER TABLE characters ADD COLUMN costume_label TEXT`,

  `CREATE TABLE IF NOT EXISTS episode_characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episode_characters_episode_id ON episode_characters (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episode_characters_character_id ON episode_characters (character_id)`,

  `CREATE TABLE IF NOT EXISTS episode_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episode_scenes_episode_id ON episode_scenes (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episode_scenes_scene_id ON episode_scenes (scene_id)`,

  `CREATE TABLE IF NOT EXISTS episode_props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    prop_id INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episode_props_episode_id ON episode_props (episode_id)`,
  `CREATE INDEX IF NOT EXISTS idx_episode_props_prop_id ON episode_props (prop_id)`,

  `CREATE TABLE IF NOT EXISTS storyboard_characters (
    storyboard_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, character_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_storyboard_characters_character_id ON storyboard_characters (character_id)`,

  `CREATE TABLE IF NOT EXISTS storyboard_props (
    storyboard_id INTEGER NOT NULL,
    prop_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, prop_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_storyboard_props_prop_id ON storyboard_props (prop_id)`,

  `CREATE TABLE IF NOT EXISTS ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_type TEXT NOT NULL,
    provider TEXT,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT,
    endpoint TEXT,
    query_endpoint TEXT,
    priority INTEGER DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    settings TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS ai_service_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    display_name TEXT,
    service_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    default_url TEXT,
    preset_models TEXT,
    description TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS style_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    prompt TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (value)
  )`,

  `CREATE TABLE IF NOT EXISTS sys_task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    storyboard_id INTEGER,
    drama_id INTEGER,
    scene_id INTEGER,
    character_id INTEGER,
    prop_id INTEGER,
    provider TEXT,
    prompt TEXT,
    model TEXT,
    params TEXT,
    task_id TEXT,
    result_url TEXT,
    local_path TEXT,
    status TEXT DEFAULT 'processing',
    error_msg TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sys_task_type ON sys_task (type)`,
  `CREATE INDEX IF NOT EXISTS idx_sys_task_drama_id ON sys_task (drama_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sys_task_storyboard_id ON sys_task (storyboard_id)`,

  `CREATE TABLE IF NOT EXISTS video_merges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER,
    drama_id INTEGER,
    title TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    scenes TEXT,
    merged_url TEXT,
    duration INTEGER,
    task_id TEXT,
    error_msg TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT,
    description TEXT,
    prompt TEXT,
    final_prompt TEXT,
    image_url TEXT,
    reference_images TEXT,
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER,
    episode_id INTEGER,
    storyboard_id INTEGER,
    storyboard_num INTEGER,
    name TEXT,
    description TEXT,
    type TEXT,
    category TEXT,
    url TEXT,
    thumbnail_url TEXT,
    local_path TEXT,
    file_size INTEGER,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    duration INTEGER,
    format TEXT,
    image_gen_id INTEGER,
    video_gen_id INTEGER,
    is_favorite INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,

  // 应用级全局设置（key-value，如 AI 内容语言 content_language）
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // ===== 音乐 MV（2026-10-18 新增，与短剧链路完全隔离：不复用 storyboards/sys_task 的表结构）=====
  `CREATE TABLE IF NOT EXISTS mv_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    style TEXT,
    aspect_ratio TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mv_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER,            -- 属于哪个 MV 项目（上一级；= 短剧的 drama_id）
    title TEXT,
    idea TEXT,                    -- 用户写的 MV 想法（一句话/一段梗概）
    song_file TEXT,               -- 本地 32k wav（static/ 相对路径）
    song_remote_name TEXT,        -- 服务器 ComfyUI/input 下的文件名（H3 读取用）
    song_seconds REAL DEFAULT 0,
    lyrics TEXT,                  -- 可选歌词（切点落在句界用）
    aspect_ratio TEXT DEFAULT '9:16',  -- 画幅（人物板固定 16:9；场景图与成片按它）
    max_shot_seconds REAL DEFAULT 10,  -- 用户填的「最长切分」，上限 15（H3 极限）
    character_prompt TEXT,        -- LLM 写出的人物设定
    scene_prompt TEXT,            -- LLM 写出的场景提示词
    character_image TEXT,         -- 生成的人物板（static/ 相对路径）
    scene_image TEXT,             -- 生成的场景图
    character_card TEXT,          -- 人物身份卡名（RefMod）
    scene_card TEXT,              -- 场景身份卡名
    outline TEXT,                 -- 粗分镜 JSON（与歌等长，只写画什么）
    style TEXT,                   -- 画风句（留空用默认电影感人像）
    status TEXT DEFAULT 'draft',  -- draft | planned | shots | rendering | done
    output_url TEXT,              -- 成片
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS mv_shots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    shot_number INTEGER NOT NULL,
    outline_index INTEGER,        -- 属于哪个粗分镜段
    start_seconds REAL DEFAULT 0,
    end_seconds REAL DEFAULT 0,
    frames INTEGER DEFAULT 124,
    seconds REAL DEFAULT 0,
    shot_size TEXT,               -- 中远景 / 中景 / 近景 / 特写
    camera TEXT,                  -- 机位句（留空用默认固定机位）
    vocal_state TEXT DEFAULT 'vocal_active',   -- vocal_active | non_vocal
    lyric TEXT,
    prompt TEXT,                  -- 详细分镜的成片提示词（六段式）
    first_frame_image TEXT,       -- 本段首帧图（static/ 相对路径）
    task_id TEXT,                 -- 生成任务 id（App 任务表里那条视频任务）
    video_url TEXT,
    status TEXT DEFAULT 'pending',-- pending | processing | completed | failed
    error_msg TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mv_shots_project ON mv_shots (project_id, shot_number)`,

  // MV 表 2026-10-18 同日晚补列（老库幂等补，新库由上面的 CREATE 直接带出）
  `ALTER TABLE mv_projects ADD COLUMN idea TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN lyrics TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN max_shot_seconds REAL DEFAULT 10`,
  `ALTER TABLE mv_projects ADD COLUMN character_prompt TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN scene_prompt TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN character_image TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN scene_image TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN character_card TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN scene_card TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN outline TEXT`,
  // 舞蹈 MV（2026-10-23 V2V 复刻路线）
  `ALTER TABLE mv_projects ADD COLUMN kind TEXT DEFAULT 'song'`,
  `ALTER TABLE mv_projects ADD COLUMN dance_source TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN dance_ref_source TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN dance_frames INTEGER`,
  `ALTER TABLE mv_shots ADD COLUMN outline_index INTEGER`,
  `ALTER TABLE mv_shots ADD COLUMN first_frame_image TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN story_prompt TEXT`,   // 2026-10-18 用户填的 MV 分镜提示词（人物/场景从它提取）

  // MV 自带的人物 / 场景资产（不写短剧的 characters / scenes，避免污染）
  `CREATE TABLE IF NOT EXISTS mv_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER,             -- 资产库归属的 MV 项目（= 短剧角色的 drama_id）
    project_id INTEGER NOT NULL,
    kind TEXT NOT NULL,            -- character | scene
    name TEXT,
    description TEXT,              -- 外貌+妆造（人物）/ 地点时间光影（场景）
    appearance TEXT,
    styling TEXT,
    image TEXT,                    -- static/ 相对路径（人物板 / 场景图）
    card TEXT,                     -- RefMod 卡名
    image_status TEXT,             -- processing | failed（后台出图排队状态，NULL = 空闲）
    prompt TEXT,                   -- 生图提示词（描述 → 生成提示词 → 出图）
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mv_assets_project ON mv_assets (project_id, kind, sort_order)`,
  // 2026-10-18 后台排队出图：一张卡点了出图，别的卡还能接着点（服务端按项目串行排队）
  `ALTER TABLE mv_assets ADD COLUMN image_status TEXT`,
  // 2026-10-18 照短剧的流程：描述 →（生成提示词）→ 出图。提示词存这里，出图直接用；
  // 项目画幅也在这一步落地（人物板固定 16:9；场景图与成片跟随 aspect_ratio）
  `ALTER TABLE mv_assets ADD COLUMN prompt TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN aspect_ratio TEXT DEFAULT '9:16'`,
  // 2026-10-18 按项目锁通道（顶部标签栏可改）：空 = 跟随「设置 → AI 服务」里当前启用的那条
  `ALTER TABLE mv_projects ADD COLUMN vocal_stem TEXT`,
  `ALTER TABLE mv_shots ADD COLUMN task_ids TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN series_id INTEGER`,
  // 2026-10-20 成片字幕：片头主创三项 + 歌词时间轴（自动对轴产出，LRC 文本）
  `ALTER TABLE mv_projects ADD COLUMN song_title TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN lyricist TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN composer TEXT`,
  `ALTER TABLE mv_projects ADD COLUMN lyric_lrc TEXT`,
  `ALTER TABLE mv_assets ADD COLUMN series_id INTEGER`,
  `ALTER TABLE mv_assets ADD COLUMN scope TEXT DEFAULT 'project'`,
  `ALTER TABLE mv_assets ADD COLUMN source_asset_id INTEGER`,
  `ALTER TABLE mv_assets ADD COLUMN variant_of INTEGER`,
  `ALTER TABLE mv_assets ADD COLUMN costume_label TEXT`,
  `ALTER TABLE mv_shots ADD COLUMN ref_ids TEXT`,
  `ALTER TABLE mv_shots ADD COLUMN prompt_extra TEXT`,
  `ALTER TABLE mv_shots ADD COLUMN prompt_en TEXT`,
  `ALTER TABLE mv_shots ADD COLUMN beats TEXT`,
  `ALTER TABLE mv_shots ADD COLUMN history TEXT`,
  `ALTER TABLE mv_shots ADD COLUMN elapsed_seconds INTEGER`,
  `ALTER TABLE mv_projects ADD COLUMN text_config_id INTEGER`,
  `ALTER TABLE mv_projects ADD COLUMN image_config_id INTEGER`,
  `ALTER TABLE mv_projects ADD COLUMN video_config_id INTEGER`,
]

/**
 * 风格预设种子数据 — value 存入 dramas.style，prompt 注入生图提示词（作为前缀拼接）
 *
 * prompt 统一按多维结构书写，保证跨模型/跨镜头的风格控制力：
 *   核心媒介与渲染 → 线条/造型 → 上色/材质 → 光影 → 色彩调性 → 背景处理 → 画质锚点 → avoid 禁忌项
 */
/**
 * 风格预设种子数据 — value 存入 dramas.style，prompt 注入生图提示词（作为前缀拼接）
 *
 * prompt 分两段，用独占一行的 `---BODY-RENDER-LANGUAGE---` 分隔：
 *   前半「风格头」= 英文多维结构（核心媒介与渲染 → 线条/造型 → 上色/材质 → 光影 → 色彩调性
 *                     → 背景处理 → 画质锚点 → avoid 禁忌项），保存时拼在图片/视频提示词最前方；
 *   后半「正文渲染语言」= 中文规则，只给提示词 Agent 读（不拼接进提示词）。
 *
 * 为什么要分两段：实测（2026-10-11）风格头改不动画风 —— 处方放最前/最后/首尾夹击都无差别；
 * 只有**正文本身用该画风的介质语言写**才锁得住。正文由 Agent 生成，所以必须把这段规则递给 Agent。
 * 分隔标记的解析见 services/style-preset.ts（STYLE_BODY_SEP / getDramaStyleSpec）。
 */
export const stylePresetSeeds = [
  {
    name: '3D 漫剧', value: '3d', sortOrder: 1,
    prompt: [
      'high-quality 3D CG animation still, modern game-engine cinematic render, Unreal Engine and Pixar grade quality, semi-realistic stylized characters with refined facial features, clean sculpted anatomy, detailed skin shader with subtle subsurface scattering, PBR materials with crisp detailed textures, volumetric cinematic lighting with soft rim light, rich depth of field, polished film color grading, detailed environment art, sharp focus, consistent character design across shots, avoid flat lighting, avoid plastic waxy skin, avoid low-poly blurry look, avoid 2D flat cel shading, avoid anime line art',
      '---BODY-RENDER-LANGUAGE---',
      '【正文渲染语言：3D CG】画面描述（图片提示词与视频提示词都算）一律按 3D 实时渲染的写法描述，逐件陈设改写：',
      '- 把每个物件当作有真实建模体积的 3D 资产来写：写明形状、倒角、曲面与材质（哑光布、抛光石材、金属、玻璃、木器），并写出它们的粗糙度差异。',
      '- 光照写成 3D 场景布光：主光 + 补光 + 轮廓光、柔和阴影、环境光遮蔽、体积雾；可以有克制的浅景深与镜头感。',
      '- 材质反光按物理写：玻璃/水晶写折射与反射、金属写高光与环境反射、抛光石材写镜面倒影 —— 但都保持"干净的 CG 质感"，不要出现脏污噪点与照片颗粒。',
      '- 不要写"平涂、色块、描边、网点"这类二维词；不要出现手绘线条与纸张纹理。',
      '- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的"单品产品图 / 产品照片 / 单品图"、场景的"写实照片 / 摄影"、人物的"摄影棚人像" → 本画风用「3D 渲染道具设定图 / 3D 场景设定图 / 3D 角色设定图（纯白底或平涂背景）」；② "柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影"这类词一律删掉，光按上面的 3D 布光写法；③ 道具图不要写成"孤立摆放在纯白背景上的商品图"，要写成「3D 动画片里道具特写的那一帧静画」；④ "立体道具 / 3D 质感" → 「有厚度的道具，以真实的建模体积与材质（不要写成平涂色块）表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。',
      '- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
      '---BODY-RENDER-LANGUAGE-EN---',
      '[Body render language: 3D CG] Describe the picture the way a real-time 3D render is written, converting each item of dressing one by one:',
      '- Write every object as a 3D asset with true modelled volume: its shape, bevels, curved surfaces and material (matte fabric, polished stone, metal, glass, wood), and spell out their roughness differences.',
      '- Write lighting as a 3D scene lighting setup: key + fill + rim light, soft shadows, ambient occlusion, volumetric haze; restrained shallow depth of field is allowed.',
      '- Write material reflection physically: glass and crystal show refraction and reflection, metal shows specular highlight and environment reflection, polished stone shows mirror reflection - all kept as a clean CG look, with no grime, noise or photographic grain.',
      '- Never use 2D words (flat colour, colour block, outline, screentone); no hand-drawn line quality, no paper texture.',
      '- **Genre noun / composition / thickness must be rewritten**: any photorealistic-photography wording follows this style - a prop written as "single-item product shot / product photo" and a scene written as "realistic photo / photography" become "3D-rendered prop design sheet / 3D scene design sheet / 3D character design sheet (pure white or flat background)"; delete "soft even studio light / high detail / realistic material texture / contact shadow" and use the 3D lighting wording above; a prop image is never an isolated product on a white background but a single still frame of that prop\'s close-up from a 3D animated film; "thick prop / 3D quality" becomes "a prop with thickness expressed through true modelled volume and material"; a prop\'s cast shadow is one flat block or layer of colour in this style, never a volumetric shadow.',
      '- Always state space and relative positions in full (the image is the video anchor; the video must match the first frame).',
    ].join('\n'),
    description: '游戏引擎级 3D 渲染，半写实角色，当前短剧主流的 3D 漫剧质感',
  },
  {
    name: '日漫赛璐璐', value: 'anime', sortOrder: 2,
    prompt: [
      'Japanese 2D anime illustration, flat cel-shaded style, clean cel shading with hard-edged shadow shapes, crisp uniform black line art, vivid saturated color palette; characters, environments and props are ALL drawn in the same flat 2D anime medium, hand-painted anime background art with flat colour blocks and simplified shapes; expressive large-eyed character design with on-model proportions; dramatic anime key lighting with screentone highlights; key-visual poster quality; consistent art style across shots; avoid 3D CGI, avoid photorealism, avoid photographic or studio-photo look, avoid realistic material gloss, PBR reflections, global illumination and depth of field; avoid painterly soft blending, avoid watercolor texture, avoid thick western comic outlines',
      '---BODY-RENDER-LANGUAGE---',
      '【正文渲染语言：二维赛璐璐动画】画面描述（图片提示词与视频提示词都算）一律按二维动画的绘制方式描述，逐件陈设改写：',
      '- 全图由平涂色块构成；每个物体的轮廓都用同样粗细的闭合黑线勾出；明暗只分亮面与暗面两层，交界是锐利直线；没有渐变、没有材质反光、没有景深虚化。',
      '- 材质词一律化掉：镜面反射/抛光/高光/倒影 → 几道平涂浅色块；玻璃与水晶 → 简化几何色块；金属 → 平涂色块加一道细亮边；织物/纸张 → 平涂加少量线纹。',
      '- 光照词一律化掉：不写真实光源、明暗过渡、体积光；只写"整体由暖色块与冷色块构成"这类块面关系。',
      '- 背景与陈设同样平涂，不出现照片质感、不出现写实景深。',
      '- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的"单品产品图 / 产品照片 / 单品图"、场景的"写实照片 / 摄影"、人物的"摄影棚人像" → 本画风用「二维动画道具设定图 / 二维动画场景插画 / 二维动画人物设定图（平涂纯白底）」；② "柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影"这类词一律删掉，光按上面的平涂写法；③ 道具图不要写成"孤立摆放在纯白背景上的商品图"，要写成「二维动画片里道具特写的那一帧静画（设定稿／原画）」；④ "立体道具 / 3D 质感" → 「有厚度的道具，以平涂色块表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。',
      '- **边缘再收紧一档**：所有色块的边界都必须是硬边直线、能看出色块之间的接缝、边缘允许轻微台阶感，禁止任何平滑过渡与渐变。',
      '- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
      '---BODY-RENDER-LANGUAGE-EN---',
      '[Body render language: 2D cel animation] Describe the picture the way 2D animation is drawn, converting each item of dressing one by one:',
      '- The whole frame is built from flat colour blocks; every object is bounded by crisp uniform closed black outlines of one weight; light and shade are split into exactly one lit side and one shadow side with a sharp straight boundary; no gradients, no material gloss, no depth-of-field blur.',
      '- Convert every material word away: mirror reflection / polish / specular highlight / reflection become a few flat pale colour blocks; glass and crystal become simplified geometric colour blocks; metal becomes a flat colour block plus one thin bright edge; fabric and paper become flat tone plus a few line strokes.',
      '- Convert every lighting word away: never write a real light source, light-to-shade transition or volumetric light; only write block relations such as "the whole frame is built from warm colour blocks and cool colour blocks".',
      '- Background and dressing are flat-toned too: no photographic texture, no realistic depth of field.',
      '- **Genre noun / composition / thickness must be rewritten**: any photorealistic-photography wording follows this style - a prop written as "single-item product shot / product photo" and a scene written as "realistic photo / photography" become "2D-animation prop design sheet / 2D-animation scene illustration / 2D-animation character design sheet (flat pure white ground)"; delete "soft even studio light / high detail / realistic material texture / contact shadow" and use the flat-tone wording above; a prop image is never an isolated product on a white background but a single still frame of that prop\'s close-up from a 2D animated film; "thick prop / 3D quality" becomes "a prop with thickness expressed as flat colour blocks"; a prop\'s cast shadow is one flat block or layer of colour, never a volumetric shadow.',
      '- **Tighten the edges one more notch**: every colour boundary must be a hard straight edge with a visible seam between blocks, a slight stair-stepped edge is allowed - no smooth transition and no gradient whatsoever.',
      '- Always state space and relative positions in full (the image is the video anchor; the video must match the first frame).',
    ].join('\n'),
    description: '日式赛璐璐动画风格',
  },
  {
    name: '吉卜力手绘', value: 'ghibli', sortOrder: 3,
    prompt: [
      'Studio Ghibli hand-drawn animation style, soft painterly brushwork with organic hand-crafted line quality, lush warm watercolor painted backgrounds, gentle natural daylight with nostalgic warm glow, muted earthy natural color palette, whimsical cozy storybook atmosphere, subtle film-grain softness, theatrical background art quality, consistent character design across shots, avoid hard cel shading, avoid 3D render look, avoid neon over-saturated colors, avoid sharp digital edges, avoid photorealism',
      '---BODY-RENDER-LANGUAGE---',
      '【正文渲染语言：手绘动画水彩背景】画面描述（图片提示词与视频提示词都算）一律按手绘动画背景美术的写法描述，逐件陈设改写：',
      '- 以水彩/水粉晕染的笔触画背景：色块边缘是柔和的手绘边，可以有颜料渗化、干笔触与纸面颗粒；轮廓线是手绘的、粗细有变化，不是均匀印刷描边。',
      '- 明暗用柔和的色层过渡与湿画法晕开，不用硬边两段式阴影；受光处偏黄白，背光处偏蓝紫。',
      '- 光照写成自然日光与空气感：天光、云影、斑驳光点、空气中的浮尘；可以有淡淡的景深与胶片柔和感。',
      '- 材质词改写：玻璃/水面 → 半透明的浅色水彩晕染；金属 → 哑光色块加一点手绘高光；抛光石材 → 带柔和反光色层的平涂。',
      '- 细节保持手绘感与笔触，不出现照片质感、不出现 3D 渲染的塑料高光。',
      '- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的"单品产品图 / 产品照片 / 单品图"、场景的"写实照片 / 摄影"、人物的"摄影棚人像" → 本画风用「手绘动画道具设定图 / 手绘动画背景美术 / 手绘动画人物设定图（纯白或纸纹底）」；② "柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影"这类词一律删掉，光按上面的手绘水彩写法；③ 道具图不要写成"孤立摆放在纯白背景上的商品图"，要写成「手绘动画里道具特写的那一帧」；④ "立体道具 / 3D 质感" → 「有厚度的道具，以手绘笔触与水彩晕染的色层表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。',
      '- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
      '---BODY-RENDER-LANGUAGE-EN---',
      '[Body render language: hand-drawn animation watercolour background] Describe the picture the way hand-painted animation background art is written, converting each item of dressing one by one:',
      '- Paint backgrounds with watercolour / gouache washes: colour-block edges are soft hand-painted edges, pigment bleed, dry-brush marks and paper grain are allowed; contours are hand-drawn with varying line weight, never uniform printed outlines.',
      '- Light and shade use soft layered washes and wet blending, never the hard-edged two-tone split; lit areas lean yellow-white and shadow areas lean blue-violet.',
      '- Write lighting as natural daylight with a sense of air: sky light, cloud shadows, dappled light spots, floating dust; a faint depth of field and film softness are allowed.',
      '- Convert material words: glass and water surface become a translucent pale watercolour wash; metal becomes a matte colour block with a touch of hand-painted highlight; polished stone becomes flat tone with a soft reflective colour layer.',
      '- Keep detail hand-drawn with visible brushwork: no photographic texture, no plastic 3D highlight.',
      '- **Genre noun / composition / thickness must be rewritten**: any photorealistic-photography wording follows this style - a prop written as "single-item product shot / product photo" becomes "hand-drawn-animation prop design sheet / hand-drawn-animation background art / hand-drawn-animation character design sheet (pure white or paper-grain ground)"; delete "soft even studio light / high detail / realistic material texture / contact shadow"; a prop image is a single still frame of that prop\'s close-up from a hand-drawn animated film; "thick prop / 3D quality" becomes "a prop with thickness expressed through hand-painted strokes and watercolour layers"; a prop\'s cast shadow is one flat block or layer of colour.',
      '- Always state space and relative positions in full (the image is the video anchor; the video must match the first frame).',
    ].join('\n'),
    description: '吉卜力手绘治愈风',
  },
  {
    name: '水彩绘本', value: 'watercolor', sortOrder: 4,
    prompt: [
      'delicate watercolor storybook illustration, soft translucent color washes, visible cold-press paper texture, fluid hand-painted brushstrokes with gentle pigment bleeds, light airy atmosphere, harmonious pastel palette, whimsical children book charm, loose expressive edges, consistent character design across shots, avoid bold black outlines, avoid digital airbrush look, avoid harsh contrast, avoid 3D rendering, avoid photorealism',
      '---BODY-RENDER-LANGUAGE---',
      '【正文渲染语言：水彩插画】画面描述（图片提示词与视频提示词都算）一律按水彩插画的写法描述，逐件陈设改写：',
      '- 全图是半透明水彩层层叠加：能看到纸张纹理与颜料在边缘沉积出的深色边；形体靠色块边界与留白暗示，没有明确黑色轮廓线。',
      '- 明暗靠水彩的通透深浅：浅色=受光，叠色加深=背光；不要硬边阴影，也不要用纯黑压暗。',
      '- 色彩是和谐的淡彩，允许颜色在相邻区域自然混渗；笔触是松散的、可见的手绘笔触。',
      '- 材质词改写：玻璃/水面 → 浅色透明晕染 + 留白；金属 → 哑光灰蓝色块 + 一点白色留白当高光；织物 → 平涂色块 + 少量线条纹理。',
      '- 不写抛光、镜面反射、景深虚化、体积光；背景与陈设同样用松散水彩笔触，不出现照片质感。',
      '- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的"单品产品图 / 产品照片 / 单品图"、场景的"写实照片 / 摄影"、人物的"摄影棚人像" → 本画风用「水彩道具插画 / 水彩场景插画 / 水彩人物插画（纸纹白底）」；② "柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影"这类词一律删掉，光按上面的水彩写法；③ 道具图不要写成"孤立摆放在纯白背景上的商品图"，要写成「水彩绘本里的道具插图」；④ "立体道具 / 3D 质感" → 「有厚度的道具，以半透明水彩叠色表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。',
      '- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
      '---BODY-RENDER-LANGUAGE-EN---',
      '[Body render language: watercolour illustration] Describe the picture the way a watercolour illustration is painted, converting each item of dressing one by one:',
      '- The whole frame is translucent watercolour layered over and over: paper texture is visible and pigment settles into darker edges; form is implied by colour-block boundaries and reserved white paper, with no firm black contour line.',
      '- Light and shade come from watercolour transparency: pale wash is lit, deepened layering is shadow; never hard-edged shadow blocks, never darkening with pure black.',
      '- Colours are harmonious pale washes and neighbouring areas are allowed to bleed into each other naturally; brushwork is loose and visibly hand-painted.',
      '- Convert material words: glass and water surface become a pale translucent wash plus reserved white; metal becomes a matte grey-blue block with a touch of reserved white as highlight; fabric becomes flat tone plus a few line strokes.',
      '- Never write polish, mirror reflection, depth-of-field blur or volumetric light; background and dressing use the same loose watercolour strokes, with no photographic texture.',
      '- **Genre noun / composition / thickness must be rewritten**: any photorealistic-photography wording follows this style - a prop written as "single-item product shot / product photo" becomes "watercolour prop illustration / watercolour scene illustration / watercolour character illustration (paper-grain white ground)"; delete "soft even studio light / high detail / realistic material texture / contact shadow"; "thick prop / 3D quality" becomes "a prop with thickness expressed through translucent watercolour layering"; a prop\'s cast shadow is one flat block or layer of colour.',
      '- Always state space and relative positions in full (the image is the video anchor; the video must match the first frame).',
    ].join('\n'),
    description: '水彩插画质感',
  },
  {
    name: '美式漫画', value: 'comic', sortOrder: 5,
    prompt: [
      'Western graphic-novel comic book style, bold confident black ink outlines, halftone dot shading and screentone gradients, dynamic saturated colors with dramatic contrast, dramatic spotlight lighting, flat graphic print look, sharp inking details, dynamic cinematic composition, consistent character design across shots, avoid painterly soft blending, avoid watercolor washes, avoid photorealistic rendering, avoid 3D CGI look, avoid anime cel shading',
      '---BODY-RENDER-LANGUAGE---',
      '【正文渲染语言：美式漫画墨线+网点】画面描述（图片提示词与视频提示词都算）一律按美式漫画的绘制方式描述，逐件陈设改写：',
      '- 每个物体轮廓用自信的黑色墨线勾出，线的粗细有变化（重心线加粗、细节线变细）；阴影侧用较粗的线加强。',
      '- 明暗只用三种手段：大面积纯黑色块做负空间、网点（halftone 圆点）做灰阶、排线/交叉排线做过渡。不要柔和的渐变过渡。',
      '- 上色是平涂加硬边分界，色彩饱和、块面对比强烈；可以有印刷套色偏移的手感。',
      '- 材质词改写：玻璃 → 高对比平涂色块 + 一道纯白高光；金属 → 高对比黑白块 + 网点高光；抛光石材 → 平涂色块 + 几道网点反光条。',
      '- 不写镜面反射细节、不写景深虚化、不写照片质感；背景与陈设同样以墨线 + 网点处理。',
      '- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的"单品产品图 / 产品照片 / 单品图"、场景的"写实照片 / 摄影"、人物的"摄影棚人像" → 本画风用「美式漫画道具设定图 / 美式漫画场景图 / 美式漫画人物设定图（纯白底 + 网点）」；② "柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影"这类词一律删掉，光按上面的墨线+网点写法；③ 道具图不要写成"孤立摆放在纯白背景上的商品图"，要写成「美式漫画里道具特写的那一格」；④ "立体道具 / 3D 质感" → 「有厚度的道具，以硬边平涂色块表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。',
      '- **边缘再收紧一档**：所有色块的边界都必须是硬边直线、能看出色块之间的接缝、边缘允许轻微台阶感，禁止任何平滑过渡与渐变。',
      '- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
      '---BODY-RENDER-LANGUAGE-EN---',
      '[Body render language: western comic ink line + halftone] Describe the picture the way a western comic is drawn, converting each item of dressing one by one:',
      '- Every object is outlined with confident black ink, line weight varying (weight lines thicker, detail lines thinner), with a heavier line on the shadow side.',
      '- Light and shade use only three devices: large solid black for negative space, halftone dots for greys, hatching and cross-hatching for transitions; never a soft gradient.',
      '- Colouring is flat tone with hard-edged boundaries, saturated and strongly blocked; a slight print mis-registration feel is allowed.',
      '- Convert material words: glass becomes a high-contrast flat colour block plus one pure-white highlight; metal becomes high-contrast black and white blocks plus a halftone highlight; polished stone becomes a flat colour block plus a few halftone reflection bars.',
      '- Never write mirror-reflection detail, depth-of-field blur or photographic texture; background and dressing are handled the same way with ink line plus halftone.',
      '- **Genre noun / composition / thickness must be rewritten**: any photorealistic-photography wording follows this style - a prop written as "single-item product shot / product photo" becomes "western-comic prop design sheet / western-comic scene sheet / western-comic character design sheet (pure white ground with halftone)"; delete "soft even studio light / high detail / realistic material texture / contact shadow"; a prop image is one panel of that prop\'s close-up in a western comic; "thick prop / 3D quality" becomes "a prop with thickness expressed as hard-edged flat colour blocks"; a prop\'s cast shadow is one flat block or layer of colour.',
      '- **Tighten the edges one more notch**: every colour boundary must be a hard straight edge with a visible seam, and no smooth transition or gradient whatsoever.',
      '- Always state space and relative positions in full (the image is the video anchor; the video must match the first frame).',
    ].join('\n'),
    description: '美式漫画粗线条风格',
  },
  {
    name: '国风 2.5D', value: 'guofeng', sortOrder: 7,
    prompt: [
      'Chinese guofeng 2.5D illustration style, semi-realistic donghua-quality character art, elegant flowing line work, rich traditional Chinese aesthetic elements, layered ink-wash inspired atmospheric backgrounds, refined silk and fabric textures, soft luminous lighting with gentle haze, sophisticated muted jewel-tone palette, xianxia drama poster quality, consistent character design across shots, avoid flat cel shading, avoid western comic ink style, avoid photorealism, avoid plastic 3D look, avoid modern clothing and props unless specified',
      '---BODY-RENDER-LANGUAGE---',
      '【正文渲染语言：国风 2.5D 动画】画面描述（图片提示词与视频提示词都算）一律按国风动画/仙侠剧的绘制方式描述，逐件陈设改写：',
      '- 形体半写实、用偏细而有粗细变化的流畅线条勾勒轮廓；上色是平涂 + 少量柔和渐变，保留干净的色块感。',
      '- 背景用带水墨感的层叠晕染、远山雾气与留白处理；不追求照片级的细节密度。',
      '- 光照偏柔和：柔光 + 轻雾 + 逆光轮廓，可有克制的景深；不写刺眼的镜面高光与硬阴影。',
      '- 材质写成"动画化的干净质感"：丝绸/布料 → 平涂 + 柔和渐变与流畅衣纹线；木/玉/铜 → 平涂 + 一点手绘高光；玻璃/瓷 → 浅色块 + 白色细高光。不写真实反射斑点与照片级纹理。',
      '- 整体色调用沉静的宝石色/青金/朱红，不出现照片质感与 3D 塑料高光。',
      '- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的"单品产品图 / 产品照片 / 单品图"、场景的"写实照片 / 摄影"、人物的"摄影棚人像" → 本画风用「国风平面道具设定图 / 国风动画场景图 / 国风动画人物设定图（纯白或淡墨底）」；② "柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影"这类词一律删掉，光按上面的国风平涂+柔光写法；③ 道具图不要写成"孤立摆放在纯白背景上的商品图"，要写成「国风动画里道具特写的那一帧」；④ "立体道具 / 3D 质感" → 「有厚度的道具，以平涂加少量柔和渐变表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。',
      '- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
      '---BODY-RENDER-LANGUAGE-EN---',
      '[Body render language: guofeng 2.5D animation] Describe the picture the way guofeng animation / xianxia drama art is drawn, converting each item of dressing one by one:',
      '- Form is semi-realistic, contoured with slender flowing lines of varying weight; colouring is flat tone plus a little soft gradient, keeping a clean sense of colour blocks.',
      '- Backgrounds use layered ink-wash diffusion, distant-mountain mist and reserved white; never chase photographic detail density.',
      '- Lighting stays soft: soft light + light haze + rim-lit silhouette, with restrained depth of field; never a harsh specular highlight or hard shadow.',
      '- Write materials as clean animation-style surfaces: silk and fabric become flat tone with soft gradient and flowing drapery lines; wood, jade and bronze become flat tone with a touch of hand-painted highlight; glass and porcelain become a pale block with a thin white highlight. Never write real reflection speckle or photographic texture.',
      '- The overall palette is calm jewel tones (lapis, vermilion); no photographic texture, no plastic 3D highlight.',
      '- **Genre noun / composition / thickness must be rewritten**: any photorealistic-photography wording follows this style - a prop written as "single-item product shot / product photo" becomes "guofeng flat prop design sheet / guofeng animation scene sheet / guofeng animation character design sheet (pure white or faint ink ground)"; delete "soft even studio light / high detail / realistic material texture / contact shadow"; a prop image is a single still frame of that prop\'s close-up from guofeng animation; "thick prop / 3D quality" becomes "a prop with thickness expressed through flat tone with a little soft gradient"; a prop\'s cast shadow is one flat block or layer of colour.',
      '- Always state space and relative positions in full (the image is the video anchor; the video must match the first frame).',
    ].join('\n'),
    description: '国风动画/仙侠剧质感，2.5D 半写实',
  },
  {
    name: '韩系网漫', value: 'webtoon', sortOrder: 8,
    prompt: [
      'Korean webtoon manhwa style, clean digital painting with soft gradient shading, slim elegant character proportions, large expressive eyes with detailed highlights, soft glowing skin rendering, romantic dreamy lighting, modern pastel-to-vivid color palette, detailed fashion and fabric rendering, webtoon key visual quality, consistent character design across shots, avoid heavy black ink outlines, avoid halftone dots, avoid 3D render look, avoid watercolor paper texture, avoid chibi proportions',
      '---BODY-RENDER-LANGUAGE---',
      '【正文渲染语言：韩国条漫数码上色】画面描述（图片提示词与视频提示词都算）一律按韩国网漫的绘制方式描述，逐件陈设改写：',
      '- 线稿细而清晰，用深褐或深灰（不是纯黑粗描边）；轮廓可以局部断开、不追求闭合描边。',
      '- 上色是平涂 + 柔和渐变的过渡阴影（不是硬边两段式）；暗部用冷色透明叠加，受光处透亮。',
      '- 光照浪漫柔和：柔光、光斑、可见的浅景深虚化；整体画面干净通透、可比照片更亮。',
      '- 材质词改写：玻璃/金属 → 干净的渐变高光与白色反光条；抛光地面 → 柔和的亮色倒影渐变；织物 → 细腻平涂 + 少量褶皱渐变。',
      '- 不写网点、不写粗黑漫画描边、不写照片颗粒；背景与陈设同样用干净的数码平涂 + 渐变处理。',
      '- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的"单品产品图 / 产品照片 / 单品图"、场景的"写实照片 / 摄影"、人物的"摄影棚人像" → 本画风用「韩系条漫道具设定图 / 韩系条漫场景图 / 韩系条漫人物设定图（纯白数码底）」；② "柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影"这类词一律删掉，光按上面的数码渐变写法；③ 道具图不要写成"孤立摆放在纯白背景上的商品图"，要写成「韩系条漫里道具特写的那一格」；④ "立体道具 / 3D 质感" → 「有厚度的道具，以数码平涂与柔和渐变表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。',
      '- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
      '---BODY-RENDER-LANGUAGE-EN---',
      '[Body render language: Korean webtoon digital colouring] Describe the picture the way a Korean webtoon is drawn, converting each item of dressing one by one:',
      '- Line art is thin and clean in dark brown or dark grey (never a thick pure-black outline); contours may break in places and need not close.',
      '- Colouring is flat tone plus soft gradient transitions (never a hard-edged two-tone split); shadows are transparent cool layering and lit areas stay luminous.',
      '- Lighting is romantic and soft: soft light, light bloom, visible shallow depth-of-field blur; the whole frame is clean and luminous, allowed to be brighter than a photograph.',
      '- Convert material words: glass and metal become a clean gradient highlight plus white reflection bars; polished floor becomes a soft bright reflection gradient; fabric becomes fine flat tone plus a few fold gradients.',
      '- Never write halftone dots, thick black comic outlines or photographic grain; background and dressing use the same clean digital flat tone plus gradient.',
      '- **Genre noun / composition / thickness must be rewritten**: any photorealistic-photography wording follows this style - a prop written as "single-item product shot / product photo" becomes "webtoon prop design sheet / webtoon scene sheet / webtoon character design sheet (pure white digital ground)"; delete "soft even studio light / high detail / realistic material texture / contact shadow"; a prop image is one panel of that prop\'s close-up in a webtoon; "thick prop / 3D quality" becomes "a prop with thickness expressed through digital flat tone and soft gradient"; a prop\'s cast shadow is one flat block or layer of colour.',
      '- Always state space and relative positions in full (the image is the video anchor; the video must match the first frame).',
    ].join('\n'),
    description: '韩国条漫/网漫精致上色风',
  },
  {
    name: '黑白漫画', value: 'noir', sortOrder: 9,
    prompt: [
      'black and white manga illustration, high-contrast monochrome ink work, dynamic hatching and cross-hatching shading, bold solid blacks with dramatic negative space, screentone gray gradation, expressive confident ink linework, cinematic noir lighting, professional manga page quality, consistent character design across shots, strictly no color, avoid grayscale blur smudging, avoid painterly soft edges, avoid photorealism, avoid 3D render look',
      '---BODY-RENDER-LANGUAGE---',
      '【正文渲染语言：黑白漫画墨水】画面描述（图片提示词与视频提示词都算）一律按黑白漫画的绘制方式描述，逐件陈设改写：',
      '- 全图没有任何彩色，只有黑白灰与网点；物体轮廓用有力度的墨线勾出，阴影侧线条加粗。',
      '- 明暗分层：排线/交叉排线做中间调，网点做灰阶，大块纯黑做负空间与剪影；可以有速度线和集中线。',
      '- 材质不靠颜色区分，只靠排线密度与黑白对比：玻璃 → 留白 + 几道斜排线；金属 → 高对比黑白块 + 排线高光；抛光地面 → 留白高光条 + 横向排线。',
      '- 光照写成戏剧性的硬光与强烈明暗对比（noir 布光）：不写颜色、不写柔和渐变、不写景深虚化。',
      '- 不出现任何颜色词，不出现照片质感；背景与陈设同样用墨线 + 网点 + 排线处理。',
      '- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的"单品产品图 / 产品照片 / 单品图"、场景的"写实照片 / 摄影"、人物的"摄影棚人像" → 本画风用「黑白漫画道具设定图 / 黑白漫画场景图 / 黑白漫画人物设定图（纯白底 + 网点排线）」；② "柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影"这类词一律删掉，光按上面的黑白网点排线写法；③ 道具图不要写成"孤立摆放在纯白背景上的商品图"，要写成「黑白漫画里道具特写的那一格」；④ "立体道具 / 3D 质感" → 「有厚度的道具，以墨线、网点与排线表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。',
      '- **边缘再收紧一档**：所有色块的边界都必须是硬边直线、能看出色块之间的接缝、边缘允许轻微台阶感，禁止任何平滑过渡与渐变。',
      '- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
      '---BODY-RENDER-LANGUAGE-EN---',
      '[Body render language: black-and-white manga ink] Describe the picture the way black-and-white manga is drawn, converting each item of dressing one by one:',
      '- The whole frame carries no colour at all, only black, white, grey and screentone; objects are outlined with forceful ink line, thickened on the shadow side.',
      '- Light and shade are layered: hatching and cross-hatching for mid-tones, screentone for greys, large solid black for negative space and silhouette; speed lines and focus lines are allowed.',
      '- Materials are separated by hatching density and black-and-white contrast rather than colour: glass becomes reserved white plus a few diagonal hatch lines; metal becomes high-contrast black and white blocks plus a hatch highlight; polished floor becomes a reserved white highlight bar plus horizontal hatching.',
      '- Write lighting as dramatic hard light with strong light-and-shade contrast (noir lighting): no colour, no soft gradient, no depth-of-field blur.',
      '- No colour word and no photographic texture may appear anywhere; background and dressing use the same ink line plus screentone plus hatching.',
      '- **Genre noun / composition / thickness must be rewritten**: any photorealistic-photography wording follows this style - a prop written as "single-item product shot / product photo" becomes "black-and-white manga prop design sheet / manga scene sheet / manga character design sheet (pure white ground with screentone and hatching)"; delete "soft even studio light / high detail / realistic material texture / contact shadow"; a prop image is one panel of that prop\'s close-up in a manga; "thick prop / 3D quality" becomes "a prop with thickness expressed through ink line, screentone and hatching"; a prop\'s cast shadow is one flat block or layer of colour.',
      '- **Tighten the edges one more notch**: every colour boundary must be a hard straight edge with a visible seam, and no smooth transition or gradient whatsoever.',
      '- Always state space and relative positions in full (the image is the video anchor; the video must match the first frame).',
    ].join('\n'),
    description: '黑白漫/ Noir 高对比墨水风',
  },
]

/**
 * 旧版种子 prompt（v1 一句话风格描述）— 用于内容寻址升级：
 * 仅当库中行的 prompt 仍等于旧种子值（未被用户在设置页编辑过）才覆盖为新 prompt
 */
/**
 * 旧版种子 prompt（按风格列出、按顺序匹配）— 用于内容寻址升级：
 * 仅当库中行的 prompt 仍等于某条旧种子原文（未被用户在设置页编辑过）才覆盖为新 prompt。
 * 新增预设内容时，把「上一版种子原文」追加到对应数组末尾即可。
 */
/**
 * 旧版种子 prompt（按风格列出、按顺序匹配）— 用于内容寻址升级：
 * 仅当库中行的 prompt 仍等于某条旧种子原文（未被用户在设置页编辑过）才覆盖为新 prompt。
 * 新增预设内容时，把「上一版种子原文」追加到对应数组末尾即可。
 */
/**
 * 旧版种子 prompt（按风格列出、按顺序匹配）— 用于内容寻址升级：
 * 仅当库中行的 prompt 仍等于某条旧种子原文（未被用户在设置页编辑过）才覆盖为新 prompt。
 * 新增预设内容时，把「上一版种子原文」追加到对应数组末尾即可。
 */
/**
 * 旧版种子 prompt（按风格列出、按顺序匹配）— 用于内容寻址升级：
 * 仅当库中行的 prompt 仍等于某条旧种子原文（未被用户在设置页编辑过）才覆盖为新 prompt。
 * 新增预设内容时，把「上一版种子原文」追加到对应数组末尾即可。
 */
/**
 * 旧版种子 prompt（按风格列出、按顺序匹配）— 用于内容寻址升级：
 * 仅当库中行的 prompt 仍等于某条旧种子原文（未被用户在设置页编辑过）才覆盖为新 prompt。
 * 新增预设内容时，把「上一版种子原文」追加到对应数组末尾即可。
 */
const LEGACY_SEED_PROMPTS: Record<string, string[]> = {
  '3d': [
    'high-quality 3D CG animation still, modern game-engine cinematic render, Unreal Engine and Pixar grade quality, semi-realistic stylized characters with refined facial features, clean sculpted anatomy, detailed skin shader with subtle subsurface scattering, PBR materials with crisp detailed textures, volumetric cinematic lighting with soft rim light, rich depth of field, polished film color grading, detailed environment art, sharp focus, consistent character design across shots, avoid flat lighting, avoid plastic waxy skin, avoid low-poly blurry look, avoid 2D flat cel shading, avoid anime line art',
    '3D CG animation style, game-engine quality render, semi-realistic stylized characters, refined facial features, detailed materials and textures, cinematic lighting, high detail',
    'high-quality 3D CG animation still, modern game-engine cinematic render, Unreal Engine and Pixar grade quality, semi-realistic stylized characters with refined facial features, clean sculpted anatomy, detailed skin shader with subtle subsurface scattering, PBR materials with crisp detailed textures, volumetric cinematic lighting with soft rim light, rich depth of field, polished film color grading, detailed environment art, sharp focus, consistent character design across shots, avoid flat lighting, avoid plastic waxy skin, avoid low-poly blurry look, avoid 2D flat cel shading, avoid anime line art\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：3D CG】图片最终提示词的正文一律按 3D 实时渲染的写法描述，逐件陈设改写：\n- 把每个物件当作有真实建模体积的 3D 资产来写：写明形状、倒角、曲面与材质（哑光布、抛光石材、金属、玻璃、木器），并写出它们的粗糙度差异。\n- 光照写成 3D 场景布光：主光 + 补光 + 轮廓光、柔和阴影、环境光遮蔽、体积雾；可以有克制的浅景深与镜头感。\n- 材质反光按物理写：玻璃/水晶写折射与反射、金属写高光与环境反射、抛光石材写镜面倒影 —— 但都保持"干净的 CG 质感"，不要出现脏污噪点与照片颗粒。\n- 不要写"平涂、色块、描边、网点"这类二维词；不要出现手绘线条与纸张纹理。\n- 空间与相对位置照常写全（这张图是视频的场景锚点）。',
    'high-quality 3D CG animation still, modern game-engine cinematic render, Unreal Engine and Pixar grade quality, semi-realistic stylized characters with refined facial features, clean sculpted anatomy, detailed skin shader with subtle subsurface scattering, PBR materials with crisp detailed textures, volumetric cinematic lighting with soft rim light, rich depth of field, polished film color grading, detailed environment art, sharp focus, consistent character design across shots, avoid flat lighting, avoid plastic waxy skin, avoid low-poly blurry look, avoid 2D flat cel shading, avoid anime line art\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：3D CG】画面描述（图片提示词与视频提示词都算）一律按 3D 实时渲染的写法描述，逐件陈设改写：\n- 把每个物件当作有真实建模体积的 3D 资产来写：写明形状、倒角、曲面与材质（哑光布、抛光石材、金属、玻璃、木器），并写出它们的粗糙度差异。\n- 光照写成 3D 场景布光：主光 + 补光 + 轮廓光、柔和阴影、环境光遮蔽、体积雾；可以有克制的浅景深与镜头感。\n- 材质反光按物理写：玻璃/水晶写折射与反射、金属写高光与环境反射、抛光石材写镜面倒影 —— 但都保持"干净的 CG 质感"，不要出现脏污噪点与照片颗粒。\n- 不要写"平涂、色块、描边、网点"这类二维词；不要出现手绘线条与纸张纹理。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
    'high-quality 3D CG animation still, modern game-engine cinematic render, Unreal Engine and Pixar grade quality, semi-realistic stylized characters with refined facial features, clean sculpted anatomy, detailed skin shader with subtle subsurface scattering, PBR materials with crisp detailed textures, volumetric cinematic lighting with soft rim light, rich depth of field, polished film color grading, detailed environment art, sharp focus, consistent character design across shots, avoid flat lighting, avoid plastic waxy skin, avoid low-poly blurry look, avoid 2D flat cel shading, avoid anime line art\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：3D CG】画面描述（图片提示词与视频提示词都算）一律按 3D 实时渲染的写法描述，逐件陈设改写：\n- 把每个物件当作有真实建模体积的 3D 资产来写：写明形状、倒角、曲面与材质（哑光布、抛光石材、金属、玻璃、木器），并写出它们的粗糙度差异。\n- 光照写成 3D 场景布光：主光 + 补光 + 轮廓光、柔和阴影、环境光遮蔽、体积雾；可以有克制的浅景深与镜头感。\n- 材质反光按物理写：玻璃/水晶写折射与反射、金属写高光与环境反射、抛光石材写镜面倒影 —— 但都保持\"干净的 CG 质感\"，不要出现脏污噪点与照片颗粒。\n- 不要写\"平涂、色块、描边、网点\"这类二维词；不要出现手绘线条与纸张纹理。\n- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的\"单品产品图 / 产品照片 / 单品图\"、场景的\"写实照片 / 摄影\"、人物的\"摄影棚人像\" → 本画风用「3D 渲染道具设定图 / 3D 场景设定图 / 3D 角色设定图（纯白底或平涂背景）」；② \"柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影\"这类词一律删掉，光按上面的 3D 布光写法；③ 道具图不要写成\"孤立摆放在纯白背景上的商品图\"，要写成「3D 动画片里道具特写的那一帧静画」；④ \"立体道具 / 3D 质感\" → 「有厚度的道具，以真实的建模体积与材质（不要写成平涂色块）表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
  ],
  'anime': [
    'Japanese TV anime style, clean cel shading with hard-edged shadow shapes, crisp uniform black line art, vivid saturated color palette, expressive large-eyed character design with on-model proportions, detailed hand-painted anime backgrounds, dramatic anime key lighting with screentone highlights, key-visual poster quality, consistent character design across shots, avoid 3D CGI look, avoid painterly soft blending, avoid watercolor texture, avoid photorealism, avoid thick western comic outlines',
    'Japanese anime style, cel shading, clean crisp line art, vivid saturated colors, expressive character designs, detailed painted backgrounds',
    'Japanese 2D anime illustration, flat cel-shaded style, clean cel shading with hard-edged shadow shapes, crisp uniform black line art, vivid saturated color palette; characters, environments and props are ALL drawn in the same flat 2D anime medium, hand-painted anime background art with flat colour blocks and simplified shapes; expressive large-eyed character design with on-model proportions; dramatic anime key lighting with screentone highlights; key-visual poster quality; consistent art style across shots; avoid 3D CGI, avoid photorealism, avoid photographic or studio-photo look, avoid realistic material gloss, PBR reflections, global illumination and depth of field; avoid painterly soft blending, avoid watercolor texture, avoid thick western comic outlines',
    'Japanese 2D anime illustration, flat cel-shaded style, clean cel shading with hard-edged shadow shapes, crisp uniform black line art, vivid saturated color palette; characters, environments and props are ALL drawn in the same flat 2D anime medium, hand-painted anime background art with flat colour blocks and simplified shapes; expressive large-eyed character design with on-model proportions; dramatic anime key lighting with screentone highlights; key-visual poster quality; consistent art style across shots; avoid 3D CGI, avoid photorealism, avoid photographic or studio-photo look, avoid realistic material gloss, PBR reflections, global illumination and depth of field; avoid painterly soft blending, avoid watercolor texture, avoid thick western comic outlines\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：二维赛璐璐动画】图片最终提示词的正文一律按二维动画的绘制方式描述，逐件陈设改写：\n- 全图由平涂色块构成；每个物体的轮廓都用同样粗细的闭合黑线勾出；明暗只分亮面与暗面两层，交界是锐利直线；没有渐变、没有材质反光、没有景深虚化。\n- 材质词一律化掉：镜面反射/抛光/高光/倒影 → 几道平涂浅色块；玻璃与水晶 → 简化几何色块；金属 → 平涂色块加一道细亮边；织物/纸张 → 平涂加少量线纹。\n- 光照词一律化掉：不写真实光源、明暗过渡、体积光；只写"整体由暖色块与冷色块构成"这类块面关系。\n- 背景与陈设同样平涂，不出现照片质感、不出现写实景深。\n- 空间与相对位置照常写全（这张图是视频的场景锚点）。',
    'Japanese 2D anime illustration, flat cel-shaded style, clean cel shading with hard-edged shadow shapes, crisp uniform black line art, vivid saturated color palette; characters, environments and props are ALL drawn in the same flat 2D anime medium, hand-painted anime background art with flat colour blocks and simplified shapes; expressive large-eyed character design with on-model proportions; dramatic anime key lighting with screentone highlights; key-visual poster quality; consistent art style across shots; avoid 3D CGI, avoid photorealism, avoid photographic or studio-photo look, avoid realistic material gloss, PBR reflections, global illumination and depth of field; avoid painterly soft blending, avoid watercolor texture, avoid thick western comic outlines\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：二维赛璐璐动画】画面描述（图片提示词与视频提示词都算）一律按二维动画的绘制方式描述，逐件陈设改写：\n- 全图由平涂色块构成；每个物体的轮廓都用同样粗细的闭合黑线勾出；明暗只分亮面与暗面两层，交界是锐利直线；没有渐变、没有材质反光、没有景深虚化。\n- 材质词一律化掉：镜面反射/抛光/高光/倒影 → 几道平涂浅色块；玻璃与水晶 → 简化几何色块；金属 → 平涂色块加一道细亮边；织物/纸张 → 平涂加少量线纹。\n- 光照词一律化掉：不写真实光源、明暗过渡、体积光；只写"整体由暖色块与冷色块构成"这类块面关系。\n- 背景与陈设同样平涂，不出现照片质感、不出现写实景深。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
    'Japanese 2D anime illustration, flat cel-shaded style, clean cel shading with hard-edged shadow shapes, crisp uniform black line art, vivid saturated color palette; characters, environments and props are ALL drawn in the same flat 2D anime medium, hand-painted anime background art with flat colour blocks and simplified shapes; expressive large-eyed character design with on-model proportions; dramatic anime key lighting with screentone highlights; key-visual poster quality; consistent art style across shots; avoid 3D CGI, avoid photorealism, avoid photographic or studio-photo look, avoid realistic material gloss, PBR reflections, global illumination and depth of field; avoid painterly soft blending, avoid watercolor texture, avoid thick western comic outlines\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：二维赛璐璐动画】画面描述（图片提示词与视频提示词都算）一律按二维动画的绘制方式描述，逐件陈设改写：\n- 全图由平涂色块构成；每个物体的轮廓都用同样粗细的闭合黑线勾出；明暗只分亮面与暗面两层，交界是锐利直线；没有渐变、没有材质反光、没有景深虚化。\n- 材质词一律化掉：镜面反射/抛光/高光/倒影 → 几道平涂浅色块；玻璃与水晶 → 简化几何色块；金属 → 平涂色块加一道细亮边；织物/纸张 → 平涂加少量线纹。\n- 光照词一律化掉：不写真实光源、明暗过渡、体积光；只写\"整体由暖色块与冷色块构成\"这类块面关系。\n- 背景与陈设同样平涂，不出现照片质感、不出现写实景深。\n- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的\"单品产品图 / 产品照片 / 单品图\"、场景的\"写实照片 / 摄影\"、人物的\"摄影棚人像\" → 本画风用「二维动画道具设定图 / 二维动画场景插画 / 二维动画人物设定图（平涂纯白底）」；② \"柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影\"这类词一律删掉，光按上面的平涂写法；③ 道具图不要写成\"孤立摆放在纯白背景上的商品图\"，要写成「二维动画片里道具特写的那一帧静画（设定稿／原画）」；④ \"立体道具 / 3D 质感\" → 「有厚度的道具，以平涂色块表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。\n- **边缘再收紧一档**：所有色块的边界都必须是硬边直线、能看出色块之间的接缝、边缘允许轻微台阶感，禁止任何平滑过渡与渐变。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
  ],
  'ghibli': [
    'Studio Ghibli hand-drawn animation style, soft painterly brushwork with organic hand-crafted line quality, lush warm watercolor painted backgrounds, gentle natural daylight with nostalgic warm glow, muted earthy natural color palette, whimsical cozy storybook atmosphere, subtle film-grain softness, theatrical background art quality, consistent character design across shots, avoid hard cel shading, avoid 3D render look, avoid neon over-saturated colors, avoid sharp digital edges, avoid photorealism',
    'Studio Ghibli style, hand-drawn animation, soft watercolor painted backgrounds, warm nostalgic lighting, gentle natural palette, whimsical cozy atmosphere',
    'Studio Ghibli hand-drawn animation style, soft painterly brushwork with organic hand-crafted line quality, lush warm watercolor painted backgrounds, gentle natural daylight with nostalgic warm glow, muted earthy natural color palette, whimsical cozy storybook atmosphere, subtle film-grain softness, theatrical background art quality, consistent character design across shots, avoid hard cel shading, avoid 3D render look, avoid neon over-saturated colors, avoid sharp digital edges, avoid photorealism\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：手绘动画水彩背景】图片最终提示词的正文一律按手绘动画背景美术的写法描述，逐件陈设改写：\n- 以水彩/水粉晕染的笔触画背景：色块边缘是柔和的手绘边，可以有颜料渗化、干笔触与纸面颗粒；轮廓线是手绘的、粗细有变化，不是均匀印刷描边。\n- 明暗用柔和的色层过渡与湿画法晕开，不用硬边两段式阴影；受光处偏黄白，背光处偏蓝紫。\n- 光照写成自然日光与空气感：天光、云影、斑驳光点、空气中的浮尘；可以有淡淡的景深与胶片柔和感。\n- 材质词改写：玻璃/水面 → 半透明的浅色水彩晕染；金属 → 哑光色块加一点手绘高光；抛光石材 → 带柔和反光色层的平涂。\n- 细节保持手绘感与笔触，不出现照片质感、不出现 3D 渲染的塑料高光。\n- 空间与相对位置照常写全（这张图是视频的场景锚点）。',
    'Studio Ghibli hand-drawn animation style, soft painterly brushwork with organic hand-crafted line quality, lush warm watercolor painted backgrounds, gentle natural daylight with nostalgic warm glow, muted earthy natural color palette, whimsical cozy storybook atmosphere, subtle film-grain softness, theatrical background art quality, consistent character design across shots, avoid hard cel shading, avoid 3D render look, avoid neon over-saturated colors, avoid sharp digital edges, avoid photorealism\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：手绘动画水彩背景】画面描述（图片提示词与视频提示词都算）一律按手绘动画背景美术的写法描述，逐件陈设改写：\n- 以水彩/水粉晕染的笔触画背景：色块边缘是柔和的手绘边，可以有颜料渗化、干笔触与纸面颗粒；轮廓线是手绘的、粗细有变化，不是均匀印刷描边。\n- 明暗用柔和的色层过渡与湿画法晕开，不用硬边两段式阴影；受光处偏黄白，背光处偏蓝紫。\n- 光照写成自然日光与空气感：天光、云影、斑驳光点、空气中的浮尘；可以有淡淡的景深与胶片柔和感。\n- 材质词改写：玻璃/水面 → 半透明的浅色水彩晕染；金属 → 哑光色块加一点手绘高光；抛光石材 → 带柔和反光色层的平涂。\n- 细节保持手绘感与笔触，不出现照片质感、不出现 3D 渲染的塑料高光。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
    'Studio Ghibli hand-drawn animation style, soft painterly brushwork with organic hand-crafted line quality, lush warm watercolor painted backgrounds, gentle natural daylight with nostalgic warm glow, muted earthy natural color palette, whimsical cozy storybook atmosphere, subtle film-grain softness, theatrical background art quality, consistent character design across shots, avoid hard cel shading, avoid 3D render look, avoid neon over-saturated colors, avoid sharp digital edges, avoid photorealism\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：手绘动画水彩背景】画面描述（图片提示词与视频提示词都算）一律按手绘动画背景美术的写法描述，逐件陈设改写：\n- 以水彩/水粉晕染的笔触画背景：色块边缘是柔和的手绘边，可以有颜料渗化、干笔触与纸面颗粒；轮廓线是手绘的、粗细有变化，不是均匀印刷描边。\n- 明暗用柔和的色层过渡与湿画法晕开，不用硬边两段式阴影；受光处偏黄白，背光处偏蓝紫。\n- 光照写成自然日光与空气感：天光、云影、斑驳光点、空气中的浮尘；可以有淡淡的景深与胶片柔和感。\n- 材质词改写：玻璃/水面 → 半透明的浅色水彩晕染；金属 → 哑光色块加一点手绘高光；抛光石材 → 带柔和反光色层的平涂。\n- 细节保持手绘感与笔触，不出现照片质感、不出现 3D 渲染的塑料高光。\n- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的\"单品产品图 / 产品照片 / 单品图\"、场景的\"写实照片 / 摄影\"、人物的\"摄影棚人像\" → 本画风用「手绘动画道具设定图 / 手绘动画背景美术 / 手绘动画人物设定图（纯白或纸纹底）」；② \"柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影\"这类词一律删掉，光按上面的手绘水彩写法；③ 道具图不要写成\"孤立摆放在纯白背景上的商品图\"，要写成「手绘动画里道具特写的那一帧」；④ \"立体道具 / 3D 质感\" → 「有厚度的道具，以手绘笔触与水彩晕染的色层表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
  ],
  'watercolor': [
    'delicate watercolor storybook illustration, soft translucent color washes, visible cold-press paper texture, fluid hand-painted brushstrokes with gentle pigment bleeds, light airy atmosphere, harmonious pastel palette, whimsical children book charm, loose expressive edges, consistent character design across shots, avoid bold black outlines, avoid digital airbrush look, avoid harsh contrast, avoid 3D rendering, avoid photorealism',
    'watercolor illustration style, soft translucent washes, visible paper texture, delicate fluid brushwork, light airy atmosphere, hand-painted storybook feel',
    'delicate watercolor storybook illustration, soft translucent color washes, visible cold-press paper texture, fluid hand-painted brushstrokes with gentle pigment bleeds, light airy atmosphere, harmonious pastel palette, whimsical children book charm, loose expressive edges, consistent character design across shots, avoid bold black outlines, avoid digital airbrush look, avoid harsh contrast, avoid 3D rendering, avoid photorealism\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：水彩插画】图片最终提示词的正文一律按水彩插画的写法描述，逐件陈设改写：\n- 全图是半透明水彩层层叠加：能看到纸张纹理与颜料在边缘沉积出的深色边；形体靠色块边界与留白暗示，没有明确黑色轮廓线。\n- 明暗靠水彩的通透深浅：浅色=受光，叠色加深=背光；不要硬边阴影，也不要用纯黑压暗。\n- 色彩是和谐的淡彩，允许颜色在相邻区域自然混渗；笔触是松散的、可见的手绘笔触。\n- 材质词改写：玻璃/水面 → 浅色透明晕染 + 留白；金属 → 哑光灰蓝色块 + 一点白色留白当高光；织物 → 平涂色块 + 少量线条纹理。\n- 不写抛光、镜面反射、景深虚化、体积光；背景与陈设同样用松散水彩笔触，不出现照片质感。\n- 空间与相对位置照常写全（这张图是视频的场景锚点）。',
    'delicate watercolor storybook illustration, soft translucent color washes, visible cold-press paper texture, fluid hand-painted brushstrokes with gentle pigment bleeds, light airy atmosphere, harmonious pastel palette, whimsical children book charm, loose expressive edges, consistent character design across shots, avoid bold black outlines, avoid digital airbrush look, avoid harsh contrast, avoid 3D rendering, avoid photorealism\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：水彩插画】画面描述（图片提示词与视频提示词都算）一律按水彩插画的写法描述，逐件陈设改写：\n- 全图是半透明水彩层层叠加：能看到纸张纹理与颜料在边缘沉积出的深色边；形体靠色块边界与留白暗示，没有明确黑色轮廓线。\n- 明暗靠水彩的通透深浅：浅色=受光，叠色加深=背光；不要硬边阴影，也不要用纯黑压暗。\n- 色彩是和谐的淡彩，允许颜色在相邻区域自然混渗；笔触是松散的、可见的手绘笔触。\n- 材质词改写：玻璃/水面 → 浅色透明晕染 + 留白；金属 → 哑光灰蓝色块 + 一点白色留白当高光；织物 → 平涂色块 + 少量线条纹理。\n- 不写抛光、镜面反射、景深虚化、体积光；背景与陈设同样用松散水彩笔触，不出现照片质感。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
    'delicate watercolor storybook illustration, soft translucent color washes, visible cold-press paper texture, fluid hand-painted brushstrokes with gentle pigment bleeds, light airy atmosphere, harmonious pastel palette, whimsical children book charm, loose expressive edges, consistent character design across shots, avoid bold black outlines, avoid digital airbrush look, avoid harsh contrast, avoid 3D rendering, avoid photorealism\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：水彩插画】画面描述（图片提示词与视频提示词都算）一律按水彩插画的写法描述，逐件陈设改写：\n- 全图是半透明水彩层层叠加：能看到纸张纹理与颜料在边缘沉积出的深色边；形体靠色块边界与留白暗示，没有明确黑色轮廓线。\n- 明暗靠水彩的通透深浅：浅色=受光，叠色加深=背光；不要硬边阴影，也不要用纯黑压暗。\n- 色彩是和谐的淡彩，允许颜色在相邻区域自然混渗；笔触是松散的、可见的手绘笔触。\n- 材质词改写：玻璃/水面 → 浅色透明晕染 + 留白；金属 → 哑光灰蓝色块 + 一点白色留白当高光；织物 → 平涂色块 + 少量线条纹理。\n- 不写抛光、镜面反射、景深虚化、体积光；背景与陈设同样用松散水彩笔触，不出现照片质感。\n- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的\"单品产品图 / 产品照片 / 单品图\"、场景的\"写实照片 / 摄影\"、人物的\"摄影棚人像\" → 本画风用「水彩道具插画 / 水彩场景插画 / 水彩人物插画（纸纹白底）」；② \"柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影\"这类词一律删掉，光按上面的水彩写法；③ 道具图不要写成\"孤立摆放在纯白背景上的商品图\"，要写成「水彩绘本里的道具插图」；④ \"立体道具 / 3D 质感\" → 「有厚度的道具，以半透明水彩叠色表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
  ],
  'comic': [
    'Western graphic-novel comic book style, bold confident black ink outlines, halftone dot shading and screentone gradients, dynamic saturated colors with dramatic contrast, dramatic spotlight lighting, flat graphic print look, sharp inking details, dynamic cinematic composition, consistent character design across shots, avoid painterly soft blending, avoid watercolor washes, avoid photorealistic rendering, avoid 3D CGI look, avoid anime cel shading',
    'Western comic book style, bold black ink outlines, halftone dot shading, dynamic saturated colors, dramatic contrast lighting, flat graphic novel look',
    'Western graphic-novel comic book style, bold confident black ink outlines, halftone dot shading and screentone gradients, dynamic saturated colors with dramatic contrast, dramatic spotlight lighting, flat graphic print look, sharp inking details, dynamic cinematic composition, consistent character design across shots, avoid painterly soft blending, avoid watercolor washes, avoid photorealistic rendering, avoid 3D CGI look, avoid anime cel shading\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：美式漫画墨线+网点】图片最终提示词的正文一律按美式漫画的绘制方式描述，逐件陈设改写：\n- 每个物体轮廓用自信的黑色墨线勾出，线的粗细有变化（重心线加粗、细节线变细）；阴影侧用较粗的线加强。\n- 明暗只用三种手段：大面积纯黑色块做负空间、网点（halftone 圆点）做灰阶、排线/交叉排线做过渡。不要柔和的渐变过渡。\n- 上色是平涂加硬边分界，色彩饱和、块面对比强烈；可以有印刷套色偏移的手感。\n- 材质词改写：玻璃 → 高对比平涂色块 + 一道纯白高光；金属 → 高对比黑白块 + 网点高光；抛光石材 → 平涂色块 + 几道网点反光条。\n- 不写镜面反射细节、不写景深虚化、不写照片质感；背景与陈设同样以墨线 + 网点处理。\n- 空间与相对位置照常写全（这张图是视频的场景锚点）。',
    'Western graphic-novel comic book style, bold confident black ink outlines, halftone dot shading and screentone gradients, dynamic saturated colors with dramatic contrast, dramatic spotlight lighting, flat graphic print look, sharp inking details, dynamic cinematic composition, consistent character design across shots, avoid painterly soft blending, avoid watercolor washes, avoid photorealistic rendering, avoid 3D CGI look, avoid anime cel shading\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：美式漫画墨线+网点】画面描述（图片提示词与视频提示词都算）一律按美式漫画的绘制方式描述，逐件陈设改写：\n- 每个物体轮廓用自信的黑色墨线勾出，线的粗细有变化（重心线加粗、细节线变细）；阴影侧用较粗的线加强。\n- 明暗只用三种手段：大面积纯黑色块做负空间、网点（halftone 圆点）做灰阶、排线/交叉排线做过渡。不要柔和的渐变过渡。\n- 上色是平涂加硬边分界，色彩饱和、块面对比强烈；可以有印刷套色偏移的手感。\n- 材质词改写：玻璃 → 高对比平涂色块 + 一道纯白高光；金属 → 高对比黑白块 + 网点高光；抛光石材 → 平涂色块 + 几道网点反光条。\n- 不写镜面反射细节、不写景深虚化、不写照片质感；背景与陈设同样以墨线 + 网点处理。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
    'Western graphic-novel comic book style, bold confident black ink outlines, halftone dot shading and screentone gradients, dynamic saturated colors with dramatic contrast, dramatic spotlight lighting, flat graphic print look, sharp inking details, dynamic cinematic composition, consistent character design across shots, avoid painterly soft blending, avoid watercolor washes, avoid photorealistic rendering, avoid 3D CGI look, avoid anime cel shading\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：美式漫画墨线+网点】画面描述（图片提示词与视频提示词都算）一律按美式漫画的绘制方式描述，逐件陈设改写：\n- 每个物体轮廓用自信的黑色墨线勾出，线的粗细有变化（重心线加粗、细节线变细）；阴影侧用较粗的线加强。\n- 明暗只用三种手段：大面积纯黑色块做负空间、网点（halftone 圆点）做灰阶、排线/交叉排线做过渡。不要柔和的渐变过渡。\n- 上色是平涂加硬边分界，色彩饱和、块面对比强烈；可以有印刷套色偏移的手感。\n- 材质词改写：玻璃 → 高对比平涂色块 + 一道纯白高光；金属 → 高对比黑白块 + 网点高光；抛光石材 → 平涂色块 + 几道网点反光条。\n- 不写镜面反射细节、不写景深虚化、不写照片质感；背景与陈设同样以墨线 + 网点处理。\n- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的\"单品产品图 / 产品照片 / 单品图\"、场景的\"写实照片 / 摄影\"、人物的\"摄影棚人像\" → 本画风用「美式漫画道具设定图 / 美式漫画场景图 / 美式漫画人物设定图（纯白底 + 网点）」；② \"柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影\"这类词一律删掉，光按上面的墨线+网点写法；③ 道具图不要写成\"孤立摆放在纯白背景上的商品图\"，要写成「美式漫画里道具特写的那一格」；④ \"立体道具 / 3D 质感\" → 「有厚度的道具，以硬边平涂色块表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。\n- **边缘再收紧一档**：所有色块的边界都必须是硬边直线、能看出色块之间的接缝、边缘允许轻微台阶感，禁止任何平滑过渡与渐变。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
  ],
  'guofeng': [
    'Chinese guofeng 2.5D illustration style, semi-realistic donghua-quality character art, elegant flowing line work, rich traditional Chinese aesthetic elements, layered ink-wash inspired atmospheric backgrounds, refined silk and fabric textures, soft luminous lighting with gentle haze, sophisticated muted jewel-tone palette, xianxia drama poster quality, consistent character design across shots, avoid flat cel shading, avoid western comic ink style, avoid photorealism, avoid plastic 3D look, avoid modern clothing and props unless specified',
    'Chinese guofeng 2.5D illustration style, semi-realistic donghua-quality character art, elegant flowing line work, rich traditional Chinese aesthetic elements, layered ink-wash inspired atmospheric backgrounds, refined silk and fabric textures, soft luminous lighting with gentle haze, sophisticated muted jewel-tone palette, xianxia drama poster quality, consistent character design across shots, avoid flat cel shading, avoid western comic ink style, avoid photorealism, avoid plastic 3D look, avoid modern clothing and props unless specified\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：国风 2.5D 动画】图片最终提示词的正文一律按国风动画/仙侠剧的绘制方式描述，逐件陈设改写：\n- 形体半写实、用偏细而有粗细变化的流畅线条勾勒轮廓；上色是平涂 + 少量柔和渐变，保留干净的色块感。\n- 背景用带水墨感的层叠晕染、远山雾气与留白处理；不追求照片级的细节密度。\n- 光照偏柔和：柔光 + 轻雾 + 逆光轮廓，可有克制的景深；不写刺眼的镜面高光与硬阴影。\n- 材质写成"动画化的干净质感"：丝绸/布料 → 平涂 + 柔和渐变与流畅衣纹线；木/玉/铜 → 平涂 + 一点手绘高光；玻璃/瓷 → 浅色块 + 白色细高光。不写真实反射斑点与照片级纹理。\n- 整体色调用沉静的宝石色/青金/朱红，不出现照片质感与 3D 塑料高光。\n- 空间与相对位置照常写全（这张图是视频的场景锚点）。',
    'Chinese guofeng 2.5D illustration style, semi-realistic donghua-quality character art, elegant flowing line work, rich traditional Chinese aesthetic elements, layered ink-wash inspired atmospheric backgrounds, refined silk and fabric textures, soft luminous lighting with gentle haze, sophisticated muted jewel-tone palette, xianxia drama poster quality, consistent character design across shots, avoid flat cel shading, avoid western comic ink style, avoid photorealism, avoid plastic 3D look, avoid modern clothing and props unless specified\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：国风 2.5D 动画】画面描述（图片提示词与视频提示词都算）一律按国风动画/仙侠剧的绘制方式描述，逐件陈设改写：\n- 形体半写实、用偏细而有粗细变化的流畅线条勾勒轮廓；上色是平涂 + 少量柔和渐变，保留干净的色块感。\n- 背景用带水墨感的层叠晕染、远山雾气与留白处理；不追求照片级的细节密度。\n- 光照偏柔和：柔光 + 轻雾 + 逆光轮廓，可有克制的景深；不写刺眼的镜面高光与硬阴影。\n- 材质写成"动画化的干净质感"：丝绸/布料 → 平涂 + 柔和渐变与流畅衣纹线；木/玉/铜 → 平涂 + 一点手绘高光；玻璃/瓷 → 浅色块 + 白色细高光。不写真实反射斑点与照片级纹理。\n- 整体色调用沉静的宝石色/青金/朱红，不出现照片质感与 3D 塑料高光。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
    'Chinese guofeng 2.5D illustration style, semi-realistic donghua-quality character art, elegant flowing line work, rich traditional Chinese aesthetic elements, layered ink-wash inspired atmospheric backgrounds, refined silk and fabric textures, soft luminous lighting with gentle haze, sophisticated muted jewel-tone palette, xianxia drama poster quality, consistent character design across shots, avoid flat cel shading, avoid western comic ink style, avoid photorealism, avoid plastic 3D look, avoid modern clothing and props unless specified\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：国风 2.5D 动画】画面描述（图片提示词与视频提示词都算）一律按国风动画/仙侠剧的绘制方式描述，逐件陈设改写：\n- 形体半写实、用偏细而有粗细变化的流畅线条勾勒轮廓；上色是平涂 + 少量柔和渐变，保留干净的色块感。\n- 背景用带水墨感的层叠晕染、远山雾气与留白处理；不追求照片级的细节密度。\n- 光照偏柔和：柔光 + 轻雾 + 逆光轮廓，可有克制的景深；不写刺眼的镜面高光与硬阴影。\n- 材质写成\"动画化的干净质感\"：丝绸/布料 → 平涂 + 柔和渐变与流畅衣纹线；木/玉/铜 → 平涂 + 一点手绘高光；玻璃/瓷 → 浅色块 + 白色细高光。不写真实反射斑点与照片级纹理。\n- 整体色调用沉静的宝石色/青金/朱红，不出现照片质感与 3D 塑料高光。\n- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的\"单品产品图 / 产品照片 / 单品图\"、场景的\"写实照片 / 摄影\"、人物的\"摄影棚人像\" → 本画风用「国风平面道具设定图 / 国风动画场景图 / 国风动画人物设定图（纯白或淡墨底）」；② \"柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影\"这类词一律删掉，光按上面的国风平涂+柔光写法；③ 道具图不要写成\"孤立摆放在纯白背景上的商品图\"，要写成「国风动画里道具特写的那一帧」；④ \"立体道具 / 3D 质感\" → 「有厚度的道具，以平涂加少量柔和渐变表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
  ],
  'webtoon': [
    'Korean webtoon manhwa style, clean digital painting with soft gradient shading, slim elegant character proportions, large expressive eyes with detailed highlights, soft glowing skin rendering, romantic dreamy lighting, modern pastel-to-vivid color palette, detailed fashion and fabric rendering, webtoon key visual quality, consistent character design across shots, avoid heavy black ink outlines, avoid halftone dots, avoid 3D render look, avoid watercolor paper texture, avoid chibi proportions',
    'Korean webtoon manhwa style, clean digital painting with soft gradient shading, slim elegant character proportions, large expressive eyes with detailed highlights, soft glowing skin rendering, romantic dreamy lighting, modern pastel-to-vivid color palette, detailed fashion and fabric rendering, webtoon key visual quality, consistent character design across shots, avoid heavy black ink outlines, avoid halftone dots, avoid 3D render look, avoid watercolor paper texture, avoid chibi proportions\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：韩国条漫数码上色】图片最终提示词的正文一律按韩国网漫的绘制方式描述，逐件陈设改写：\n- 线稿细而清晰，用深褐或深灰（不是纯黑粗描边）；轮廓可以局部断开、不追求闭合描边。\n- 上色是平涂 + 柔和渐变的过渡阴影（不是硬边两段式）；暗部用冷色透明叠加，受光处透亮。\n- 光照浪漫柔和：柔光、光斑、可见的浅景深虚化；整体画面干净通透、可比照片更亮。\n- 材质词改写：玻璃/金属 → 干净的渐变高光与白色反光条；抛光地面 → 柔和的亮色倒影渐变；织物 → 细腻平涂 + 少量褶皱渐变。\n- 不写网点、不写粗黑漫画描边、不写照片颗粒；背景与陈设同样用干净的数码平涂 + 渐变处理。\n- 空间与相对位置照常写全（这张图是视频的场景锚点）。',
    'Korean webtoon manhwa style, clean digital painting with soft gradient shading, slim elegant character proportions, large expressive eyes with detailed highlights, soft glowing skin rendering, romantic dreamy lighting, modern pastel-to-vivid color palette, detailed fashion and fabric rendering, webtoon key visual quality, consistent character design across shots, avoid heavy black ink outlines, avoid halftone dots, avoid 3D render look, avoid watercolor paper texture, avoid chibi proportions\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：韩国条漫数码上色】画面描述（图片提示词与视频提示词都算）一律按韩国网漫的绘制方式描述，逐件陈设改写：\n- 线稿细而清晰，用深褐或深灰（不是纯黑粗描边）；轮廓可以局部断开、不追求闭合描边。\n- 上色是平涂 + 柔和渐变的过渡阴影（不是硬边两段式）；暗部用冷色透明叠加，受光处透亮。\n- 光照浪漫柔和：柔光、光斑、可见的浅景深虚化；整体画面干净通透、可比照片更亮。\n- 材质词改写：玻璃/金属 → 干净的渐变高光与白色反光条；抛光地面 → 柔和的亮色倒影渐变；织物 → 细腻平涂 + 少量褶皱渐变。\n- 不写网点、不写粗黑漫画描边、不写照片颗粒；背景与陈设同样用干净的数码平涂 + 渐变处理。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
    'Korean webtoon manhwa style, clean digital painting with soft gradient shading, slim elegant character proportions, large expressive eyes with detailed highlights, soft glowing skin rendering, romantic dreamy lighting, modern pastel-to-vivid color palette, detailed fashion and fabric rendering, webtoon key visual quality, consistent character design across shots, avoid heavy black ink outlines, avoid halftone dots, avoid 3D render look, avoid watercolor paper texture, avoid chibi proportions\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：韩国条漫数码上色】画面描述（图片提示词与视频提示词都算）一律按韩国网漫的绘制方式描述，逐件陈设改写：\n- 线稿细而清晰，用深褐或深灰（不是纯黑粗描边）；轮廓可以局部断开、不追求闭合描边。\n- 上色是平涂 + 柔和渐变的过渡阴影（不是硬边两段式）；暗部用冷色透明叠加，受光处透亮。\n- 光照浪漫柔和：柔光、光斑、可见的浅景深虚化；整体画面干净通透、可比照片更亮。\n- 材质词改写：玻璃/金属 → 干净的渐变高光与白色反光条；抛光地面 → 柔和的亮色倒影渐变；织物 → 细腻平涂 + 少量褶皱渐变。\n- 不写网点、不写粗黑漫画描边、不写照片颗粒；背景与陈设同样用干净的数码平涂 + 渐变处理。\n- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的\"单品产品图 / 产品照片 / 单品图\"、场景的\"写实照片 / 摄影\"、人物的\"摄影棚人像\" → 本画风用「韩系条漫道具设定图 / 韩系条漫场景图 / 韩系条漫人物设定图（纯白数码底）」；② \"柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影\"这类词一律删掉，光按上面的数码渐变写法；③ 道具图不要写成\"孤立摆放在纯白背景上的商品图\"，要写成「韩系条漫里道具特写的那一格」；④ \"立体道具 / 3D 质感\" → 「有厚度的道具，以数码平涂与柔和渐变表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
  ],
  'noir': [
    'black and white manga illustration, high-contrast monochrome ink work, dynamic hatching and cross-hatching shading, bold solid blacks with dramatic negative space, screentone gray gradation, expressive confident ink linework, cinematic noir lighting, professional manga page quality, consistent character design across shots, strictly no color, avoid grayscale blur smudging, avoid painterly soft edges, avoid photorealism, avoid 3D render look',
    'black and white manga illustration, high-contrast monochrome ink work, dynamic hatching and cross-hatching shading, bold solid blacks with dramatic negative space, screentone gray gradation, expressive confident ink linework, cinematic noir lighting, professional manga page quality, consistent character design across shots, strictly no color, avoid grayscale blur smudging, avoid painterly soft edges, avoid photorealism, avoid 3D render look\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：黑白漫画墨水】图片最终提示词的正文一律按黑白漫画的绘制方式描述，逐件陈设改写：\n- 全图没有任何彩色，只有黑白灰与网点；物体轮廓用有力度的墨线勾出，阴影侧线条加粗。\n- 明暗分层：排线/交叉排线做中间调，网点做灰阶，大块纯黑做负空间与剪影；可以有速度线和集中线。\n- 材质不靠颜色区分，只靠排线密度与黑白对比：玻璃 → 留白 + 几道斜排线；金属 → 高对比黑白块 + 排线高光；抛光地面 → 留白高光条 + 横向排线。\n- 光照写成戏剧性的硬光与强烈明暗对比（noir 布光）：不写颜色、不写柔和渐变、不写景深虚化。\n- 不出现任何颜色词，不出现照片质感；背景与陈设同样用墨线 + 网点 + 排线处理。\n- 空间与相对位置照常写全（这张图是视频的场景锚点）。',
    'black and white manga illustration, high-contrast monochrome ink work, dynamic hatching and cross-hatching shading, bold solid blacks with dramatic negative space, screentone gray gradation, expressive confident ink linework, cinematic noir lighting, professional manga page quality, consistent character design across shots, strictly no color, avoid grayscale blur smudging, avoid painterly soft edges, avoid photorealism, avoid 3D render look\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：黑白漫画墨水】画面描述（图片提示词与视频提示词都算）一律按黑白漫画的绘制方式描述，逐件陈设改写：\n- 全图没有任何彩色，只有黑白灰与网点；物体轮廓用有力度的墨线勾出，阴影侧线条加粗。\n- 明暗分层：排线/交叉排线做中间调，网点做灰阶，大块纯黑做负空间与剪影；可以有速度线和集中线。\n- 材质不靠颜色区分，只靠排线密度与黑白对比：玻璃 → 留白 + 几道斜排线；金属 → 高对比黑白块 + 排线高光；抛光地面 → 留白高光条 + 横向排线。\n- 光照写成戏剧性的硬光与强烈明暗对比（noir 布光）：不写颜色、不写柔和渐变、不写景深虚化。\n- 不出现任何颜色词，不出现照片质感；背景与陈设同样用墨线 + 网点 + 排线处理。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
    'black and white manga illustration, high-contrast monochrome ink work, dynamic hatching and cross-hatching shading, bold solid blacks with dramatic negative space, screentone gray gradation, expressive confident ink linework, cinematic noir lighting, professional manga page quality, consistent character design across shots, strictly no color, avoid grayscale blur smudging, avoid painterly soft edges, avoid photorealism, avoid 3D render look\n---BODY-RENDER-LANGUAGE---\n【正文渲染语言：黑白漫画墨水】画面描述（图片提示词与视频提示词都算）一律按黑白漫画的绘制方式描述，逐件陈设改写：\n- 全图没有任何彩色，只有黑白灰与网点；物体轮廓用有力度的墨线勾出，阴影侧线条加粗。\n- 明暗分层：排线/交叉排线做中间调，网点做灰阶，大块纯黑做负空间与剪影；可以有速度线和集中线。\n- 材质不靠颜色区分，只靠排线密度与黑白对比：玻璃 → 留白 + 几道斜排线；金属 → 高对比黑白块 + 排线高光；抛光地面 → 留白高光条 + 横向排线。\n- 光照写成戏剧性的硬光与强烈明暗对比（noir 布光）：不写颜色、不写柔和渐变、不写景深虚化。\n- 不出现任何颜色词，不出现照片质感；背景与陈设同样用墨线 + 网点 + 排线处理。\n- **体裁词 / 构图 / 厚度必须换**：① 正文里凡是写实摄影词一律按本画风改写 —— 道具的\"单品产品图 / 产品照片 / 单品图\"、场景的\"写实照片 / 摄影\"、人物的\"摄影棚人像\" → 本画风用「黑白漫画道具设定图 / 黑白漫画场景图 / 黑白漫画人物设定图（纯白底 + 网点排线）」；② \"柔和均匀的影棚光 / 高细节 / 真实材质纹理 / 接触阴影\"这类词一律删掉，光按上面的黑白网点排线写法；③ 道具图不要写成\"孤立摆放在纯白背景上的商品图\"，要写成「黑白漫画里道具特写的那一格」；④ \"立体道具 / 3D 质感\" → 「有厚度的道具，以墨线、网点与排线表现厚度」；⑤ 道具落影只画一道该画风的色块／色层，不画体积阴影。\n- **边缘再收紧一档**：所有色块的边界都必须是硬边直线、能看出色块之间的接缝、边缘允许轻微台阶感，禁止任何平滑过渡与渐变。\n- 空间与相对位置照常写全（图片是视频的锚点；视频要与首帧一致）。',
  ],
}

/**
 * 已下架的种子预设 — 内容寻址删除：仅当库中行的 prompt 仍是种子原文
 * （未被用户编辑过）才删除；用户改过的同名行视为用户数据保留。
 * live（真人写实）：真人影像过不了平台真人内容审核，下架。
 */
const REMOVED_SEED_PROMPTS: Record<string, string> = {
  live: 'ultra-realistic cinematic live-action look, professional film photography, natural skin tones with detailed pores and realistic texture, true human anatomy and proportions, shallow depth of field with creamy bokeh, cinematic three-point lighting, subtle film grain, 35mm lens cinematic framing, true-to-life color grading, detailed real-world environments, consistent actor appearance across shots, avoid cartoon or anime features, avoid 3D render look, avoid illustration style, avoid plastic waxy skin, avoid over-smoothing beauty filter',
}

// INSERT ... SELECT WHERE NOT EXISTS → 幂等：只补缺失行，不覆盖用户编辑
// （SQLite 无 FROM DUAL，无 FROM 的 SELECT 合法）
const SEED_SQL = 'INSERT INTO style_presets ("name", "value", "prompt", "description", "sort_order", "is_active", "created_at", "updated_at") SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM style_presets WHERE value = ?)'
// 内容寻址升级：命中旧种子原文才更新（用户在设置页改过的行不动）
const UPGRADE_SQL = 'UPDATE style_presets SET "name" = ?, "prompt" = ?, "description" = ?, "sort_order" = ?, "updated_at" = ? WHERE "value" = ? AND "prompt" = ?'
// 内容寻址下架：命中下架种子原文才删除
const REMOVE_SQL = 'DELETE FROM style_presets WHERE "value" = ? AND "prompt" = ?'

export function initSqliteSchema(sqlite: Database.Database) {
  for (const statement of sqliteSchemaStatements) {
    // ALTER ADD COLUMN 幂等：列已存在时 SQLite 抛 "duplicate column name"，
    // 该错误可忽略（老库第二次启动、或列已在库里时属正常）
    try {
      sqlite.exec(statement)
    } catch (err: any) {
      if (/duplicate column name/i.test(String(err?.message || err))) continue
      throw err
    }
  }
  const insertSeed = sqlite.prepare(SEED_SQL)
  const upgradeSeed = sqlite.prepare(UPGRADE_SQL)
  const removeSeed = sqlite.prepare(REMOVE_SQL)
  for (const s of stylePresetSeeds) {
    const ts = new Date().toISOString()
    insertSeed.run(s.name, s.value, s.prompt, s.description, s.sortOrder, ts, ts, s.value)
    for (const legacyPrompt of LEGACY_SEED_PROMPTS[s.value] || []) {
      const res = upgradeSeed.run(s.name, s.prompt, s.description, s.sortOrder, ts, s.value, legacyPrompt)
      if (res.changes > 0) {
        console.log(`🎨 风格预设「${s.name}」已升级为结构化提示词`)
        break
      }
    }
  }
  for (const [value, prompt] of Object.entries(REMOVED_SEED_PROMPTS)) {
    const res = removeSeed.run(value, prompt)
    if (res.changes > 0) console.log(`🗑️ 风格预设「${value}」已下架`)
  }
}

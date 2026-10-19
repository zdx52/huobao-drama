<template>
  <div class="page">
    <!-- Header：与短剧页同款单行紧凑头部 -->
    <div class="page-head card">
      <button class="back-btn" title="返回项目" @click="back" :disabled="busy">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
        </svg>
      </button>
      <div class="head-info">
        <h1 class="page-title">{{ pj.title || '未命名 MV' }}</h1>
        <button class="btn btn-icon btn-sm title-edit-btn" title="改名称" @click="openRename">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <span class="tag tag-accent">{{ statusZh(pj.status) }}</span>
        <span v-if="styleLabel(pj.style)" class="tag">{{ styleLabel(pj.style) }}</span>
        <div class="page-meta">
          <span class="meta-item">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>
            {{ Number(pj.songSeconds || 0).toFixed(1) }}s
          </span>
          <span class="meta-item">{{ characters.length }} 人物 · {{ scenes.length }} 场景 · {{ shots.length }} 段</span>
        </div>
      </div>
      <div class="mv-top-selects">
        <ModelSelect :label="'文本'" v-model="mvTextModel" :options="textModelOptions"
          :default-label="'默认（' + (textModelOptions[0]?.model || '未配') + '）'" :show-config="hasMultiConfigs(textModelOptions)" />
        <ModelSelect :label="'图片'" v-model="mvImageModel" :options="imageModelOptions"
          :default-label="'默认（' + (imageModelOptions[0]?.model || '未配') + '）'" :show-config="hasMultiConfigs(imageModelOptions)" />
        <ModelSelect :label="'视频'" v-model="mvVideoModel" :options="videoModelOptions"
          :default-label="'默认（' + (videoModelOptions[0]?.model || '未配') + '）'" :show-config="hasMultiConfigs(videoModelOptions)" />
        <span class="mv-sel" title="画幅（在「原始内容」页改）">
          <span class="mv-sel-k">画幅</span><span class="mv-sel-v">{{ editRatio }}</span>
        </span>
      </div>
      <div class="head-actions">
        <span v-if="busy && stepMsg" class="busy-hint">{{ stepMsg }}</span>
        <template v-if="tab === 'video'">
          <span class="mv-step-hint">①</span>
          <button class="btn btn-sm" :class="{ 'is-on': !!pj.vocalStem }" @click="askSeparate" :disabled="busy || separating"
            :title="pj.vocalStem ? '已分离：' + pj.vocalStem : '用 demucs 分出人声轨，供唱/非唱判据用'">
            {{ separating ? '分离中…' : (pj.vocalStem ? '已分离人声' : '人声分离') }}
          </button>
          <span class="mv-step-hint">②</span>
          <input v-model.number="maxSeconds" class="input mv-num" type="number" min="5" max="15" step="0.5" title="最长切分（秒，H3 上限 15）" />
          <button class="btn btn-sm" @click="genShots" :disabled="busy || !pj.vocalStem"
            :title="pj.vocalStem ? (shots.length ? '按人声轨重新切分（会重建现有分镜）' : '按人声轨切分并标唱/非唱') : '先做人声分离——分镜的唱/非唱要靠人声轨判断'">{{ shots.length ? '重新拆分' : '拆分分镜' }}</button>
          <span class="mv-step-hint">③</span>
          <button class="btn btn-sm" @click="askGenPrompts" :disabled="busy || !shots.length" title="只给还没有提示词的分镜补上；已生成的不动（要重写点该段的「重新生成」）">批量补齐提示词</button>
          <button class="btn btn-sm" @click="askCheckAll" :disabled="!shots.length" title="只读文本检查，不会打断正在生成的视频">全部体检</button>
          <span class="mv-step-hint">④</span>
          <button class="btn btn-sm" @click="askRenderAll" :disabled="busy || !shots.length">生成全部</button>
          <button class="btn btn-sm" :class="{ 'is-on': selectMode }" @click="toggleSelectMode">{{ selectMode ? '退出批量' : '批量选择' }}</button>
        </template>
        <button class="btn btn-sm" @click="taskDrawer = true">
          任务<span v-if="activeTaskCount" class="mv-task-badge">{{ activeTaskCount }}</span>
        </button>
      </div>
    </div>

      <div class="mv-layout">
        <aside class="mv-side">
          <div class="mv-side-title">MV 制作流程</div>
          <button type="button" :class="['mv-side-item', { active: tab === 'origin' }]" @click="tab = 'origin'">
            <span class="mv-side-icon">🎵</span>
            <span class="mv-side-label">原始内容</span>
          </button>
          <button type="button" :class="['mv-side-item', { active: tab === 'outline' }]" @click="tab = 'outline'">
            <span class="mv-side-icon">📜</span>
            <span class="mv-side-label">初步分镜</span>
            <span v-if="outline.length" class="mv-side-count">{{ outline.length }}</span>
          </button>
          <button type="button" :class="['mv-side-item', { active: tab === 'assets' }]" @click="tab = 'assets'">
            <span class="mv-side-icon">🧑‍🎤</span>
            <span class="mv-side-label">资产制作</span>
            <span v-if="assets.length" class="mv-side-count">{{ assets.length }}</span>
          </button>
          <button type="button" :class="['mv-side-item', { active: tab === 'video' }]" @click="tab = 'video'">
            <span class="mv-side-icon">🎥</span>
            <span class="mv-side-label">视频制作</span>
            <span v-if="shots.length" class="mv-side-count">{{ shots.length }}</span>
          </button>
          <button type="button" :class="['mv-side-item', { active: tab === 'export' }]" @click="enterExport">
            <span class="mv-side-icon">📦</span>
            <span class="mv-side-label">合成导出</span>
            <span v-if="pj.outputUrl" class="mv-side-count">✓</span>
          </button>
          <div v-if="shots.length" class="mv-side-progress">
            <div class="mv-side-progress-head">
              <span class="mv-side-progress-title">制作进度</span>
              <span class="mv-side-progress-count">{{ progressVideo }}/{{ shots.length }}</span>
            </div>
            <div class="mv-side-progress-track">
              <button v-for="p in progressSteps" :key="p.key" type="button" class="mv-side-progress-seg"
                :class="{ done: p.total > 0 && p.done === p.total, current: p.done > 0 && p.done < p.total }"
                :title="p.label + ' ' + p.done + '/' + p.total" @click="tab = 'video'">
                <span class="mv-side-progress-seg-fill" :style="{ width: p.pct + '%' }" />
              </button>
            </div>
            <div class="mv-side-progress-labels">
              <span v-for="p in progressSteps" :key="p.key" class="mv-side-progress-label"
                :class="{ on: p.total > 0 && p.done === p.total }">{{ p.label }} {{ p.done }}/{{ p.total }}</span>
            </div>
          </div>
          <div class="mv-side-foot">
            <button type="button" class="mv-side-refresh" @click="refresh" :disabled="busy">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
              刷新数据
            </button>
          </div>
        </aside>
        <div class="mv-main">

      <!-- 第 1 页 · 原始内容 -->
      <div v-if="tab === 'origin'" class="card mv-block">
        <div class="mv-block-title">原始内容（歌 + 歌词 + 分镜提示词）</div>
        <div class="mv-row">
          <span class="mv-label">风格</span>
          <BaseSelect v-model="editStyle" :options="styleOptions" placeholder="选一个画风" searchable @update:model-value="saveStyle" />
          <span v-if="styleDesc" class="field-hint">{{ styleDesc }}</span>
          <span class="mv-label">画幅</span>
          <BaseSelect v-model="editRatio" :options="RATIOS" placeholder="画幅" @update:model-value="saveRatio" />
          <span class="field-hint">人物板固定 16:9；场景图和成片按这个比例（改了会重建画面，已出的图和已出的片不会自动重做）</span>
          <span class="field-hint">歌：{{ pj.songFile }}（{{ Number(pj.songSeconds || 0).toFixed(1) }}s）</span>
        </div>
        <label class="mv-label">歌词（可选，一行一句，用来把切点落在句界上）</label>
        <textarea v-model="lyrics" class="input textarea" rows="5" placeholder="一行一句，可留空"></textarea>
        <label class="mv-label">分镜提示词（你写的这支 MV 的画面；初步分镜和人物场景都从它来）</label>
        <textarea v-model="storyPrompt" class="input textarea" rows="10"
          placeholder="把这首歌的画面前后写清（开场什么画面、谁在做什么、场景怎么变、结尾怎么收）"></textarea>
        <div class="mv-row mv-row-end">
          <button class="btn btn-sm" @click="saveAll" :disabled="busy">保存</button>
          <button class="btn btn-primary btn-sm" @click="goNext('outline')" :disabled="busy">下一步：初步分镜 →</button>
        </div>
      </div>

      <!-- 第 2 页 · 初步分镜（AI 改写） -->
      <div v-else-if="tab === 'outline'" class="card mv-block">
        <div class="mv-block-title">初步分镜（AI 把原始内容改写成与歌等长的分镜，只写画面）</div>
        <div v-if="!storyPrompt.trim()" class="mv-warn">
          还没有分镜提示词 —— 先去第 1 步「原始内容」写好。
          <button class="btn btn-sm" @click="tab = 'origin'">去第 1 步</button>
        </div>
        <div class="mv-row">
          <button class="btn btn-primary btn-sm" @click="genOutline" :disabled="busy">AI 改写成分镜</button>
          <span class="tag">{{ outline.length }} 段</span>
          <span class="field-hint">不满意可以再点一次重写</span>
        </div>
        <ol class="mv-outline">
          <li v-for="(o, i) in outline" :key="i">
            <span class="meta-item">{{ Number(o.start).toFixed(1) }}–{{ Number(o.end).toFixed(1) }}s</span> {{ o.what }}
          </li>
        </ol>
        <div class="mv-row mv-row-end">
          <button class="btn btn-primary btn-sm" @click="goNext('assets')" :disabled="busy">下一步：资产制作 →</button>
        </div>
      </div>

      <!-- 第 3 页 · 资产制作 -->
      <div v-else-if="tab === 'assets'" class="card mv-block">
        <div class="mv-block-title">资产制作（从分镜提示词提取人物和场景 → 出图 → 生卡）</div>
        <div v-if="!hasStory() || !hasOutline()" class="mv-warn">
          {{ !hasStory() ? '还没有分镜提示词' : '还没有初步分镜' }} —— 先把前面步骤做完。
          <button class="btn btn-sm" @click="tab = !hasStory() ? 'origin' : 'outline'">去第 {{ !hasStory() ? 1 : 2 }} 步</button>
        </div>
        <div class="mv-row">
          <button class="btn btn-primary btn-sm" @click="extract" :disabled="busy">提取人物和场景</button>
          <span class="field-hint">重新提取会覆盖当前人物/场景（图和卡要重出）</span>
        </div>
        <div v-if="!assets.length" class="mv-hint">还没有资产 —— 点上面的「提取人物和场景」。</div>

        <!-- 人物（照短剧素材库：横排卡，图区固定 16:9） -->
        <template v-if="characters.length">
          <div class="mv-group-head"><span class="mv-group-name">人物</span><span class="tag">{{ characters.length }}</span></div>
          <div class="mv-char-grid">
            <article v-for="a in characters" :key="'c' + a.id" class="card mv-char-card" tabindex="0" role="button"
              @click="openEdit(a)" @keydown.enter.prevent="openEdit(a)">
              <button class="mv-del" title="删除" @click.stop="askRemoveAsset(a)">✕</button>
              <div class="mv-char-main">
                <div class="mv-portrait">
                  <img v-if="a.image" :src="staticUrl(a.image)" :alt="a.name" class="previewable-image" @click.stop="openViewer(a)" />
                  <div v-else class="mv-cover-empty">未出图</div>
                  <span class="mv-badge" :class="a.image ? 'is-ready' : ''">{{ a.image ? '形象已生成' : '待生成' }}</span>
                </div>
                <div class="mv-char-head">
                  <div class="mv-name-row">
                    <strong class="mv-name">{{ a.name || '未命名' }}</strong>
                    <span class="tag">人物</span>
                  </div>
                  <div class="mv-summary" :title="a.appearance || a.description || ''">
                    <span class="mv-summary-label">样貌</span>{{ a.appearance || a.description || '（待填写）' }}
                  </div>
                  <div class="mv-summary" :title="a.styling || ''">
                    <span class="mv-summary-label">妆造</span>{{ a.styling || '（待填写）' }}
                  </div>
                  <div class="mv-card-btns">
                    <button class="btn btn-sm" @click.stop="genPrompt(a)" :disabled="promptBusy === a.id">
                      {{ promptBusy === a.id ? '生成中…' : (a.prompt ? '重新生成提示词' : '生成提示词') }}
                    </button>
                    <button class="btn btn-sm" @click.stop="makeImage(a)" :disabled="a.imageStatus === 'processing'">
                      {{ a.imageStatus === 'processing' ? '出图中…' : (a.image ? '重绘' : '出图') }}
                    </button>
                    <button class="btn btn-sm" @click.stop="makeCard(a)" :disabled="!a.image || cardBusy.includes(a.id)">{{ cardBusy.includes(a.id) ? '排队中…' : '生卡' }}</button>
                    <span v-if="a.card" class="tag tag-success">卡已生成</span>
                  </div>
                </div>
              </div>
              <div class="mv-final" :class="{ dim: !a.prompt }" :title="a.prompt || ''">
                <span class="mv-final-label">最终提示词 · 三视图</span>{{ a.prompt || '未生成（先点「生成提示词」）' }}
              </div>
              <p v-if="a.imageStatus && a.imageStatus.startsWith('failed')" class="bad mv-asset-err">出图失败：{{ a.imageStatus.slice(8) }}</p>
            </article>
          </div>
        </template>

        <!-- 场景（照短剧素材库：竖排卡，封面跟随项目画幅） -->
        <template v-if="scenes.length">
          <div class="mv-group-head"><span class="mv-group-name">场景</span><span class="tag">{{ scenes.length }}</span></div>
          <div class="mv-scene-grid">
            <article v-for="a in scenes" :key="'s' + a.id" class="card mv-scene-card" tabindex="0" role="button"
              @click="openEdit(a)" @keydown.enter.prevent="openEdit(a)">
              <button class="mv-del" title="删除" @click.stop="askRemoveAsset(a)">✕</button>
              <div class="mv-cover" :style="{ aspectRatio: coverAspect }">
                <img v-if="a.image" :src="staticUrl(a.image)" :alt="a.name" class="previewable-image" @click.stop="openViewer(a)" />
                <div v-else class="mv-cover-empty">未出图</div>
                <span class="mv-badge" :class="a.image ? 'is-ready' : ''">{{ a.image ? '场景已生成' : '待生成' }}</span>
              </div>
              <div class="mv-asset-body">
                <div class="mv-name-row">
                  <strong class="mv-name">{{ a.name || '未命名' }}</strong>
                  <span class="tag">场景</span>
                </div>
                <div class="mv-summary" :title="a.description || ''">
                  <span class="mv-summary-label">场景</span>{{ a.description || '（待填写）' }}
                </div>
                <div class="mv-card-btns">
                  <button class="btn btn-sm" @click.stop="genPrompt(a)" :disabled="promptBusy === a.id">
                    {{ promptBusy === a.id ? '生成中…' : (a.prompt ? '重新生成提示词' : '生成提示词') }}
                  </button>
                  <button class="btn btn-sm" @click.stop="makeImage(a)" :disabled="a.imageStatus === 'processing'">
                    {{ a.imageStatus === 'processing' ? '出图中…' : (a.image ? '重绘' : '出图') }}
                  </button>
                  <button class="btn btn-sm" @click.stop="makeCard(a)" :disabled="!a.image || cardBusy.includes(a.id)">{{ cardBusy.includes(a.id) ? '排队中…' : '生卡' }}</button>
                  <span v-if="a.card" class="tag tag-success">卡已生成</span>
                </div>
                <div class="mv-final" :class="{ dim: !a.prompt }" :title="a.prompt || ''">
                  <span class="mv-final-label">最终提示词 · 场景图</span>{{ a.prompt || '未生成（先点「生成提示词」）' }}
                </div>
                <p v-if="a.imageStatus && a.imageStatus.startsWith('failed')" class="bad mv-asset-err">出图失败：{{ a.imageStatus.slice(8) }}</p>
              </div>
            </article>
          </div>
        </template>
        <div class="mv-row mv-row-end">
          <button class="btn btn-primary btn-sm" @click="goNext('video')" :disabled="busy">下一步：视频制作 →</button>
        </div>
      </div>
      <!-- 第 5 页 · 合成导出（结构照短剧导出页：上成片列表 / 下镜头素材网格） -->
      <div v-if="tab === 'export'" class="card mv-block">
        <div class="mv-block-title">合成导出</div>

        <!-- 成片列表 -->
        <div class="export-section-head">
          <span class="export-section-title">成片</span>
          <span class="dim" style="font-size:11px">{{ mergeList.length }} 条</span>
          <div class="ml-auto flex gap-1">
            <button v-if="mergeList.length" class="btn btn-sm" @click="enterExport">刷新</button>
          </div>
        </div>
        <div v-if="mergeList.length" class="export-merge-strip">
          <div v-for="m in mergeList" :key="m.id" class="merge-card playable" role="button" tabindex="0"
            @click="exportPreview = { url: m.mergedUrl, title: '成片' }" @keydown.enter.prevent="exportPreview = { url: m.mergedUrl, title: '成片' }">
            <div class="merge-card-thumb">
              <video :src="staticUrl(m.mergedUrl)" :poster="posterOf(m.mergedUrl)" preload="none" muted playsinline tabindex="-1" />
              <span class="merge-card-play"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg></span>
            </div>
            <div class="merge-card-meta">
              <span class="mono">{{ mergeTitle(m) }}</span>
              <a :href="staticUrl(m.mergedUrl)" download class="btn btn-sm" @click.stop>下载</a>
              <button class="btn btn-sm" @click.stop="askDeleteMerge(m)">删除</button>
            </div>
          </div>
        </div>
        <div v-else class="export-merge-empty">还没有成片 —— 勾好下面的镜头，点「拼接」</div>

        <!-- 镜头素材（勾选） -->
        <div class="export-section-head" style="margin-top:18px">
          <span class="export-section-title">镜头素材</span>
          <span class="dim" style="font-size:11px">已生成 {{ shots.filter((x) => x.videoUrl).length }} / {{ shots.length }} · 已选 {{ exportSelected.length }}</span>
          <div class="ml-auto flex gap-1">
            <button class="btn btn-sm" @click="exportSelected = shots.filter((x) => x.videoUrl).map((x) => x.id)">全选已生成</button>
            <button class="btn btn-sm" @click="exportSelected = []">清空</button>
            <button class="btn btn-sm btn-primary" :disabled="busy || !exportSelected.length" @click="askAssemble">拼接 {{ exportSelected.length }} 段</button>
          </div>
        </div>
        <div class="export-grid">
          <div v-for="(x, i) in shots" :key="x.id" class="exp-card" :class="{ selected: exportSelected.includes(x.id), playable: !!x.videoUrl }"
            @click="x.videoUrl && toggleExport(x.id)">
            <div class="exp-thumb">
              <video v-if="x.videoUrl" :src="staticUrl(x.videoUrl)" :poster="posterOf(x.videoUrl)" preload="none" muted playsinline tabindex="-1" />
              <div v-else class="exp-thumb-empty"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></div>
              <span class="exp-thumb-index">#{{ String(i + 1).padStart(2, '0') }}</span>
              <span class="exp-thumb-duration">{{ shotSeconds(x).toFixed(2) }}s</span>
              <span v-if="x.videoUrl" class="exp-play" title="预览" @click.stop="exportPreview = { url: x.videoUrl, title: '分镜 ' + (i + 1) }">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
              </span>
              <span v-if="x.videoUrl" class="exp-check" :class="{ on: exportSelected.includes(x.id) }">
                <svg v-if="exportSelected.includes(x.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
              </span>
            </div>
            <div class="exp-row-line"><span class="truncate" style="flex:1;font-size:11px">{{ outlineTextOf(x) || '—' }}</span><span class="dot" :class="{ ok: !!x.videoUrl }" /></div>
          </div>
          <div v-if="!shots.length" class="video-task-empty">还没有分镜 —— 先去「视频制作」切分</div>
        </div>
      </div>

      <!-- 第 4 页 · 视频制作（照短剧三栏 workbench：左任务列表 / 中编辑区 / 右播放器） -->
      <div v-if="tab === 'video'" class="video-task-workbench has-player" :style="{ '--vleft': '250px', '--vright': '340px' }">
        <section class="video-task-list">
          <div class="video-task-head">
            <div>
              <div class="video-task-title">视频任务列表</div>
              <div class="video-task-meta">共 {{ shots.length }} 段 · 按歌曲段落切分</div>
            </div>
            <div class="video-task-metrics">
              <button type="button" class="video-task-metric is-pending" :class="{ on: videoFilter === 'pending' }" @click="videoFilter = videoFilter === 'pending' ? '' : 'pending'">{{ videoStats.pending }} 生成中</button>
              <button type="button" class="video-task-metric is-done" :class="{ on: videoFilter === 'done' }" @click="videoFilter = videoFilter === 'done' ? '' : 'done'">{{ videoStats.done }} 完成</button>
              <button type="button" class="video-task-metric is-failed" :class="{ on: videoFilter === 'failed' }" @click="videoFilter = videoFilter === 'failed' ? '' : 'failed'">{{ videoStats.failed }} 失败</button>
            </div>
          </div>
          <div class="video-task-table">
            <div v-for="(s, i) in videoRows" :key="s.id" class="video-task-row"
              :class="['is-' + shotState(s), { active: !selectMode && activeShotId === s.id, 'is-selected': selectMode && selectedIds.includes(s.id) }]"
              role="button" tabindex="0" @click="onRowClick(s)" @keydown.enter.prevent="onRowClick(s)">
              <div class="video-task-preview">
                <span v-if="selectMode" class="shot-check" :class="{ on: selectedIds.includes(s.id) }">
                  <svg v-if="selectedIds.includes(s.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
                <video v-if="s.videoUrl" :src="staticUrl(s.videoUrl)" :poster="staticUrl(shotThumb(s))" preload="none" playsinline muted tabindex="-1"></video>
                <img v-else-if="shotThumb(s)" :src="staticUrl(shotThumb(s))" alt="" loading="lazy" @error="$event.target.style.display = 'none'" />
                <div v-else class="video-task-empty"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg></div>
                <span class="video-task-index">#{{ String(i + 1).padStart(2, '0') }}</span>
              </div>
              <div class="video-task-main">
                <div class="video-task-line"><strong class="video-task-name">{{ outlineTextOf(s) || (s.vocalState === 'vocal_active' ? '唱段' : '间奏') }}</strong></div>
                <div class="video-task-meta-line">
                  <span class="video-task-state" :class="'is-' + shotState(s)"><i class="dot" :class="{ ok: shotState(s) === 'done', pending: shotState(s) === 'pending' }" />{{ shotStateLabel(s) }}</span>
                  <span class="video-task-sep">·</span><span>{{ shotSeconds(s).toFixed(3) }}s（{{ s.frames }}帧）</span>
                  <span class="video-task-sep">·</span><span class="truncate">{{ s.shotSize }} · {{ s.vocalState === 'vocal_active' ? '唱' : '非唱' }} · 图{{ boundRefs(s).length }}</span>
                </div>
                <div v-if="s.errorMsg" class="video-task-error" :title="s.errorMsg">{{ s.errorMsg.slice(0, 100) }}</div>
              </div>
              <button class="btn btn-icon btn-sm video-task-action" :title="s.videoUrl ? '重绘' : '生成'" :disabled="s.status === 'processing' || shotPromptBusy === s.id" @click.stop="render(s)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
              </button>
            </div>
            <div v-if="!videoRows.length" class="video-task-empty">{{ shots.length ? '这个筛选下没有段落' : '还没有分镜 —— 先点上方「拆分分镜」（需先人声分离）' }}</div>
          </div>
          <div v-if="selectMode" class="video-task-foot is-batch">
            <button class="shot-quick-btn" @click="selectedIds = videoRows.map(x => x.id)">全选</button>
            <button class="shot-quick-btn" @click="selectedIds = videoRows.filter(x => !x.videoUrl).map(x => x.id)">补缺失</button>
            <button class="shot-quick-btn" @click="selectedIds = []">清空</button>
            <span class="meta-item">已选 {{ selectedIds.length }} 段</span>
            <button class="btn btn-primary btn-sm" @click="renderSelected" :disabled="busy || !selectedIds.length">生成选中（{{ selectedIds.length }}）</button>
          </div>
        </section>

        <div v-if="activeShot" class="video-task-side">
          <div class="video-main-col">
            <div class="video-main-scroll">
              <div class="video-main-grid">
                <section class="video-inspector-section">
                  <span class="video-inspector-label">本段内容（分镜描述）</span>
                  <div class="mv-shot-fields">
                    <div class="mv-shot-field"><span class="k">景别</span><span class="v">{{ activeShot.shotSize || '—' }}</span></div>
                    <div class="mv-shot-field"><span class="k">机位 / 运镜</span><span class="v">{{ shotCamera(activeShot) }}</span></div>
                    <div class="mv-shot-field"><span class="k">人物动作</span><span class="v">{{ shotAction(activeShot) }}</span></div>
                    <div class="mv-shot-field"><span class="k">出场</span><span class="v mv-cast">{{ shotCast(activeShot) }}</span></div>
                  </div>
                  <pre class="mv-outline-pre">{{ outlineTextOf(activeShot) || '（初步分镜里这一段没有文字）' }}</pre>
                  <label class="field" style="margin-top:8px">
                    <span class="field-label">补充说明 <span class="dim">（中文即可，编译时自动转英文追加到提示词末尾；可留空）</span></span>
                    <textarea v-model="activeShot.promptExtra" class="textarea" rows="3"
                      placeholder="例：这一段她手里不要拿东西；背景不要出现其他人" @blur="saveShot(activeShot)" />
                  </label>
                  <div class="mv-inline-tags">
                    <span class="tag" :class="activeShot.vocalState === 'non_vocal' ? '' : 'tag-accent'">{{ activeShot.vocalState === 'non_vocal' ? '间奏 · 无唱' : '唱段' }}</span>
                    <span class="tag">{{ shotSeconds(activeShot).toFixed(3) }}s</span>
                    <span class="tag">{{ activeShot.frames }}帧</span>
                    <span class="tag">{{ activeShot.shotSize }}</span>
                  </div>
                </section>

                <section class="video-inspector-section">
                  <div class="video-inspector-prompt-head">
                    <span class="video-inspector-label">参考素材</span>
                    <span class="tag mono">{{ boundRefs(activeShot).length }}/{{ allRefAssets.length }} 已绑定</span>
                  </div>
                  <div class="storyboard-ref-list is-embedded">
                    <template v-for="g in REF_GROUPS" :key="g.kind">
                      <div v-if="refAssetsOf(g.kind).length" class="storyboard-ref-group">
                        <div class="storyboard-ref-group-label">{{ g.label }}</div>
                        <div v-for="a in refAssetsOf(g.kind)" :key="a.id" class="storyboard-ref-item"
                          :class="{ bound: isBound(activeShot, a.id) }"
                          :title="isBound(activeShot, a.id) ? '点一下取消绑定' : '点一下绑定到这一段'"
                          @click="toggleRef(activeShot, a.id)">
                          <button type="button" class="storyboard-ref-thumb" @click.stop="openViewerUrl(a.url, a.name)">
                            <img :src="staticUrl(a.url)" loading="lazy" />
                          </button>
                          <div class="storyboard-ref-main">
                            <span class="storyboard-ref-name">{{ a.name }}</span>
                            <span class="storyboard-ref-meta">{{ a.kindLabel }}</span>
                            <span class="storyboard-ref-state" :class="{ 'is-ready': isBound(activeShot, a.id) }">{{ isBound(activeShot, a.id) ? '可参考' : '未绑定' }}</span>
                          </div>
                        </div>
                      </div>
                    </template>
                    <div v-if="!allRefAssets.length" class="storyboard-ref-empty">还没有人物/场景图 —— 先去「资产制作」出图</div>
                  </div>
                </section>

              </div>

              <section class="video-inspector-section">
                <div class="video-inspector-prompt-head">
                  <span class="video-inspector-label video-inspector-label-hero">导演分镜稿（镜头编号 / 时间码 / 景别 / 机位）</span>
                  <div class="video-inspector-actions">
                    <button type="button" class="btn btn-sm" @click="genShotPrompt(activeShot)" :disabled="busy || shotPromptBusy === activeShot.id">
                      {{ shotPromptBusy === activeShot.id ? '生成中…' : (activeShot.prompt ? '重新生成' : 'AI 生成') }}
                    </button>
                    <button type="button" class="btn btn-sm" @click="checkShot(activeShot)" :disabled="checkingShot === activeShot.id"
                      title="只读文本检查，不会打断正在生成的视频">
                      {{ checkingShot === activeShot.id ? '体检中…' : '体检' }}
                    </button>
                    <button type="button" class="btn btn-sm" @click="saveShot(activeShot)">保存这条</button>
                  </div>
                </div>
                <MentionTextarea
                  :model-value="activeShot.prompt || ''"
                  :options="mvMentionOptions"
                  :rows="14"
                  input-class="textarea video-inspector-prompt"
                  placeholder="还没有分镜稿 —— 点上面的「AI 生成」，或顶部「批量补齐提示词」；生成后可在这里手改（输入 @ 可引用人物 / 场景）"
                  @commit="(v) => { activeShot.prompt = v; saveShot(activeShot) }" />
                <div class="video-inspector-prompt-extra">
                  <button v-if="activeShot.promptEn" type="button" class="btn btn-sm video-inspector-prompt-en-toggle"
                    @click="showEn = !showEn">{{ showEn ? '收起英文提示词' : '显示英文提示词（发给 H3 的就是它）' }}</button>
                  <span v-else-if="activeShot.prompt" class="dim video-inspector-prompt-en-miss">英文稿缺失（旧数据）—— 点「重新生成」会补上中英两份</span>
                  <pre v-if="showEn && activeShot.promptEn" class="video-inspector-prompt-en">{{ activeShot.promptEn }}</pre>
                </div>
              </section>
            </div>
          </div>

          <aside class="video-task-player">
           <div class="video-player-scroll">
            <div class="video-player-head">
              <div class="video-player-head-info">
                <div class="video-player-title">预览 分镜{{ String(activeShot.shotNumber).padStart(2, '0') }}</div>
                <span class="video-task-status" :class="'is-' + shotState(activeShot)">
                  <span class="dot" :class="{ ok: shotState(activeShot) === 'done', pending: shotState(activeShot) === 'pending' }" />{{ shotStateLabel(activeShot) }}
                </span>
                <span class="video-player-sub">{{ shotSeconds(activeShot).toFixed(3) }}s · {{ activeShot.frames }}帧</span>
              </div>
              <button v-if="historyPick" class="btn btn-sm btn-primary" @click="setAsCurrent">设为当前</button>
              <a v-if="activeShot.videoUrl" class="btn btn-sm" :href="staticUrl(activeShot.videoUrl)" download>下载</a>
            </div>
            <div class="video-player-stage">
              <video v-if="historyPick" :key="'h' + activeShot.id + historyPick" :src="staticUrl(historyPick)" controls></video>
              <video v-else-if="activeShot.videoUrl" :key="'c' + activeShot.id + activeShot.videoUrl" :src="staticUrl(activeShot.videoUrl)" controls></video>
              <div v-else class="video-task-empty">{{ activeShot.status === 'processing' ? '生成中…' : '还没生成' }}</div>
            </div>
            <div v-if="shotVideoList(activeShot).length" class="video-history">
              <div class="video-inspector-prompt-head">
                <span class="video-inspector-label">历史视频</span>
                <span class="dim" style="font-size:11px">共 {{ shotVideoList(activeShot).length }} 条 · 点缩略图切换</span>
              </div>
              <div class="video-history-strip">
                <div v-for="t in shotVideoList(activeShot)" :key="t.id" class="video-history-card" role="button" tabindex="0"
                  :class="{ on: t.cur ? !historyPick : historyPick === t.url }"
                  @click="historyPick = t.cur ? '' : t.url" @keydown.enter.prevent="historyPick = t.cur ? '' : t.url">
                  <video :src="staticUrl(t.url)" preload="metadata" muted playsinline tabindex="-1"></video>
                  <span class="video-history-time">{{ formatHistoryTime(t.createdAt) }}</span>
                  <span v-if="t.cur" class="video-history-current">当前</span>
                  <button v-else type="button" class="video-history-del" title="删除这一版" @click.stop="removeHistory(activeShot, t.url)">×</button>
                </div>
              </div>
            </div>
            <div class="video-ref-block">
              <div class="video-inspector-prompt-head">
                <span class="video-inspector-label">绑定参考图</span>
                <span class="tag mono">{{ boundRefs(activeShot).length }}</span>
              </div>
              <div class="video-ref-strip">
                <button v-for="a in boundRefs(activeShot)" :key="'rb' + a.id" type="button" class="video-ref-card"
                  :title="a.name" @click="openViewerUrl(a.url, a.name)">
                  <img :src="staticUrl(a.url)" alt="" loading="lazy" />
                  <span class="truncate">{{ a.name }}</span>
                </button>
                <span v-if="!boundRefs(activeShot).length" class="dim" style="font-size:11px">没绑定参考图</span>
              </div>
            </div>
           </div>
            <div class="video-player-foot">
              <div class="video-foot-row">
                <span class="video-foot-label">分镜时长</span>
                <input class="input mv-num" type="number" min="2" max="15" step="0.1"
                  :value="shotSeconds(activeShot).toFixed(3)" @change="setShotDuration(activeShot, $event.target.value)"
                  :disabled="activeShot.status === 'processing'" title="改完自动吸附到合法帧数（17n+5 帧）并保存" />
                <span class="dim" style="font-size:11px">s · 修改即保存</span>
              </div>
              <div class="video-foot-model mono">minimax-h3-mv · {{ pj.aspectRatio || '16:9' }} · {{ shotSeconds(activeShot).toFixed(2) }}s</div>
              <button class="btn btn-primary show-all" @click="render(activeShot)" :disabled="activeShot.status === 'processing' || shotPromptBusy === activeShot.id">
                {{ activeShot.status === 'processing' ? '生成中…' : (activeShot.videoUrl ? '重绘' : '生成') }}
              </button>
            </div>
          </aside>
        </div>
      </div>
        </div>
      </div>

    <!-- 全部弹层都 Teleport 到 body：.page 有 animation(fill both) 会残留 transform，
         会让 position:fixed 变成相对 .page 定位 → 大图被裁小、被编辑弹窗挡住 -->
    <Teleport to="body">
    <!-- 任务抽屉：照短剧右侧抽屉，只看这个 MV 项目的生成任务 -->
    <div v-if="taskDrawer" class="mv-drawer-overlay" @click.self="taskDrawer = false">
      <aside class="mv-drawer" role="dialog" aria-modal="true" aria-label="任务">
        <header class="mv-drawer-head">
          <div>
            <div class="video-task-title">任务</div>
            <div class="video-task-meta">本项目的 {{ taskRows.length }} 条生成记录</div>
          </div>
          <div class="mv-drawer-head-actions">
            <button class="btn btn-sm" @click="refresh">刷新</button>
            <button class="btn btn-ghost btn-sm" @click="taskDrawer = false">关闭</button>
          </div>
        </header>
        <div class="video-task-metrics mv-drawer-metrics">
          <span class="video-task-metric is-pending">{{ videoStats.pending }} 生成中</span>
          <span class="video-task-metric is-done">{{ videoStats.done }} 完成</span>
          <span class="video-task-metric is-failed">{{ videoStats.failed }} 失败</span>
        </div>
        <div class="video-task-table">
          <div v-for="r in taskRows" :key="r.id" class="video-task-row" :class="'is-' + r.state" @click="taskDrawer = false; tab = 'video'; activeShotId = r.id">
            <div class="video-task-preview">
              <video v-if="r.videoUrl" :src="staticUrl(r.videoUrl)" :poster="staticUrl(shotThumb(r))" muted preload="metadata"></video>
              <div v-else class="video-task-empty"><span>{{ r.kind }}</span></div>
              <span class="video-task-index">#{{ String(r.shotNumber).padStart(2, '0') }}</span>
            </div>
            <div class="video-task-main">
              <div class="video-task-line"><strong class="video-task-name">{{ r.title }}</strong></div>
              <div class="video-task-meta-line">
                <span class="video-task-state" :class="'is-' + r.state"><i class="dot" :class="{ ok: r.state === 'done', pending: r.state === 'pending' }" />{{ r.label }}</span>
                <span class="video-task-sep">·</span><span>{{ r.duration }}</span>
                <template v-if="r.elapsed"><span class="video-task-sep">·</span><span :class="{ 'is-running': r.state === 'pending' }">{{ r.elapsed }}</span></template>
              </div>
              <div v-if="r.errorMsg" class="video-task-error" :title="r.errorMsg">{{ r.errorMsg.slice(0, 90) }}</div>
            </div>
          </div>
          <div v-if="!taskRows.length" class="video-task-empty">还没有生成记录</div>
        </div>
      </aside>
    </div>
    <!-- 通用确认弹窗（危险/耗时操作先确认） -->
    <div v-if="confirmDlg" class="mv-modal" @click.self="confirmDlg = null">
      <div class="card mv-modal-box mv-modal-sm">
        <h3>{{ confirmDlg.title }}</h3>
        <p class="mv-desc">{{ confirmDlg.body }}</p>
        <div class="mv-modal-actions">
          <button class="btn btn-sm" @click="confirmDlg = null">取消</button>
          <button class="btn btn-sm btn-primary" @click="runConfirm">{{ confirmDlg.okText || '确定' }}</button>
        </div>
      </div>
    </div>

    <!-- 图片放大（照短剧素材库：点图弹大图，点空白关掉） -->
    <div v-if="viewer.open" class="mv-modal mv-viewer-overlay" @click.self="viewer.open = false">
      <div class="card mv-viewer">
        <div class="mv-viewer-head">
          <span class="mv-viewer-title">{{ viewer.title }}</span>
          <button class="btn btn-ghost btn-sm" @click="viewer.open = false">关闭</button>
        </div>
        <img :src="viewer.src" :alt="viewer.title" class="mv-viewer-img" />
      </div>
    </div>

    <!-- 体检结果（照短剧：弹窗给结果，点某条跳到该段） -->
    <div v-if="checkDlg" class="mv-modal mv-viewer-overlay" @click.self="checkDlg = null">
      <div class="card mv-viewer mv-check-dlg">
        <div class="mv-viewer-head">
          <span class="mv-viewer-title">{{ checkDlg.title }}</span>
          <span class="tag" :class="checkDlg.bad ? 'tag-warn' : 'tag-success'">
            {{ checkDlg.bad ? checkDlg.bad + ' 条有问题' : '全部通过' }}
          </span>
          <button class="btn btn-ghost btn-sm ml-auto" @click="checkDlg = null">关闭</button>
        </div>
        <div class="mv-check-body">
          <div v-for="r in checkDlg.rows" :key="r.shotNumber" class="mv-check-line" :class="{ bad: !r.ok }"
            :role="r.ok ? undefined : 'button'" @click="!r.ok && gotoShot(r.shotNumber)">
            <span class="mv-check-no">#{{ String(r.shotNumber).padStart(2, '0') }}</span>
            <span class="mv-check-state" :class="r.ok ? 'ok' : 'bad'">{{ r.ok ? '通过' : '有问题' }}</span>
            <span v-if="!r.ok" class="mv-check-msgs">{{ (r.problems || []).join('；') }}</span>
            <span v-if="!r.ok" class="dim" style="font-size:11px">点一下跳到这一段</span>
          </div>
          <div v-if="!checkDlg.rows.length" class="mv-check-ok">没有分镜。</div>
        </div>
      </div>
    </div>

    <!-- 导出预览（照短剧：点卡片弹大播放器） -->
    <div v-if="exportPreview" class="mv-modal mv-viewer-overlay" @click.self="exportPreview = null">
      <div class="card mv-viewer">
        <div class="mv-viewer-head">
          <span class="mv-viewer-title">{{ exportPreview.title }}</span>
          <button class="btn btn-ghost btn-sm" @click="exportPreview = null">关闭</button>
        </div>
        <video class="mv-viewer-img" :src="staticUrl(exportPreview.url)" controls autoplay style="max-height:76vh;width:100%;background:#000" />
      </div>
    </div>

    <!-- 编辑资产（与短剧素材详情弹窗同款：顶部标题栏 + 左侧预览 + 右侧编辑 + 底部最终提示词 + 操作栏） -->
    <Teleport to="body">
      <div v-if="editAsset" class="mv-modal mv-detail-overlay" @click.self="editAsset = null">
        <section class="card mv-detail-dialog">
          <header class="mv-detail-head">
            <div class="mv-detail-title-block">
              <span class="mv-detail-kicker">{{ editAsset.kind === 'character' ? '人物' : '场景' }}</span>
              <h2 class="mv-detail-title">{{ editAsset.name || '未命名' }}</h2>
            </div>
            <div class="mv-detail-head-actions">
              <span :class="['mv-detail-state', editAsset.image ? 'is-ready' : '']">{{ editAsset.image ? '已生成' : '待生成' }}</span>
              <button class="btn btn-ghost btn-sm" @click="editAsset = null">关闭</button>
            </div>
          </header>

          <div class="mv-detail-body">
            <div class="mv-detail-shell">
              <!-- 左侧：视觉预览（固定 16:9 横屏，点开看大图） -->
              <aside class="mv-detail-preview-panel">
                <div class="mv-detail-section-title">
                  <span>视觉预览</span>
                  <span :class="['mv-detail-state', editAsset.image ? 'is-ready' : '']">{{ editAsset.image ? '已生成' : '待生成' }}</span>
                </div>
                <button type="button" class="mv-detail-media-frame" :disabled="!editAsset.image" @click.stop="openViewer(editAsset)">
                  <img v-if="editAsset.image" :src="staticUrl(editAsset.image)" :alt="editAsset.name" />
                  <span v-else class="mv-detail-media-empty">{{ editAsset.kind === 'character' ? '未出形象图' : '未出场景图' }}</span>
                </button>
                <div class="mv-detail-meta-row">
                  <div class="mv-detail-meta-item">
                    <span>类型</span>
                    <strong>{{ editAsset.kind === 'character' ? '人物形象（16:9 三视图）' : '场景图（跟随项目画幅）' }}</strong>
                  </div>
                  <div class="mv-detail-meta-item">
                    <span>生卡</span>
                    <strong>{{ editAsset.card || '未生成' }}</strong>
                  </div>
                </div>
              </aside>

              <!-- 右侧：编辑信息 -->
              <section class="mv-detail-editor-panel">
                <div class="mv-detail-section-title">
                  <span>编辑信息</span>
                  <span class="dim">改完点下面「保存修改」</span>
                </div>

                <div class="mv-detail-edit-grid" :class="editAsset.kind === 'character' ? 'is-character' : 'is-scene'">
                  <label class="mv-detail-edit-field">
                    <span>名字</span>
                    <input v-model="editAsset.name" class="input" placeholder="名字" />
                  </label>
                  <template v-if="editAsset.kind === 'character'">
                    <label class="mv-detail-edit-field">
                      <span>样貌</span>
                      <textarea v-model="editAsset.appearance" class="textarea mv-detail-textarea" rows="5" placeholder="脸 / 身形；颜色写唯一值，别写「或」"></textarea>
                    </label>
                    <label class="mv-detail-edit-field">
                      <span>妆造</span>
                      <textarea v-model="editAsset.styling" class="textarea mv-detail-textarea" rows="5" placeholder="服装 / 配饰（颜色 + 款式）"></textarea>
                    </label>
                  </template>
                  <label class="mv-detail-edit-field">
                    <span>{{ editAsset.kind === 'character' ? '描述（提取原文，可留空）' : '场景描述' }}</span>
                    <textarea v-model="editAsset.description" class="textarea mv-detail-textarea" rows="5"
                      :placeholder="editAsset.kind === 'character' ? '提取时写下的那段描述' : '地点 / 时间 / 光线 / 色调 / 氛围'"></textarea>
                  </label>
                </div>

                <!-- 最终提示词面板 -->
                <div class="mv-detail-prompt-panel">
                  <div class="mv-detail-section-title">
                    <span>{{ editAsset.kind === 'character' ? '最终提示词 · 三视图' : '最终提示词 · 场景图' }}</span>
                    <button class="btn btn-sm mv-detail-prompt-gen" @click="genPrompt(editAsset)" :disabled="promptBusy === editAsset.id">
                      {{ promptBusy === editAsset.id ? '生成中…' : (editAsset.prompt ? '重新生成' : '生成提示词') }}
                    </button>
                  </div>
                  <textarea v-model="editAsset.prompt" class="mv-detail-prompt-text" rows="6" placeholder="还没生成 —— 先点右上角「生成提示词」"></textarea>
                </div>
              </section>
            </div>
          </div>

          <footer class="mv-detail-foot">
            <div class="mv-detail-actions">
              <button class="btn btn-sm" @click="editAsset = null">取消</button>
              <button class="btn btn-primary btn-sm" @click="saveAssetFull">保存修改</button>
            </div>
          </footer>
        </section>
      </div>
    </Teleport>

    <!-- 改名弹窗 -->
    <div v-if="showRename" class="mv-modal" @click.self="showRename = false">
      <div class="card mv-modal-box mv-modal-sm">
        <h3>改名称</h3>
        <input v-model.trim="renameTitle" class="input" placeholder="名称" @keyup.enter="doRename" />
        <div class="mv-modal-actions">
          <button class="btn btn-sm" @click="showRename = false">取消</button>
          <button class="btn btn-primary btn-sm" @click="doRename" :disabled="busy || !renameTitle">保存</button>
        </div>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api, stylePresetAPI, aiConfigAPI } from '~/composables/useApi'

const current = ref(null)
const shots = ref([])
const assets = ref([])
const presets = ref([])
const busy = ref(false)
const stepMsg = ref('')
const showRename = ref(false)
const renameTitle = ref('')
const editAsset = ref(null)
const cardBusy = ref([])
/* 2026-10-19 三级结构：本页只做「单个 MV 的制作流程」（第三级）。
   项目列表 = views/mv/index.vue 一级、项目详情 = views/mv/detail.vue 二级 —— 本页不再管那两层。 */
const route = useRoute()
const projectId = Number(route.params.id)
const curSeriesId = ref(null)     // 这首 MV 挂在哪个 MV 项目下（建资产/回退用）

const promptBusy = ref(null)
const viewer = ref({ open: false, src: '', title: '' })
const editRatio = ref('16:9')
// 顶部三个模型选择器 —— 照短剧 ModelSelect 的口径：选项来自该类全部启用配置，选中值是可选的 'provider/model'
const textConfigs = ref([])
const imageConfigs = ref([])
const videoConfigs = ref([])
async function loadConfigs() {
  const [t, i, v] = await Promise.all([
    aiConfigAPI.list('text').catch(() => []),
    aiConfigAPI.list('image').catch(() => []),
    aiConfigAPI.list('video').catch(() => []),
  ])
  textConfigs.value = t || []; imageConfigs.value = i || []; videoConfigs.value = v || []
}
function configModels(cfg) {
  const raw = cfg?.model
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter(Boolean)
  try { const m = JSON.parse(raw); return Array.isArray(m) ? m.filter(Boolean) : [m].filter(Boolean) } catch { return [raw].filter(Boolean) }
}
function collectModelOptions(cfgs) {
  const seen = new Set(); const out = []
  for (const c of [...cfgs].filter((x) => x.is_active).sort((a, b) => (b.priority || 0) - (a.priority || 0))) {
    for (const m of configModels(c)) {
      const key = `${c.provider}/${m}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, model: m, provider: c.provider, configId: c.id, configName: c.name || c.provider })
    }
  }
  return out
}
const hasMultiConfigs = (options) => new Set(options.map((o) => o.configId)).size > 1
const textModelOptions = computed(() => collectModelOptions(textConfigs.value))
const imageModelOptions = computed(() => collectModelOptions(imageConfigs.value))
const videoModelOptions = computed(() => collectModelOptions(videoConfigs.value))
// 选中值 ↔ 项目里锁的 config_id 互转
const keyOfConfig = (options, id) => options.find((o) => o.configId === id)?.key || ''
const configOfKey = (options, key) => (key ? options.find((o) => o.key === key)?.configId || null : null)
const mvTextModel = computed({
  get: () => keyOfConfig(textModelOptions.value, pj.value.textConfigId),
  set: (v) => saveChannel('text_config_id', configOfKey(textModelOptions.value, v)),
})
const mvImageModel = computed({
  get: () => keyOfConfig(imageModelOptions.value, pj.value.imageConfigId),
  set: (v) => saveChannel('image_config_id', configOfKey(imageModelOptions.value, v)),
})
const mvVideoModel = computed({
  get: () => keyOfConfig(videoModelOptions.value, pj.value.videoConfigId),
  set: (v) => saveChannel('video_config_id', configOfKey(videoModelOptions.value, v)),
})
async function saveChannel(field, configId) {
  const r = await call(() => api.put(`/mv/projects/${pj.value.id}`, { [field]: configId ?? null }))
  if (r) current.value = { ...current.value, project: r.project }
}
const tab = ref('origin')
const nowTick = ref(0)
if (typeof window !== 'undefined') setInterval(() => { nowTick.value++ }, 2000)   // 任务运行时间实时刷新
const exportSelected = ref([])
const exportPreview = ref(null)
const historyPick = ref('')   // 预览区切到某条历史视频（空 = 看当前这条）

// 把历史里选中的那一版设为当前（照短剧 setAsMainVideo：改分镜自己的 video_url）
async function setAsCurrent() {
  const s = activeShot.value
  const url = historyPick.value
  if (!s || !url) return
  await call(() => api.put(`/mv/projects/${pj.value.id}/shots/${s.id}`, { video_url: url }), '正在设为当前…')
  s.videoUrl = url
  historyPick.value = ''
  await refresh()
}
// 本段的历史视频 = 本项目里 storyboard_id 等于这段的所有 video 任务（照短剧）
const videoTasks = ref([])
const shotVideoList = (x) => videoTasks.value
  .filter((t) => Number(t.shotId) === Number(x?.id) && t.url)
  .map((t) => ({ id: t.id, url: t.url, createdAt: t.createdAt, cur: t.url === x?.videoUrl }))
const shotHistoryOld = (x) => shotVideoList(x).filter((t) => !t.cur).map((t) => t.url)

// —— 本段内容（分镜描述）：景别 / 机位运镜 / 动作 / 出场（照短剧 @引用展示形式）
// 视频提示词 @ 引用候选（照短剧 MentionTextarea）：本项目的参考素材，人物在前场景在后
const mvMentionOptions = computed(() => {
  const picked = (assets.value || []).filter((a) => a.image)
  const order = { character: 0, scene: 1 }
  return [...picked]
    .sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))
    .map((a) => ({
      label: a.name || (a.kind === 'character' ? '人物' : '场景'),
      value: a.name || '',
      kind: a.kind === 'character' ? 'character' : 'scene',
      group: a.kind === 'character' ? '人物' : '场景',
      image: a.image ? staticUrl(a.image) : undefined,
    }))
    .filter((o) => o.value)
})

const shotBeats = (s2) => {
  if (!s2) return []
  try { const v = JSON.parse(String(s2.beats || '[]')); return Array.isArray(v) ? v : [] } catch { return [] }
}
const shotCamera = (s2) => {
  const b = shotBeats(s2)
  const cams = [...new Set(b.map((x) => String(x.camera || '').trim()).filter(Boolean))]
  return cams.length ? cams.join(' → ') : '固定机位'
}
const shotAction = (s2) => {
  const b = shotBeats(s2)
  const acts = [...new Set(b.map((x) => String(x.action_zh || '').trim()).filter(Boolean))]
  return acts.length ? acts.join(' → ') : (s2?.vocalState === 'non_vocal' ? '安静呼吸，肩放松（间奏）' : '对着镜头唱，随节拍轻摆')
}
// 出场参考素材：用 @名字 展示（和短剧提示词里的 @引用同一种读法）
const shotCast = (s2) => {
  const picked = boundRefs(s2).map((a) => a.name).filter(Boolean)
  return picked.length ? picked.map((n) => '@' + n).join('、') : '未绑定参考素材'
}

// 照抄短剧 episode.vue 的 formatHistoryTime：MM-DD HH:MM
function formatHistoryTime(iso) {
  if (!iso) return ''
  const d = new Date(String(iso).replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function enterExport() {
  tab.value = 'export'
  // 默认勾上所有已生成的分段（照短剧导出页）
  exportSelected.value = shots.value.filter((x) => x.videoUrl).map((x) => x.id)
}
function posterOf(rel) {
  if (!rel) return undefined
  return staticUrl(String(rel).replace(/\.[^./]+$/, '_poster.jpg'))
}
function fmtDur(sec) {
  const t = Math.max(0, Math.round(Number(sec) || 0))
  if (t < 60) return t + 's'
  const m = Math.floor(t / 60)
  return `${m}m${String(t % 60).padStart(2, '0')}s`
}
// 任务行运行时间：生成中按提交时刻实时算，完成后用后端记录的用时（照短剧）
function elapsedLabel(s) {
  if (s.status === 'processing') {
    const t0 = Date.parse(String(s.updatedAt || ''))
    const sec = Number.isFinite(t0) ? (Date.now() - t0) / 1000 : 0
    return sec > 1 ? '运行 ' + fmtDur(sec) : '生成中'
  }
  if (s.elapsedSeconds) return '用时 ' + fmtDur(s.elapsedSeconds)
  return ''
}
function snapFramesFor(sec) {
  const n = Math.max(1, Math.round((Number(sec) * 24 - 5) / 17))
  return 17 * n + 5
}
async function setShotDuration(s, sec) {
  const f = snapFramesFor(sec)
  if (f / 24 > 15.001) { alert('最长 15 秒（345 帧）'); return }
  s.frames = f
  await saveShot(s)
}
async function removeHistory(s, url) {
  askConfirm('删除这一版历史视频', '只删这一版（当前版本和所有分段都不动）。继续？', '删除', async () => {
    await call(() => api.del(`/mv/projects/${pj.value.id}/shots/${s.id}/video?url=${encodeURIComponent(url)}`), '正在删除…')
    if (historyPick.value === url) historyPick.value = ''
    await refresh()
  })
}
function gotoShot(no) {
  const t = shots.value.find((x) => Number(x.shotNumber) === Number(no))
  if (!t) return
  checkDlg.value = null
  tab.value = 'video'
  activeShotId.value = t.id
}
function toggleExport(id) {
  exportSelected.value = exportSelected.value.includes(id)
    ? exportSelected.value.filter((x) => x !== id)
    : [...exportSelected.value, id]
}
const maxSeconds = ref(10)
const storyPrompt = ref('')
const lyrics = ref('')
const editStyle = ref('')

/** 画幅（与短剧同一个思路：只有 H3 支持的两种；动态图/封面按它显示） */
const RATIOS = [
  { label: '9:16 竖屏（手机/抖音）', value: '9:16' },
  { label: '16:9 横屏', value: '16:9' },
]
const coverAspect = computed(() => String(pj.value.aspectRatio || '16:9').replace(':', ' / '))

const pj = computed(() => current.value?.project || {})
const characters = computed(() => assets.value.filter((a) => a.kind === 'character'))
const scenes = computed(() => assets.value.filter((a) => a.kind === 'scene'))
// 「视频制作」页（照短剧）：选中段、统计、绑定参考图、行缩略
const activeShotId = ref(null)
const activeShot = computed(() => shots.value.find((s) => s.id === activeShotId.value) || shots.value[0] || null)
// ⚠️ 必须写在 activeShotId 声明之后：Vue 的 watch 注册时会立刻跑一次取值函数，
// 顺序反了就 `Cannot access 'activeShotId' before initialization`（整个页面 500）
watch(() => activeShotId.value, () => { historyPick.value = '' })   // 换段时回到当前版本
const videoStats = computed(() => ({
  pending: shots.value.filter((s) => s.status === 'processing').length,
  done: shots.value.filter((s) => s.videoUrl).length,
  failed: shots.value.filter((s) => s.status === 'failed').length,
}))
const allRefAssets = computed(() => assets.value.filter((a) => a.image)
  .map((a) => ({ id: a.id, url: a.image, name: a.name, kind: a.kind, kindLabel: a.kind === 'character' ? '人物卡' : '场景卡' })))
// 这一段绑了哪些图：存 refIds（JSON 数组）；没绑过 = 默认「人物卡 + 场景卡」
const defaultRefIds = () => [characters.value.find((a) => a.image)?.id, scenes.value.find((a) => a.image)?.id].filter(Boolean)
function shotRefIdList(s) {
  let ids = []
  try { const v = JSON.parse(String(s?.refIds || '[]')); if (Array.isArray(v)) ids = v.map(Number).filter(Boolean) } catch { ids = [] }
  return ids.length ? ids : defaultRefIds()
}
const REF_GROUPS = [{ kind: 'character', label: '角色' }, { kind: 'scene', label: '场景' }, { kind: 'prop', label: '道具' }]
const refAssetsOf = (kind) => allRefAssets.value.filter((a) => a.kind === kind)
const boundRefs = (s) => allRefAssets.value.filter((a) => shotRefIdList(s).includes(a.id))
const isBound = (s, id) => shotRefIdList(s).includes(id)
async function toggleRef(s, id) {
  if (!s) return
  const cur = shotRefIdList(s).slice()
  const i = cur.indexOf(id)
  if (i >= 0) cur.splice(i, 1); else cur.push(id)
  s.refIds = JSON.stringify(cur)
  await saveShot(s)
}
// H3 时长只由帧数决定（24fps，帧数恒为 17n+5）：秒 = 帧/24；老数据 seconds 与帧不符时以帧为准
const shotSeconds = (s) => Number(s?.frames) ? Number(s.frames) / 24 : Number(s?.seconds || 0)
// 缩略图 = 已生成视频的首帧（_poster.jpg）；没生成视频就是空的
const shotThumb = (s) => (s.videoUrl ? String(s.videoUrl).replace(/\.[^./]+$/, '_poster.jpg') : null)
// 列表筛选 / 状态（照短剧：done / pending / failed / ready）
const videoFilter = ref('')
const shotState = (s) => s.status === 'processing' ? 'pending' : (s.videoUrl ? 'done' : (s.status === 'failed' ? 'failed' : 'ready'))
const shotStateLabel = (s) => ({ pending: '生成中', done: '已完成', failed: '失败', ready: '待生成' })[shotState(s)]
const videoRows = computed(() => {
  if (!videoFilter.value) return shots.value
  if (videoFilter.value === 'done') return shots.value.filter((s) => !!s.videoUrl)
  if (videoFilter.value === 'pending') return shots.value.filter((s) => s.status === 'processing')
  return shots.value.filter((s) => s.status === 'failed')
})
const openViewerUrl = (src, title) => { viewer.value = { open: true, src: staticUrl(src), title } }
// 任务抽屉（照短剧）：只列本项目各段的生成记录
const taskDrawer = ref(false)
const confirmDlg = ref(null)
function askConfirm(title, body, okText, action) { confirmDlg.value = { title, body, okText, action } }

// 拼接 + 删成片（这两个函数之前被我一次误删，4.0.161 补回）
async function assemble() {
  const picked = exportSelected.value
  if (!need(picked.length, '先在「合成导出」页勾选要拼接的镜头')) return
  const r = await call(() => api.post(`/mv/projects/${pj.value.id}/assemble`, { shot_ids: picked }), '正在拼接并混入原曲…')
  if (r) { await refresh(); exportSelected.value = shots.value.filter((x) => x.videoUrl).map((x) => x.id) }
}
const askAssemble = () => askConfirm('开始拼接',
  `会把勾选的 ${exportSelected.value.length} 段按顺序拼接、并混入原曲（从头对齐）。继续？`, '开始拼接', assemble)
const mergeList = ref([])
// 一条成片显示：N 段已并 · 时长 · 拼的时间（照短剧成片卡片）
const mergeTitle = (m) => {
  let n = 0
  try { n = (JSON.parse(m.shotIds || '[]') || []).length } catch { n = 0 }
  return `${n || '?'} 段已并 · ${Math.round(Number(m.seconds) || 0)}s`
}
const askDeleteMerge = (m) => askConfirm('删除成片',
  '会删掉这条成片文件（各段视频都保留，可以随时重新拼接）。继续？', '删除',
  async () => {
    await call(() => api.del(`/mv/projects/${pj.value.id}/merges/${m.id}`), '正在删除成片…')
    mergeList.value = mergeList.value.filter((x) => x.id !== m.id)
    await refresh()
  })
function runConfirm() {
  const fn = confirmDlg.value?.action
  confirmDlg.value = null
  if (typeof fn === 'function') fn()
}
const askGenPrompts = () => {
  // 勾了段就只补勾选的（多选时不再全库扫）
  const picked = selectedIds.value.length ? shots.value.filter((x) => selectedIds.value.includes(x.id)) : []
  if (picked.length) {
    const miss = picked.filter((x) => !String(x.promptEn || '').trim()).length
    return askConfirm('批量补齐提示词',
      `只给勾选的 ${picked.length} 段补齐（其中 ${miss} 段还没有提示词；已有提示词的不动）。继续？`, '开始补齐',
      async () => {
        const r = await call(() => api.post(`/mv/projects/${pj.value.id}/prompts`, { missing_only: true, shot_ids: picked.map((x) => x.id) }), '正在补齐提示词…')
        if (r) { await refresh(); selectedIds.value = [] }
      })
  }
  const miss = shots.value.filter((x) => !String(x.promptEn || '').trim()).length
  const have = shots.value.length - miss
  if (!miss) { alert(`每一段都已有提示词（${have} 段），没有需要补齐的。\n要重写某一段，请点那一段的「重新生成」。`); return }
  askConfirm('批量补齐提示词',
    `只给还没有提示词的 ${miss} 段生成（已有 ${have} 段不动）。继续？`, '开始补齐',
    async () => {
      const r = await call(() => api.post(`/mv/projects/${pj.value.id}/prompts`, { missing_only: true }), '正在补齐提示词…')
      if (r) await refresh()
    })
}

const checking = ref(false)
const shotPromptBusy = ref(null)
const showEn = ref(false)
const checkingShot = ref(null)
const checkDlg = ref(null)   // 体检结果弹窗
async function genShotPrompt(s) {
  if (!s) return
  showEn.value = false
  if (!need(!!pj.value.vocalStem, '先做人声分离')) return
  shotPromptBusy.value = s.id

  try {
    const r = await call(() => api.post(`/mv/projects/${pj.value.id}/shots/${s.id}/prompt`, {}), '正在生成这一段的提示词…')
    if (r) {
      // 后端同时返回中英两份 —— 原来只取了中文，导致「显示英文提示词」按钮不出现
      s.prompt = r.prompt
      s.promptEn = r.promptEn || s.promptEn || ''
      await refresh()          // 从库里同步一次，中英两份都到位
      showEn.value = false
    }
  } finally { shotPromptBusy.value = null }
}
async function checkShot(s) {
  if (!s) return
  if (!s.prompt && !s.promptEn) { alert('这一段还没有分镜稿'); return }
  askConfirm(`体检 · 分镜${String(s.shotNumber).padStart(2, '0')}`,
    '会检查这一段的结构（六段式是否齐、顺序、危险词、唱段嘴部约束）。不改数据。继续？', '开始体检',
    async () => {
      checkingShot.value = s.id
      try {
        const r = await api.post(`/mv/projects/${pj.value.id}/shots/${s.id}/check`, {})
          .catch((e) => { alert('体检失败：' + String(e?.message || e)); return null })
        if (r) checkDlg.value = {
          title: `体检 · 分镜 ${String(r.shotNumber).padStart(2, '0')}`,
          ok: r.ok ? 1 : 0, bad: r.ok ? 0 : 1,
          rows: [{ shotNumber: r.shotNumber, ok: !!r.ok, problems: r.problems || [] }],
        }
      } finally { checkingShot.value = null }
    })
}
async function doCheckAll() {
  checking.value = true
  try {
    const r = await call(() => api.post(`/mv/projects/${pj.value.id}/check`, {}), '正在体检全部分镜…')
      .catch((e) => { alert('体检失败：' + String(e?.message || e)); return null })
    if (r) checkDlg.value = { title: '全部体检结果', ok: r.ok || 0, bad: r.bad || 0, rows: r.rows || [] }
  } finally { checking.value = false }
}
const askCheckAll = () => askConfirm('全部体检',
  `会把 ${shots.value.length} 段逐条检查结构，返回问题清单（不改数据）。继续？`, '开始体检', doCheckAll)
const separating = ref(false)
async function separateVocals() {
  if (!current.value) return
  separating.value = true
  try {
    const r = await call(() => api.post(`/mv/projects/${pj.value.id}/separate`, {}),
      '正在分离人声（首次会下载模型，约 1~3 分钟）…')
    if (r) {
      current.value = { ...current.value, project: { ...pj.value, vocalStem: r.vocalStem } }
      await refresh()
      alert(r.cached
        ? '人声已分离过，直接复用（现有分镜未改动）'
        : `人声分离完成，用时 ${Number(r.seconds || 0).toFixed(1)} 秒` + (r.cleared ? `；已清空旧分镜 ${r.cleared} 段，请点「拆分分镜」重切` : ''))
    }
  } finally { separating.value = false }
}
async function runCheck() {
  if (!need(shots.value.length, '还没有分镜')) return
  checking.value = true
  try {
    const r = await call(() => api.post(`/mv/projects/${pj.value.id}/check`, {}), '正在体检全部提示词…')
    if (r) checkDlg.value = { title: '全部体检结果', ok: r.ok || 0, bad: r.bad || 0, rows: r.rows || [] }
  } finally { checking.value = false }
}
// 批量选择（照短剧 videoSelectMode）
const selectMode = ref(false)
// 三段进度（拆分 / 提示词 / 出片）——照短剧左栏 sidebar-progress 的分段形式
const progressSteps = computed(() => {
  const total = shots.value.length
  const donePrompt = shots.value.filter((x) => String(x.promptEn || '').trim()).length
  const doneVideo = shots.value.filter((x) => x.videoUrl).length
  const mk = (key, label, done, t) => ({ key, label, done, total: t, pct: t ? Math.round((done / t) * 100) : 0 })
  return [
    mk('split', '拆分', total ? 1 : 0, 1),
    mk('prompt', '提示词', donePrompt, total),
    mk('video', '出片', doneVideo, total),
  ]
})
const progressVideo = computed(() => shots.value.filter((x) => x.videoUrl).length)

const selectedIds = ref([])
function toggleSelectMode() {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selectedIds.value = []
}
function onRowClick(s) {
  if (selectMode.value) {
    const i = selectedIds.value.indexOf(s.id)
    if (i >= 0) selectedIds.value.splice(i, 1); else selectedIds.value.push(s.id)
  } else {
    activeShotId.value = s.id
  }
}
async function renderSelected() {
  const list = shots.value.filter((s) => selectedIds.value.includes(s.id))
  if (!need(list.length, '先勾选要生成的段')) return
  const missing = list.filter((s) => !s.prompt)
  if (missing.length) { alert(`有 ${missing.length} 段还没提示词，先编译提示词`); return }
  for (const s of list) {
    if (s.status === 'processing') continue
    await render(s)
    await new Promise((r) => setTimeout(r, 1200))
  }
}
const VOCAL_OPTS = [{ label: '唱', value: 'vocal_active' }, { label: '非唱', value: 'non_vocal' }]
const SIZE_OPTS = [{ label: '中远景', value: '中远景' }, { label: '中景', value: '中景' }, { label: '近景', value: '近景' }, { label: '特写', value: '特写' }]
const taskRows = computed(() => {
  void nowTick.value   // 依赖心跳 → 运行中的时间每 2 秒重算
  return shots.value
    .filter((s) => s.status === 'processing' || s.videoUrl || s.status === 'failed' || s.taskId)
    .map((s) => ({
      id: s.id, shotNumber: s.shotNumber, kind: '视频',
      title: outlineTextOf(s) || (s.vocalState === 'vocal_active' ? '唱段' : '间奏'),
      state: shotState(s), label: shotStateLabel(s),
      duration: shotSeconds(s) ? shotSeconds(s).toFixed(3) + 's' : '—',
      videoUrl: s.videoUrl, errorMsg: s.errorMsg,
      elapsed: elapsedLabel(s),
    }))
})
const recentDone = computed(() => shots.value
  .filter((x) => x.videoUrl || x.status === 'failed')
  .slice()
  .sort((a, b) => (Date.parse(String(b.updatedAt || '')) || 0) - (Date.parse(String(a.updatedAt || '')) || 0))
  .slice(0, 4)
  .map((x) => ({
    id: x.id, n: x.shotNumber, ok: !!x.videoUrl,
    label: `分镜 #${x.shotNumber}`,
    dur: x.elapsedSeconds ? fmtDur(x.elapsedSeconds) : '',
    error: x.status === 'failed' ? (x.errorMsg || '失败') : '',
  })))
const activeTaskCount = computed(() => videoStats.value.pending + videoStats.value.failed)
const outlineTextOf = (s) => {
  const list = outline.value
  if (!list.length) return ''
  const hit = list.find((o) => Number(o.start) <= Number(s.startSeconds) && Number(o.end) >= Number(s.endSeconds))
  return hit?.what || list[Math.min((Number(s.shotNumber) || 1) - 1, list.length - 1)]?.what || ''
}
const outline = computed(() => {
  try { return JSON.parse(pj.value.outline || '[]') } catch { return [] }
})
const styleOptions = computed(() => presets.value.map((p) => ({ label: p.name, value: p.value })))
const styleDesc = computed(() => presets.value.find((p) => p.value === editStyle.value)?.description || '')

let timer = null

const ZH = { draft: '未开始', planned: '有粗分镜', shots: '有分镜', rendering: '出片中', done: '已完成', pending: '待生成', processing: '生成中', completed: '已完成', failed: '失败' }
function statusZh(s) { return ZH[s] || s || '' }
// 幂等：资产图存的是 'mv/p1/x.png'（不带前缀），视频/成片存的是 'static/videos/x.mp4'（带前缀）
// 之前一律加 /static/ → 视频变成 /static/static/… 404（播放器空、下载下不动）
function staticUrl(rel) {
  if (!rel) return ''
  return String(rel).startsWith('static/') ? `/${rel}` : `/static/${rel}`
}
function styleLabel(key) { return presets.value.find((p) => p.value === key)?.name || key || '' }

/** 前一步没做就别往下走：拦下来并告诉他去哪一步 */
function need(ok, msg) {
  if (ok) return true
  alert(msg)
  return false
}
const hasStory = () => !!storyPrompt.value.trim()
const hasOutline = () => outline.value.length > 0
const hasCharImage = () => characters.value.some((a) => a.image)

/** 全链路门禁：第 2 步要原始内容，第 3 步要初步分镜，第 4 步要人物图 */
function guardStep(n) {
  if (n >= 2 && !hasStory()) return need(false, '先去第 1 步「原始内容」写好分镜提示词')
  if (n >= 3 && !hasOutline()) return need(false, '先去第 2 步「初步分镜」点「AI 改写成分镜」')
  if (n >= 4 && !hasCharImage()) return need(false, '先去第 3 步「资产制作」提取人物并出图')
  return true
}

function goNext(to) {
  const step = to === 'outline' ? 2 : to === 'assets' ? 3 : 4
  if (!guardStep(step)) return
  tab.value = to
}

async function call(fn, msg) {
  busy.value = true
  stepMsg.value = msg || ''
  try {
    return await fn()
  } catch (err) {
    alert(String(err?.message || err))
    return null
  } finally {
    busy.value = false
    stepMsg.value = ''
  }
}


async function loadPresets() {
  const r = await stylePresetAPI.list().catch(() => null)
  presets.value = r || []
}





/** 加载当前这首 MV（id 来自路由 /mv/:id）；顺带记下它挂在哪个项目下 */
async function openProject(id) {
  const r = await call(() => api.get(`/mv/projects/${id}`))
  if (!r) return
  current.value = r
  sync(r)
  curSeriesId.value = Number(r.project?.seriesId) || null
  syncTimer()
}

function sync(r) {
  shots.value = r.shots || []
  videoTasks.value = r.videoTasks || []
  mergeList.value = r.merges || []
  assets.value = r.assets || []
  storyPrompt.value = r.project.storyPrompt || ''
  lyrics.value = r.project.lyrics || ''
  editStyle.value = r.project.style || ''
  editRatio.value = r.project.aspectRatio || '16:9'
  maxSeconds.value = Number(r.project.maxShotSeconds || 10)
}

/** 返回上一级：项目详情（照短剧 单集 → 项目详情） */
function back() {
  if (curSeriesId.value) navigateTo(`/mv/series/${curSeriesId.value}`)
  else navigateTo('/mv')
}

async function refresh() {
  const r = await call(() => api.get(`/mv/projects/${pj.value.id}`))
  if (r) { current.value = r; sync(r) }
}

function openRename() {
  renameTitle.value = pj.value.title || ''
  showRename.value = true
}

async function doRename() {
  const r = await call(() => api.put(`/mv/projects/${pj.value.id}`, { title: renameTitle.value }))
  if (!r) return
  showRename.value = false
  current.value = { ...current.value, project: r.project }
}

async function saveAll() {
  const r = await call(() => api.put(`/mv/projects/${pj.value.id}`, {
    story_prompt: storyPrompt.value, lyrics: lyrics.value,
  }))
  if (r) {
    current.value = { ...current.value, project: r.project }
    stepMsg.value = '已保存'
    setTimeout(() => { if (stepMsg.value === '已保存') stepMsg.value = '' }, 1200)
  }
}

async function saveStyle(v) {
  const r = await call(() => api.put(`/mv/projects/${pj.value.id}`, { style: v }))
  if (r) current.value = { ...current.value, project: r.project }
}

async function saveRatio(v) {
  const r = await call(() => api.put(`/mv/projects/${pj.value.id}`, { aspect_ratio: v }))
  if (r) current.value = { ...current.value, project: r.project }
}

/** 点图看大图（照短剧素材库：点一下弹大图） */
function openViewer(a) {
  if (!a.image) return
  viewer.value = { open: true, src: staticUrl(a.image), title: `${a.kind === 'character' ? '人物' : '场景'} · ${a.name || ''}` }
}

/** 点卡片 → 编辑弹窗（名字 / 样貌 / 妆造 / 描述 / 最终提示词），与短剧一样在弹窗里改 */
function openEdit(a) {
  editAsset.value = { ...a }
}

async function saveAssetFull() {
  const a = editAsset.value
  if (!a) return
  try {
    const r = await api.put(`/mv/projects/${pj.value.id}/assets/${a.id}`, {
      name: a.name, description: a.description,
      appearance: a.appearance, styling: a.styling, prompt: a.prompt,
    })
    if (r) assets.value = r.assets || []
    // 保存后不关弹窗（用户要接着生提示词/出图）；只把后端那份的图/卡/提示词同步回来
    const fresh = (r?.assets || []).find((x) => x.id === a.id)
    if (fresh) Object.assign(a, { image: fresh.image, imageStatus: fresh.imageStatus, card: fresh.card, prompt: fresh.prompt ?? a.prompt })
  } catch (err) {
    alert(String(err?.message || err))
  }
}

/** 生成提示词：把资产描述写成一段能直接出图的提示词（在这之前不许出图） */
async function genPrompt(a) {
  if (!need(!!String(a.description || a.appearance || a.styling || '').trim(), '这个资产还没有描述 —— 先写清外貌/场景，再生成提示词')) return
  if (promptBusy.value === a.id) return
  promptBusy.value = a.id
  try {
    const r = await api.post(`/mv/projects/${pj.value.id}/assets/${a.id}/prompt`, {
      name: a.name, description: a.description, appearance: a.appearance, styling: a.styling,
    })
    if (r) assets.value = r.assets || []
    if (r && editAsset.value && editAsset.value.id === a.id) {
      const fresh = (r.assets || []).find((x) => x.id === a.id)
      if (fresh) editAsset.value = { ...fresh }
    }
  } catch (err) {
    alert(String(err?.message || err))
  } finally {
    promptBusy.value = null
  }
}

async function extract() {
  if (!guardStep(3)) return
  const r = await call(() => api.post(`/mv/projects/${pj.value.id}/extract`, { story_prompt: storyPrompt.value }),
    'LLM 正在提取人物和场景…')
  if (r) {
    assets.value = r.assets || []
    await refresh()
  }
}

// 删人物/场景卡之前先弹窗确认（误点一次就没了）
function askRemoveAsset(a) {
  const kind = a.kind === 'character' ? '人物' : '场景'
  askConfirm(`删除${kind}卡`,
    `确定删除「${a.name || '未命名'}」？已生成的图、已抽的身份卡和它上面的提示词都会一起删掉，这一步不能撤销。`,
    '确定删除', () => removeAsset(a))
}

async function removeAsset(a) {
  const r = await call(() => api.delete(`/mv/projects/${pj.value.id}/assets/${a.id}`), '正在删除…')
  if (r) assets.value = r.assets || []
  if (editAsset.value && editAsset.value.id === a.id) editAsset.value = null
}

/** 出图：提交后立刻返回，真出图在后台按项目排队（一张在跑，别的卡照样能点） */
async function makeImage(a) {
  if (!need(!!a.prompt, '先点「生成提示词」，再出图')) return
  try {
    const r = await api.post(`/mv/projects/${pj.value.id}/assets/${a.id}/image`, {
      name: a.name, description: a.description, prompt: a.prompt,
    })
    if (r) assets.value = r.assets || []
    syncTimer()
  } catch (err) {
    alert(String(err?.message || err))
  }
}

/** 生卡：单张几秒，只锁这一张的按钮 */
async function makeCard(a) {
  if (!need(!!a.image, '先给这个资产「出图」，再生卡')) return
  if (cardBusy.value.includes(a.id)) return
  cardBusy.value = [...cardBusy.value, a.id]
  try {
    const r = await api.post(`/mv/projects/${pj.value.id}/assets/${a.id}/card`, {})
    // 各自只更新自己那一张，避免并发响应乱序把别人的「卡已生成」冲掉
    const mine = (r?.assets || []).find((x) => x.id === a.id)
    if (mine) Object.assign(a, mine)
  } catch (err) {
    alert(`「${a.name || '这张卡'}」生卡失败：` + String(err?.message || err))
  } finally {
    cardBusy.value = cardBusy.value.filter((x) => x !== a.id)
  }
}

async function genOutline() {
  if (!guardStep(2)) return
  const r = await call(() => api.post(`/mv/projects/${pj.value.id}/plan`, {}), 'LLM 正在写初步分镜…')
  if (r) await refresh()
}

async function genShots() {
  if (!need(!!pj.value.vocalStem, '先点顶栏「人声分离」—— 分镜的唱/非唱要用人声轨判断，没分离就切会全标成唱')) return
  if (!guardStep(4)) return
  const n = shots.value.length
  askConfirm(n ? '重新拆分分镜' : '拆分分镜',
    n
      ? `会按人声轨重新切分，重建全部 ${n} 段：现有的分镜内容、提示词、生成记录都会被清掉（已生成的视频文件还留在磁盘上，但不再挂在这些分镜上）。继续？`
      : `会按人声轨把这首歌唱/非唱切开，每段最长 ${maxSeconds.value} 秒，并吸附到合法帧数（17n+5）。继续？`,
    n ? '重新拆分' : '开始拆分',
    async () => {
      const r = await call(() => api.post(`/mv/projects/${pj.value.id}/shots`, { max_seconds: maxSeconds.value }), '正在按歌切段…')
      if (r) await refresh()
    })
}

async function genPrompts() {
  if (!guardStep(4)) return
  if (!need(shots.value.length, '先点「切分详细分镜」，再来编译提示词')) return
  const r = await call(() => api.post(`/mv/projects/${pj.value.id}/prompts`, {}), '正在编译六段式提示词…')
  if (r) await refresh()
}

async function saveShot(s) {
  await api.put(`/mv/projects/${pj.value.id}/shots/${s.id}`, {
    shot_size: s.shotSize, camera: s.camera, lyric: s.lyric, vocal_state: s.vocalState,
    ...(s.refIds !== undefined ? { ref_ids: JSON.parse(String(s.refIds || '[]')) } : {}),
    ...(s.promptExtra !== undefined ? { prompt_extra: s.promptExtra || '' } : {}),
  }).catch((err) => alert(String(err?.message || err)))
}

async function render(s) {
  if (!need(!!s.prompt, `第 ${s.shotNumber} 段还没有提示词 —— 先点「编译提示词」`)) return
  const r = await call(() => api.post(`/mv/projects/${pj.value.id}/shots/${s.id}/render`, {}))
  if (r) { s.status = 'processing'; syncTimer() }
}

async function renderAll() {
  if (!need(shots.value.length, '先在「视频制作」页点「切分详细分镜」')) return
  for (const s of shots.value) {
    if (s.videoUrl) continue
    if (!s.prompt) { alert(`第 ${s.shotNumber} 段还没提示词 —— 先点「编译提示词」`); return }
    await render(s)
    await new Promise((res) => setTimeout(res, 1200))
  }
}


async function pollOnce() {
  if (!current.value || busy.value) return
  const r = await api.get(`/mv/projects/${pj.value.id}`).catch(() => null)
  if (!r) return
  current.value = r
  shots.value = r.shots || []
  videoTasks.value = r.videoTasks || []
  mergeList.value = r.merges || []
  // 资产只同步「出图状态 / 图 / 卡」，别把正在编辑的名字和描述冲掉
  for (const na of r.assets || []) {
    const cur = assets.value.find((x) => x.id === na.id)
    if (cur) { cur.image = na.image; cur.imageStatus = na.imageStatus; cur.card = na.card }
    else assets.value.push(na)
  }
  // 编辑弹窗开着时也要跟着换新图
  if (editAsset.value) {
    const f = (r.assets || []).find((x) => x.id === editAsset.value.id)
    if (f) { editAsset.value.image = f.image; editAsset.value.imageStatus = f.imageStatus; editAsset.value.card = f.card }
  }
  syncTimer()
}

function syncTimer() {
  const needPoll = shots.value.some((s) => s.status === 'processing')
    || assets.value.some((a) => a.imageStatus === 'processing')
  if (needPoll && !timer) timer = setInterval(pollOnce, 6000)
  if (!needPoll && timer) { clearInterval(timer); timer = null }
}

onMounted(async () => {
  await loadPresets()
  await loadConfigs()
  await openProject(projectId)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
/* 页壳照抄短剧页（app/views/drama/detail.vue） */
.page {
  padding: 20px 28px 40px;
  height: 100%;
  overflow: hidden;               /* 照短剧：页面本身不滚，滚动交给内部区块 */
  display: flex; flex-direction: column;
  animation: fadeUp 0.35s var(--ease-out) both;
}
.page-head { flex-shrink: 0; }
.page-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-radius: var(--radius-lg);
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.head-info { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.title-edit-btn { flex: 0 0 auto; color: var(--text-3); }
.title-edit-btn:hover { color: var(--accent); background: var(--accent-bg); }
.back-btn {
  width: 30px; height: 30px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%;
  background: var(--overlay-track); color: var(--text-1);
  cursor: pointer;
  transition: background 0.16s var(--ease-out), color 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out);
}
.back-btn:hover { background: var(--bg-active); color: var(--text-0); }
.back-btn:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }
.page-title {
  font-size: 17px; font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.page-meta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.meta-item { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-2); }

/* 左侧流程导航 + 右侧内容（照短剧 episode/detail 的左导航布局） */
.mv-layout { flex: 1; min-height: 0; display: flex; gap: 16px; align-items: stretch; }
.mv-side {
  width: 210px; flex-shrink: 0;
  display: flex; flex-direction: column; gap: 4px;
  padding: 10px;
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface-raised);
  /* 照短剧 .sidebar：整列撑满视口，列表区自己滚，底部按钮 flex 贴底 → 永远在屏幕左下角 */
  min-height: 0; overflow: hidden;
}
.mv-side-title {
  font-size: 11px; font-weight: 650; letter-spacing: 0.06em;
  color: var(--text-3); padding: 6px 10px 4px;
}
.mv-side-item {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 8px 10px; font-size: 13px; font-weight: 550; cursor: pointer;
  border: none; border-radius: var(--radius); background: transparent; color: var(--text-1);
  transition: all 0.16s var(--ease-out);
}
.mv-side-item:hover { background: var(--bg-hover); color: var(--text-0); }
.mv-side-item.active { background: var(--accent-bg); color: var(--accent-text); font-weight: 650; }
.mv-side-item:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }
.mv-side-icon { width: 26px; text-align: center; font-size: 15px; }
.mv-side-label { flex: 1; min-width: 0; }
.mv-side-count {
  font-size: 10px; font-weight: 700; font-family: var(--font-mono);
  background: var(--bg-active); color: var(--text-2);
  padding: 1px 6px; border-radius: 99px;
}
.mv-side-item.active .mv-side-count { background: var(--accent-bg); color: var(--accent-text); }
.mv-main { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }

/* 顶部标签栏（照短剧：模型选择器一排） */
.head-actions { flex-wrap: wrap; margin-left: auto; justify-content: flex-end; }
.mv-step-hint { font-size: 10.5px; font-weight: 800; color: var(--text-3); align-self: center; }
.btn.is-on { border-color: var(--accent); color: var(--accent-text, var(--accent)); background: rgba(120,140,255,.14); }
.mv-top-selects { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex-shrink: 0; }
.mv-sel {
  display: inline-flex; align-items: center; gap: 6px;
  height: 30px; padding: 0 4px 0 9px;
  border: 1px solid var(--border); border-radius: 999px;
  font-size: 11.5px; color: var(--text-1); background: var(--bg-2);
}
.mv-sel-k { color: var(--text-3); flex-shrink: 0; }
.mv-sel-v { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-sel :deep(.base-select) { min-width: 150px; max-width: 220px; }
.mv-sel :deep(.base-select-trigger) { border: none; background: transparent; height: 24px; font-size: 11.5px; padding: 0 2px; }

/* 项目列表（照短剧「项目启动台」） */
.mv-launch-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.mv-search { width: 260px; height: 32px; }
.mv-filters { display: flex; align-items: center; gap: 6px; }
.mv-filter {
  padding: 4px 12px; font-size: 12.5px; font-weight: 600; cursor: pointer;
  border: 1px solid var(--border); border-radius: 999px;
  background: transparent; color: var(--text-2);
  transition: all 0.15s var(--ease-out);
}
.mv-filter:hover { color: var(--text-0); border-color: var(--border-strong); }
.mv-filter.on { background: var(--accent-bg); border-color: var(--accent); color: var(--accent-text); }

.mv-project-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.mv-project-card { position: relative; overflow: hidden; cursor: pointer; display: flex; flex-direction: column; }
.mv-project-card:hover { border-color: var(--border-strong); }
.mv-project-card:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3.5px var(--button-focus); }

.mv-card-cover {
  position: relative; aspect-ratio: 2.1 / 1;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-2);
}
.mv-card-cover.has-image { background: #16181d; }
.mv-card-cover-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: 50% 42%; }
.mv-card-cover-shade {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(180deg, rgba(0,0,0,0.34) 0%, rgba(0,0,0,0) 38%, rgba(0,0,0,0.5) 100%);
}
.mv-card-initial { position: relative; font-size: 34px; font-weight: 600; color: #fff; text-shadow: 0 2px 14px rgba(0,0,0,0.35); user-select: none; }
.mv-card-ratio {
  position: absolute; right: 10px; bottom: 8px;
  padding: 2px 7px; border-radius: 5px; font-size: 10px; font-weight: 700;
  background: var(--surface-raised); color: var(--text-2); border: 1px solid var(--border);
}
.mv-card-badge {
  position: absolute; left: 8px; bottom: 8px;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; font-size: 11px; font-weight: 650;
  border: 1px solid var(--border); border-radius: 999px;
  background: var(--surface-raised); color: var(--text-1);
}
.mv-status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); }
.mv-status-dot.is-rendering { background: var(--warning, #d9a441); }
.mv-status-dot.is-done { background: var(--success, #46b872); }
.mv-status-dot.is-shots { background: var(--accent); }
.mv-card-cover.has-image .mv-card-badge {
  background: rgba(18,18,22,0.62); border-color: rgba(255,255,255,0.22); color: #fff; backdrop-filter: blur(4px);
}
.mv-card-cover.has-image .mv-card-ratio { background: rgba(18,18,22,0.6); border-color: rgba(255,255,255,0.2); color: #fff; }
.mv-card-cover.has-image .mv-card-more { background: rgba(18,18,22,0.55); border-color: rgba(255,255,255,0.2); color: #fff; }
.mv-card-more {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
  border: 1px solid var(--border); background: var(--surface-raised); color: var(--text-1);
  display: flex; align-items: center; justify-content: center; font-size: 15px; line-height: 1;
}
.mv-card-menu {
  position: absolute; top: 38px; right: 8px; z-index: 5;
  min-width: 140px; padding: 5px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface-raised); box-shadow: var(--shadow-lift, 0 8px 24px rgba(0,0,0,.18));
  display: flex; flex-direction: column;
}
.mv-card-menu button {
  text-align: left; padding: 7px 10px; font-size: 12.5px; cursor: pointer;
  border: none; border-radius: 6px; background: transparent; color: var(--text-1);
}
.mv-card-menu button:hover { background: var(--bg-hover); color: var(--text-0); }
.mv-card-menu button.danger { color: var(--action-danger); }
.mv-project-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
.mv-project-name { margin: 0; font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-project-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; }
.mv-project-foot { font-size: 11px; }
.mv-danger-btn { background: var(--action-danger); border-color: var(--action-danger); color: #fff; }

/* 列表 */
.mv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.mv-empty { padding: 28px; text-align: center; color: var(--text-3); }
.mv-item { padding: 14px 16px; cursor: pointer; }
.mv-item:hover { border-color: var(--accent); }
.mv-item-title { font-weight: 700; margin-bottom: 8px; }
.mv-item-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

/* 步骤块 */
.mv-block { padding: 14px 16px; margin-bottom: 14px; }
.card.mv-block + .card.mv-block { margin-top: 14px; }
.mv-block-title { font-weight: 700; font-size: 13px; margin-bottom: 10px; }
.mv-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.mv-row-end { justify-content: flex-end; margin-top: 10px; }
.mv-label { display: block; font-size: 12px; color: var(--text-2); margin: 8px 0 4px; }
.mv-num { width: 88px; }
.mv-hint { font-size: 12px; color: var(--text-3); padding: 6px 0; }
.field-hint { font-size: 11.5px; color: var(--text-3); }
.mv-warn {
  display: flex; align-items: center; gap: 10px;
  font-size: 12.5px; color: var(--warning-text, var(--text-1));
  background: var(--warning-bg, var(--bg-2));
  border-radius: var(--radius);
  padding: 8px 12px; margin-bottom: 10px;
}

/* 资产卡（照短剧素材库：卡片窄、可多张并排；人物竖排 = 图区 16:9 + 信息 + 提示词行） */
.mv-group-head { display: flex; align-items: center; gap: 8px; margin: 12px 0 8px; }
.mv-group-name { font-size: 12.5px; font-weight: 700; }
.mv-char-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 260px)); justify-content: start; gap: 10px; }
.mv-scene-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; align-items: stretch; }
.mv-char-card, .mv-scene-card { position: relative; overflow: hidden; display: flex; flex-direction: column; }
.mv-char-card { cursor: pointer; }
.mv-scene-card { cursor: pointer; }
.mv-char-card:hover, .mv-scene-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-lift, 0 6px 18px rgba(0,0,0,.08)); }
.mv-char-card:focus-visible, .mv-scene-card:focus-visible { outline: none; border-color: var(--accent-glow, var(--accent)); box-shadow: 0 0 0 3px var(--button-focus), var(--shadow-panel, none); }
.mv-char-main { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
.mv-char-head { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
.mv-portrait {
  width: 100%; position: relative; flex-shrink: 0;
  aspect-ratio: 16 / 9;                     /* 人物图区固定 16:9（与出图尺寸 2048x1152 一致） */
  border: 1px solid var(--surface-outline, var(--border)); border-radius: var(--radius);
  background: var(--bg-2); overflow: hidden;
}
.mv-portrait img, .mv-cover img { width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in; }
.mv-cover {
  position: relative; width: 100%;
  border-bottom: 1px solid var(--border); background: var(--bg-2); overflow: hidden;
}
.mv-cover-empty { width: 100%; height: 100%; min-height: 90px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--text-3); }
.mv-badge {
  position: absolute; left: 6px; bottom: 6px;
  font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 99px;
  background: rgba(0, 0, 0, 0.55); color: #fff;
}
.mv-badge.is-ready { background: var(--success-bg, var(--accent-bg)); color: var(--tag-success-text, var(--accent-text)); }
.mv-del {
  position: absolute; top: 8px; right: 8px; z-index: 3;
  width: 22px; height: 22px; border-radius: 50%; border: none;
  background: rgba(0, 0, 0, 0.5); color: #fff; cursor: pointer;
  opacity: 0; transition: opacity 0.15s, background 0.15s;
}
.mv-char-card:hover .mv-del, .mv-scene-card:hover .mv-del { opacity: 1; }
.mv-del:hover { background: var(--action-danger); }
.mv-asset-body { padding: 8px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
.mv-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.mv-name { font-size: 12.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-summary { font-size: 11.5px; line-height: 1.45; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mv-summary-label { color: var(--text-3); margin-right: 4px; }
.mv-card-btns { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; margin-top: auto; }
.mv-final {
  padding: 6px 8px; font-size: 11px; line-height: 1.45;
  border-top: 1px solid var(--border); background: var(--bg-input);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mv-final-label { color: var(--text-3); margin-right: 4px; }

.mv-outline { margin: 6px 0 0; padding-left: 20px; font-size: 12.5px; line-height: 1.8; }
.mv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mv-table th { text-align: left; color: var(--text-3); font-weight: 600; padding: 6px; border-bottom: 1px solid var(--border); }
.mv-table td { padding: 5px 6px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.mv-cell { padding: 3px 8px; font-size: 12px; height: 26px; width: auto; }
.mv-cell-wide { padding: 3px 8px; font-size: 12px; height: 26px; min-width: 160px; }
.mv-actions { display: flex; gap: 6px; }
.ok { color: var(--tag-success-text, var(--accent-text)); }
.bad { color: var(--action-danger); }
.dim { color: var(--text-3); }
.busy-hint { font-size: 12px; color: var(--accent-text); }
.mv-video { width: 100%; max-width: 420px; border-radius: var(--radius-lg); margin-top: 6px; }
.mv-prompt {
  white-space: pre-wrap; font-family: var(--font-mono, monospace);
  font-size: 11.5px; line-height: 1.6;
  background: var(--bg-input); border-radius: var(--radius);
  padding: 10px; max-height: 240px; overflow: auto;
}

.mv-asset-err { font-size: 11.5px; margin: 0 10px 8px; line-height: 1.5; }
/* 看大图 —— 直接用短剧的数值（.viewer-dialog / .viewer-img）：宽 min(960px, 100vw-48px)，图高 76vh */
.mv-modal.mv-viewer-overlay { z-index: 90; padding: 24px; }
.mv-viewer { width: min(960px, calc(100vw - 48px)); padding: 14px; }
.mv-viewer-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.mv-viewer-title { font-size: 13px; font-weight: 600; }
.mv-viewer-img { width: 100%; max-height: 76vh; object-fit: contain; border-radius: var(--radius); background: var(--bg-2); display: block; }

/* 编辑资产弹窗 —— 与短剧素材详情弹窗（.mat-detail-*）同款结构与数值 */
.mv-modal.mv-detail-overlay { z-index: 70; padding: 28px; }
.mv-detail-dialog {
  width: min(1040px, calc(100vw - 56px));
  max-height: calc(100vh - 56px);
  display: flex; flex-direction: column; overflow: hidden;
}
.mv-detail-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 14px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.mv-detail-title-block { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mv-detail-kicker { color: var(--text-3); font-size: 10px; font-weight: 800; letter-spacing: 0.12em; }
.mv-detail-title { margin: 0; color: var(--text-0); font-size: 18px; line-height: 1.2; }
.mv-detail-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.mv-detail-body { min-height: 0; overflow: auto; padding: 16px; }
.mv-detail-shell {
  display: grid;
  grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);   /* 短剧原值 */
  gap: 14px; align-items: start;
}
.mv-detail-preview-panel,
.mv-detail-editor-panel { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.mv-detail-preview-panel { position: sticky; top: 0; }
.mv-detail-section-title {
  min-height: 24px; display: flex; align-items: center;
  justify-content: space-between; gap: 10px;
  color: var(--text-1); font-size: 12px; font-weight: 820; letter-spacing: 0.02em;
}
.mv-detail-section-title .dim { font-size: 11px; font-weight: 560; text-align: right; }
.mv-detail-state {
  min-height: 20px; display: inline-flex; align-items: center;
  padding: 0 7px; border-radius: 999px;
  background: var(--overlay-track); color: var(--text-3);
  font-size: 10px; font-weight: 760; white-space: nowrap;
}
.mv-detail-state.is-ready { color: var(--success); background: var(--success-bg); }
.mv-detail-media-frame {
  position: relative; width: 100%; aspect-ratio: 16 / 9;   /* 预览框固定横屏 16:9（与短剧一致） */
  display: block; padding: 0;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius); background: var(--bg-2);
  color: var(--text-3); overflow: hidden; cursor: zoom-in;
}
.mv-detail-media-frame:disabled { cursor: default; opacity: 1; }
.mv-detail-media-frame img { width: 100%; height: 100%; display: block; object-fit: cover; }
.mv-detail-media-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--text-3); }
.mv-detail-meta-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.mv-detail-meta-item {
  min-width: 0; padding: 9px 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius); background: var(--surface-muted, var(--bg-2));
}
.mv-detail-meta-item span { display: block; color: var(--text-3); font-size: 10px; font-weight: 780; letter-spacing: 0.04em; }
.mv-detail-meta-item strong {
  display: block; margin-top: 4px; min-width: 0;
  color: var(--text-0); font-size: 12px; line-height: 1.35;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mv-detail-edit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.mv-detail-edit-grid.is-character,
.mv-detail-edit-grid.is-scene { grid-template-columns: 1fr; }
.mv-detail-edit-field { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.mv-detail-edit-field > span { color: var(--text-3); font-size: 10px; font-weight: 780; letter-spacing: 0.04em; }
.mv-detail-textarea { min-height: 164px; resize: vertical; }
.mv-detail-prompt-panel { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 16px; }
.mv-detail-prompt-gen { margin-left: auto; flex-shrink: 0; }
.mv-detail-prompt-text {
  width: 100%; margin-top: 10px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface, var(--bg-input)); color: var(--text-0);
  font-size: 12.5px; line-height: 1.6; resize: vertical; min-height: 112px; font-family: inherit;
}
.mv-detail-foot {
  display: flex; align-items: center; justify-content: flex-end;
  gap: 8px; padding: 12px 16px;
  border-top: 1px solid var(--surface-outline);
}
.mv-detail-actions { display: flex; align-items: center; gap: 8px; }

/* 弹窗 */
.mv-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
.mv-modal-box { padding: 18px 20px; width: 560px; max-height: 88vh; overflow: auto; }
.mv-modal-sm { width: 420px; }
.mv-modal-box h3 { margin: 0 0 12px; font-size: 15px; }
.mv-modal-box .mv-label { display: block; margin: 10px 0 4px; }
.mv-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
/* ===== 视频制作：照短剧 .video-task-* 的字号/间距/状态色 ===== */
.video-task-workbench {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(380px, 46%);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-1);
  min-height: 520px;
}
.video-task-list { min-height: 0; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-1); }
.video-task-head { min-height: 48px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.video-task-title { font-size: 13px; line-height: 1.2; font-weight: 850; color: var(--text-0); }
.video-task-meta { margin-top: 3px; font-size: 11px; line-height: 1.35; color: var(--text-3); }
.video-task-metrics { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.video-task-metric, .video-task-status {
  display: inline-flex; align-items: center; gap: 5px; min-height: 22px; padding: 0 8px;
  border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2);
  color: var(--text-2); font-size: 11px; font-weight: 750; white-space: nowrap;
}
.video-task-metric.is-done, .video-task-status.is-done { color: var(--success, #3fb950); border-color: rgba(63,185,80,.35); background: rgba(63,185,80,.12); }
.video-task-metric.is-pending, .video-task-status.is-pending { color: var(--accent-text, var(--accent)); border-color: var(--accent); background: rgba(120,140,255,.12); }
.video-task-metric.is-failed, .video-task-status.is-failed { color: var(--warning, #d29922); border-color: rgba(210,153,34,.35); background: rgba(210,153,34,.12); }
.video-task-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: 8px; }
.shot-quick-btn { background: none; border: 0; padding: 0; color: var(--accent-text, var(--accent)); font-size: 11.5px; font-weight: 700; cursor: pointer; font-family: inherit; }
.shot-quick-btn:hover { text-decoration: underline; }
.video-task-table { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.video-task-row {
  display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; align-items: center; gap: 8px;
  padding: 6px 8px; border-top: 1px solid var(--border); cursor: pointer;
  transition: background .16s, border-color .16s;
}
.video-task-row:first-child { border-top: 0; }
.video-task-row:hover, .video-task-row.is-pending { background: var(--bg-hover, var(--bg-2)); }
.video-task-row.is-failed { background: rgba(248,81,73,.1); }
.video-task-row.active { background: rgba(120,140,255,.12); box-shadow: inset 0 0 0 1.5px var(--accent); }
.video-task-preview { position: relative; width: 56px; aspect-ratio: 16 / 9; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); }
.video-task-preview video, .video-task-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.video-task-empty-thumb { display: flex; align-items: center; justify-content: center; height: 100%; font-size: 10px; color: var(--text-3); }
.video-task-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.video-task-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.video-task-index { font-family: var(--font-mono, monospace); font-size: 10.5px; color: var(--text-3); flex-shrink: 0; }
.video-task-name { font-size: 12px; font-weight: 700; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.video-task-meta-line { font-size: 11px; color: var(--text-3); }
.video-task-sep { margin: 0 3px; }
.video-task-prompt { font-size: 11px; line-height: 1.45; color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.video-task-error { font-size: 11px; color: var(--warning, #d29922); }
.video-task-actions { display: flex; align-items: center; gap: 6px; }
.video-task-empty { padding: 24px 12px; text-align: center; font-size: 12px; color: var(--text-3); }
.video-task-player { display: flex; flex-direction: column; border-bottom: 1px solid var(--border); }
.video-player-head { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 6px 12px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.video-player-head-info { min-width: 0; display: flex; align-items: center; gap: 8px; }
.video-player-title { color: var(--text-0); font-size: 13px; font-weight: 700; white-space: nowrap; }
.video-player-sub { color: var(--text-3); font-size: 11px; white-space: nowrap; }
.video-player-stage { aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; background: #000; }
.video-player-stage video { width: 100%; height: 100%; object-fit: contain; display: block; }
.video-inspector { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.video-inspector-fields { display: grid; grid-template-columns: 88px 88px minmax(0,1fr) minmax(0,1fr); gap: 6px; }
.video-inspector-fields .input { height: 28px; font-size: 11.5px; }
.video-inspector-label { font-size: 10.5px; font-weight: 780; letter-spacing: .04em; color: var(--text-3); text-transform: uppercase; }
.video-ref-row { display: flex; gap: 8px; flex-wrap: wrap; }
.video-ref-row img { width: 78px; aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-1); }
.video-prompt-box { margin: 0; padding: 10px; max-height: 220px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-1); color: var(--text-2); font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }

/* ===== 视频制作：三栏 workbench（照短剧 .video-task-* / .video-main-* / .video-inspector-*） ===== */
.video-task-workbench.has-player { display: grid; grid-template-columns: var(--vleft, 250px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); height: calc(100vh - 232px); min-height: 480px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-1); }
.video-task-workbench { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 560px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-1); }
.video-task-side { min-width: 0; min-height: 0; height: 100%; overflow: hidden; display: grid; grid-template-columns: minmax(280px, 1fr) minmax(300px, var(--vright, 340px)); grid-template-rows: minmax(0, 1fr); border-left: 1px solid var(--border); background: var(--bg-2); }
.video-task-list { min-height: 0; overflow: hidden; display: flex; flex-direction: column; background: var(--bg-1); }
.video-task-title { font-size: 13px; line-height: 1.2; font-weight: 850; color: var(--text-0); }
.video-task-meta { margin-top: 3px; font-size: 11px; color: var(--text-3); }
.video-task-metric, .video-task-status, .video-task-state { display: inline-flex; align-items: center; gap: 5px; min-height: 22px; padding: 0 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2); color: var(--text-2); font-size: 11px; font-weight: 750; white-space: nowrap; }
button.video-task-metric { cursor: pointer; font-family: inherit; }
button.video-task-metric:hover { box-shadow: 0 0 0 2px var(--accent); }
button.video-task-metric.on { box-shadow: 0 0 0 2px var(--accent); color: var(--accent-text, var(--accent)); }
.video-task-metric.is-done, .video-task-status.is-done, .video-task-state.is-done { color: #3fb950; border-color: rgba(63,185,80,.35); background: rgba(63,185,80,.12); }
.video-task-metric.is-pending, .video-task-status.is-pending, .video-task-state.is-pending { color: var(--accent-text, var(--accent)); border-color: var(--accent); background: rgba(120,140,255,.12); }
.video-task-metric.is-failed, .video-task-status.is-failed, .video-task-state.is-failed { color: #d29922; border-color: rgba(210,153,34,.35); background: rgba(210,153,34,.12); }
.video-task-state.is-ready { color: var(--text-3); }
.video-task-state { min-height: 18px; padding: 0; border: 0; background: none; font-weight: 700; font-size: 11px; }
.dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; display: inline-block; opacity: .55; }
.dot.ok { background: #3fb950; opacity: 1; }
.dot.pending { background: var(--accent); opacity: 1; animation: mv-pulse 1.2s infinite; }
@keyframes mv-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
.video-task-table { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; }
.video-task-row { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 6px 8px; border-top: 1px solid var(--border); cursor: pointer; transition: background .16s; }
.video-task-row:first-child { border-top: 0; }
.video-task-row:hover, .video-task-row.is-pending { background: var(--bg-hover, var(--bg-2)); }
.video-task-row.is-failed { background: rgba(248,81,73,.1); }
.video-task-row.active { background: rgba(120,140,255,.12); box-shadow: inset 0 0 0 1.5px var(--accent); }
.video-task-preview { position: relative; width: 56px; aspect-ratio: 16 / 9; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); }
.video-task-preview video, .video-task-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.video-task-preview .video-task-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-3); padding: 0; }
.video-task-index { position: absolute; left: 3px; bottom: 3px; padding: 0 4px; border-radius: 3px; background: rgba(0,0,0,.65); color: #fff; font-family: var(--font-mono, monospace); font-size: 9px; }
.video-task-main { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.video-task-line { display: flex; align-items: center; gap: 6px; min-width: 0; }
.video-task-name { font-size: 12px; font-weight: 700; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.video-task-meta-line { display: flex; align-items: center; gap: 2px; font-size: 11px; color: var(--text-3); min-width: 0; }
.video-task-sep { margin: 0 3px; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.video-task-error { font-size: 11px; color: #d29922; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.video-task-action { flex-shrink: 0; }
.video-task-empty { padding: 20px 12px; text-align: center; font-size: 12px; color: var(--text-3); }
.video-task-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 12px; border-top: 1px solid var(--border); }
.shot-quick-btn { background: none; border: 0; padding: 0; color: var(--accent-text, var(--accent)); font-size: 11px; font-weight: 700; cursor: pointer; font-family: inherit; white-space: nowrap; }
.shot-quick-btn:hover { text-decoration: underline; }
.shot-quick-btn:disabled { opacity: .45; cursor: default; text-decoration: none; }
.video-main-col { min-width: 0; min-height: 0; display: flex; }
.video-main-scroll { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 14px 16px 16px; background: var(--bg-1); }
.video-main-grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 14px; align-items: start; }
.video-inspector-section { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.video-inspector-label { font-size: 10.5px; font-weight: 780; letter-spacing: .04em; color: var(--text-3); text-transform: uppercase; }
.video-inspector-label-hero { font-size: 11.5px; color: var(--text-2); }
.video-inspector-prompt-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.video-inspector-actions { display: flex; gap: 6px; }
.video-inspector-prompt { min-height: 260px; font-size: 11.5px; line-height: 1.6; }
.video-inspector-prompt-extra { display: flex; flex-direction: column; gap: 8px; }
.video-inspector-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.video-inspector-fields .is-wide { grid-column: 1 / -1; }
.mv-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.mv-field > span { font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.video-inspector-fields .input { width: 100%; min-width: 0; height: 30px; font-size: 11.5px; }
.mv-outline-pre { margin: 0; padding: 8px 10px; max-height: 120px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); color: var(--text-2); font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; }
.storyboard-ref-list.is-embedded { max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.storyboard-ref-item { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 8px; align-items: center; padding: 6px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.storyboard-ref-item.bound { border-color: var(--accent); }
.storyboard-ref-thumb { width: 56px; aspect-ratio: 16 / 9; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-1); cursor: pointer; }
.storyboard-ref-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.storyboard-ref-main { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.storyboard-ref-name { font-size: 11.5px; font-weight: 700; color: var(--text-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.storyboard-ref-meta { font-size: 10.5px; color: var(--text-3); }
.storyboard-ref-state { font-size: 10.5px; font-weight: 700; color: var(--text-3); }
.storyboard-ref-state.is-ready { color: #3fb950; }
.storyboard-ref-empty { padding: 16px 8px; text-align: center; font-size: 11.5px; color: var(--text-3); }
.video-task-player { min-width: 0; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--bg-1); overflow: hidden; }
.video-player-scroll { flex: 1; min-height: 0; overflow-y: auto; }
.video-player-head { min-height: 44px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.video-player-head-info { min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.video-player-title { color: var(--text-0); font-size: 13px; font-weight: 700; white-space: nowrap; }
.video-player-sub { color: var(--text-3); font-size: 11px; white-space: nowrap; }
.video-player-stage { aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; background: #000; flex: none; }
.video-player-stage video { width: 100%; height: 100%; object-fit: contain; display: block; }
.video-inspector { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }

/* 任务按钮 + 右侧任务抽屉（照短剧 .task-drawer） */
.mv-task-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; margin-left: 5px; padding: 0 4px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 10px; font-weight: 800; line-height: 1; }
.mv-drawer-overlay { position: fixed; inset: 0; z-index: 120; display: flex; justify-content: flex-end; background: rgba(0,0,0,.42); }
.mv-drawer { width: min(420px, calc(100vw - 40px)); height: 100%; display: flex; flex-direction: column; background: var(--bg-1); border-left: 1px solid var(--border); }
.mv-drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 12px 14px; border-bottom: 1px solid var(--border); }
.mv-drawer-head-actions { display: flex; gap: 6px; }
.mv-drawer-metrics { padding: 8px 14px; border-bottom: 1px solid var(--border); }

/* 体检结果面板 */
.mv-check-panel { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; margin-bottom: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.mv-check-panel.is-bad { border-color: rgba(210,153,34,.5); }
.mv-check-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11.5px; color: var(--text-2); }
.mv-check-row { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; font-size: 11px; color: #d29922; }
.mv-check-idx { font-family: var(--font-mono, monospace); color: var(--text-3); }
.mv-check-msg { line-height: 1.5; word-break: break-word; }
.mv-check-ok { font-size: 11.5px; color: #3fb950; }

/* 批量选择（照短剧 .shot-check / .is-selected） */
.shot-check { position: absolute; top: 3px; left: 3px; z-index: 2; width: 14px; height: 14px; display: flex; align-items: center; justify-content: center; border: 1.5px solid rgba(255,255,255,.6); border-radius: 4px; background: rgba(0,0,0,.45); color: #fff; }
.shot-check.on { background: var(--accent); border-color: var(--accent); }
.video-task-row.is-selected { background: rgba(120,140,255,.16); box-shadow: inset 0 0 0 1.5px var(--accent); }
.video-task-foot.is-batch { border-top: 1px solid var(--accent); background: rgba(120,140,255,.08); }

/* 英文提示词折叠区（照短剧 video-inspector-prompt-en） */
.video-inspector-prompt-en-toggle { align-self: flex-start; }
.video-inspector-prompt-en-miss { font-size: 11px; }
.video-inspector-prompt-en { margin: 6px 0 0; padding: 10px; max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); color: var(--text-2); font-family: var(--font-mono, monospace); font-size: 10.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }

/* 本段内容：结构化分镜描述（照短剧 inspector 的 label+值） */
.mv-shot-fields { display: flex; flex-direction: column; gap: 4px; }
.mv-shot-field { display: flex; gap: 8px; font-size: 12px; line-height: 1.5; }
.mv-shot-field .k { flex: 0 0 74px; color: var(--text-2); }
.mv-shot-field .v { flex: 1; color: var(--text-0); }
.mv-cast { color: var(--accent); }

/* 本段内容的行内标签 */
.mv-inline-tags { display: flex; gap: 6px; flex-wrap: wrap; }

/* 左栏三段进度（照短剧 sidebar-progress） */
.mv-side-progress { margin-top: auto; padding-top: 10px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
.mv-side-progress-head { display: flex; align-items: baseline; justify-content: space-between; }
.mv-side-progress-title { font-size: 11px; font-weight: 700; color: var(--text-2); }
.mv-side-progress-count { font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.mv-side-progress-track { display: flex; gap: 3px; }
.mv-side-progress-seg { flex: 1; height: 6px; padding: 0; border: 0; border-radius: 3px; background: var(--bg-2); overflow: hidden; cursor: pointer; }
.mv-side-progress-seg-fill { display: block; height: 100%; width: 0; background: var(--accent); transition: width .3s ease; }
.mv-side-progress-seg.done .mv-side-progress-seg-fill { background: #34c759; }
.mv-side-progress-labels { display: flex; gap: 3px; }
.mv-side-progress-label { flex: 1; font-size: 10px; color: var(--text-2); text-align: center; font-variant-numeric: tabular-nums; }
.mv-side-progress-label.on { color: #34c759; font-weight: 600; }

/* 左侧栏底部「刷新数据」：铺满宽度（照短剧左侧栏底部） */
.mv-side-foot { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.mv-side-refresh { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%;
  padding: 8px 10px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-2); color: var(--text-2);
  transition: all .16s var(--ease-out); }
.mv-side-refresh:hover { background: var(--bg-hover); color: var(--text-0); }
.mv-side-refresh:disabled { opacity: .5; cursor: default; }

/* 合成导出页 */
.mv-export-bar { align-items: center; gap: 10px; flex-wrap: wrap; }
.mv-export-list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.mv-export-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; font-size: 12.5px; cursor: pointer; border-bottom: 1px solid var(--border); }
.mv-export-row:last-child { border-bottom: 0; }
.mv-export-row:hover { background: var(--bg-hover); }
.mv-export-row.is-off { opacity: .5; cursor: default; }
.mv-export-idx { color: var(--text-3); font-family: var(--font-mono, monospace); font-size: 11px; }
.mv-export-title { flex: 1; min-width: 0; color: var(--text-0); }
.mv-export-video { width: 100%; max-height: 62vh; background: #000; border-radius: var(--radius); }

/* 本段实际使用的参考素材 */
.mv-actual-refs { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.mv-actual-ref { width: 54px; height: 34px; padding: 0; border: 1px solid var(--accent); border-radius: 5px; overflow: hidden; cursor: pointer; background: var(--bg-2); }
.mv-actual-ref img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* 历史视频 */
.video-history { padding: 8px 14px 10px; border-top: 1px solid var(--border); }
.video-history-strip { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
.video-history-card { position: relative; flex: 0 0 auto; width: 98px; height: 58px; padding: 0; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; cursor: pointer; background: #000; }
.video-history-card.on { border-color: var(--accent); }
.video-history-time { position: absolute; left: 3px; bottom: 2px; font-size: 9px; line-height: 1; color: #eee; background: rgba(0,0,0,.62); padding: 1px 3px; border-radius: 3px; pointer-events: none; }
.video-history-card video { width: 100%; height: 100%; object-fit: cover; display: block; }
.video-history-idx { position: absolute; left: 3px; bottom: 2px; font-size: 9.5px; color: #fff; text-shadow: 0 1px 3px #000; }
/* 右栏底部固定操作条 */
.video-player-foot { flex: 0 0 auto; padding: 10px 14px; border-top: 1px solid var(--border); background: var(--bg-1); }
.video-player-foot .btn { width: 100%; }

/* 导出页（照短剧导出：成片条 + 素材网格 + 播放弹窗） */
.export-section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.export-section-title { font-size: 13px; font-weight: 700; color: var(--text-0); }
.export-merge-strip { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 4px; }
.merge-card { flex: 0 0 auto; width: 220px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--bg-2); }
.merge-card.playable { cursor: pointer; }
.merge-card-thumb { position: relative; aspect-ratio: 16/9; background: #000; }
.merge-card-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.merge-card-play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; opacity: .85; text-shadow: 0 2px 8px #000; pointer-events: none; }
.merge-card-meta { display: flex; align-items: center; gap: 6px; padding: 6px 8px; font-size: 11px; }
.export-merge-empty { padding: 16px; text-align: center; color: var(--text-3); font-size: 12px; border: 1px dashed var(--border); border-radius: var(--radius); }
.export-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.exp-card { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; background: var(--bg-2); }
.exp-card.playable { cursor: pointer; }
.exp-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.exp-thumb { position: relative; aspect-ratio: 16/9; background: #000; }
.exp-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.exp-thumb-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.exp-thumb-index { position: absolute; left: 5px; top: 4px; font-size: 10px; color: #fff; text-shadow: 0 1px 3px #000; font-family: var(--font-mono, monospace); }
.exp-thumb-duration { position: absolute; right: 5px; bottom: 4px; font-size: 10px; color: #fff; text-shadow: 0 1px 3px #000; }
.exp-play { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); color: #fff; opacity: .8; }
.exp-check { position: absolute; right: 4px; top: 4px; width: 15px; height: 15px; display: flex; align-items: center; justify-content: center; border: 1px solid #fff; border-radius: 50%; color: #fff; background: rgba(0,0,0,.35); }
.exp-check.on { background: var(--accent); border-color: var(--accent); }
.exp-row-line { display: flex; align-items: center; gap: 6px; padding: 5px 7px; }
.exp-row-line .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); flex: 0 0 auto; }
.exp-row-line .dot.ok { background: #4caf50; }

/* 体检结果弹窗 */
.mv-check-dlg { width: min(720px, calc(100vw - 48px)); }
.mv-check-body { display: flex; flex-direction: column; gap: 6px; max-height: 62vh; overflow-y: auto; }
.mv-check-line { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); font-size: 12.5px; }
.mv-check-line.bad { border-color: rgba(210,153,34,.55); cursor: pointer; }
.mv-check-line.bad:hover { background: var(--bg-hover); }
.mv-check-no { font-family: var(--font-mono, monospace); color: var(--text-3); font-size: 11px; }
.mv-check-state.ok { color: #4caf50; font-weight: 650; }
.mv-check-state.bad { color: #e0a83a; font-weight: 650; }
.mv-check-msgs { flex: 1; min-width: 0; color: var(--text-1); }

/* 右栏：绑定参考图 + 底部参数块（照短剧） */
.video-ref-block { padding: 8px 14px 10px; border-top: 1px solid var(--border); }
.video-ref-strip { display: flex; gap: 6px; overflow-x: auto; }
.video-ref-card { flex: 0 0 auto; width: 68px; padding: 0; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2); cursor: pointer; overflow: hidden; }
.video-ref-card img { width: 100%; height: 42px; object-fit: cover; display: block; }
.video-ref-card span { display: block; font-size: 9.5px; padding: 2px 3px; color: var(--text-2); }
.video-history-current { position: absolute; right: 3px; top: 2px; font-size: 9px; font-weight: 700; color: #000; background: var(--accent); border-radius: 3px; padding: 0 3px; }
.video-player-foot .video-foot-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.video-foot-label { font-size: 12px; color: var(--text-2); }
.video-player-foot .mv-num { width: 84px; height: 28px; }
.video-foot-model { font-size: 11px; color: var(--text-3); margin-bottom: 8px; }
.video-player-foot .btn.show-all { width: 100%; }

.video-task-meta-line .is-running { color: var(--accent); font-weight: 600; }

.video-history-card { position: relative; }
.video-history-del { position: absolute; right: 2px; top: 2px; width: 15px; height: 15px; display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 50%; background: rgba(0,0,0,.6); color: #fff; font-size: 12px; line-height: 1; cursor: pointer; padding: 0; }
.video-history-del:hover { background: #d33; }

/* 「最近」那一行（照短剧：视频制作行的第二行） */
.mv-recent-row { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-right: auto; font-size: 11.5px; }
.mv-recent-kicker { color: var(--text-3); font-weight: 700; letter-spacing: .04em; }
.mv-recent-item { cursor: pointer; color: var(--text-2); }
.mv-recent-item.is-ok { color: #4caf50; }
.mv-recent-item.is-bad { color: #e0a83a; }
.mv-recent-item:hover { text-decoration: underline; }

</style>

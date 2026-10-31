<template>
  <div class="page" v-if="series">
    <!-- Header：单行紧凑（照短剧 drama/detail.vue） -->
    <div class="page-head card">
      <button class="back-btn" title="返回项目列表" @click="navigateTo('/mv')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
        </svg>
      </button>
      <div class="head-info">
        <h1 class="page-title">{{ series.title || '未命名 MV 项目' }}</h1>
        <button class="btn btn-icon btn-sm title-edit-btn" type="button" title="改名字" @click="openRename">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <span v-if="series.style" class="tag tag-accent">{{ styleLabel(series.style) }}</span>
        <div class="page-meta">
          <span class="meta-item">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            {{ characters.length }} 人物
          </span>
          <span class="meta-item">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>
            {{ scenes.length }} 场景
          </span>
          <span class="meta-item">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.5"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/><line x1="16" y1="8" x2="16" y2="16"/></svg>
            {{ songs.length }} 个 MV
          </span>
        </div>
      </div>
      <button class="btn btn-primary head-action" @click="openCreate">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        新建 MV
      </button>
    </div>

    <!-- 主 Tab：MV 列表 / 素材库 -->
    <nav class="page-tabs">
      <button type="button" :class="['tab-btn', { on: activeTab === 'songs' }]" @click="activeTab = 'songs'">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.5"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/><line x1="16" y1="8" x2="16" y2="16"/></svg>
        MV 列表
        <span class="tab-count">{{ songs.length }}</span>
      </button>
      <button type="button" :class="['tab-btn', { on: activeTab === 'assets' }]" @click="activeTab = 'assets'">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        素材库
        <span v-if="assets.length" class="tab-count">{{ assets.length }}</span>
      </button>
    </nav>

    <!-- Tab 1：MV 列表（点进单首歌；末尾常驻「新建 MV」卡） -->
    <div v-if="activeTab === 'songs'" class="ep-grid">
      <div
        v-for="(so, i) in songs"
        :key="so.id"
        class="card ep-card"
        :style="{ animationDelay: `${i * 0.05}s` }"
        @click="navigateTo(`/mv/${so.id}`)"
      >
        <div class="ep-card-top">
          <div class="ep-number">
            <span class="ep-num-label">MV</span>
            <b>{{ String(i + 1).padStart(2, '0') }}</b>
          </div>
          <div class="ep-main">
            <h3 class="ep-title">{{ so.title || '未命名 MV' }}</h3>
            <div class="ep-meta-row">
              <span v-if="so.songSeconds" class="ep-meta">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                {{ Number(so.songSeconds).toFixed(1) }}s
              </span>
              <span class="ep-meta">{{ so.shots || 0 }} 段</span>
              <span class="ep-meta">{{ so.aspectRatio || '16:9' }}</span>
              <span v-if="so.updatedAt" class="ep-meta ep-time">{{ fmtDate(so.updatedAt) }}</span>
            </div>
          </div>
          <div class="ep-badges" @click.stop>
            <span :class="['tag', 'ep-status-btn']">
              <span :class="['status-dot', so.status === 'done' ? 'dot-done' : so.shots ? 'dot-active' : 'dot-pending']"></span>
              {{ statusZh(so.status) }}
            </span>
          </div>
        </div>
        <div class="ep-card-foot" @click.stop>
          <span class="ep-foot-spacer"></span>
          <button class="btn btn-icon btn-sm ep-delete" type="button" title="删除这个 MV" @click="deleteTarget = so">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
          <button type="button" class="ep-enter" @click="navigateTo(`/mv/${so.id}`)">
            进入制作
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
      </div>

      <div v-if="!songs.length" class="card ep-empty" role="button" tabindex="0" @click="openCreate" @keydown.enter="openCreate">
        <div class="ep-empty-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
        </div>
        <p>点这里建这个项目的第一支 MV（要选一首歌）</p>
      </div>
      <div v-else class="card ep-empty ep-add" role="button" tabindex="0" @click="openCreate" @keydown.enter="openCreate">
        <div class="ep-empty-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
        </div>
        <p>新建第 {{ songs.length + 1 }} 支 MV</p>
      </div>
    </div>

    <!-- Tab 2：素材库（照短剧 detail 的素材库 Tab：人物横排卡 / 场景竖排卡） -->
    <div v-else-if="activeTab === 'assets'" class="assets-wrap">
      <div class="assets-head">
        <div class="seg asset-filter">
          <button v-for="t in assetTabs" :key="t.value" type="button" class="seg-item" :class="{ on: assetTab === t.value }"
            @click="assetTab = t.value">{{ t.label }}</button>
        </div>
        <span class="field-hint">同一项目下的所有 MV 共用这套人物和场景</span>
        <button class="btn btn-sm assets-refresh" type="button" :disabled="loading" @click="load">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          刷新
        </button>
      </div>

      <div v-if="!visibleAssets.length" class="empty-state">
        <div class="empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
          </svg>
        </div>
        <p class="empty-title">还没有{{ assetTab === 'all' ? '人物或场景' : tabLabel(assetTab) }}</p>
        <p class="empty-desc">点开任意一支 MV，在里面「资产制作」提取并出图，就会进这个项目库</p>
      </div>

      <div v-else class="asset-groups">
        <template v-for="g in assetGroups" :key="g.kindKey">
          <template v-if="g.items.length">
            <div v-if="assetTab === 'all'" class="asset-group-head" :class="'is-' + g.kindKey">
              <span class="group-icon">
                <svg v-if="g.kindKey === 'character'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/></svg>
              </span>
              <span class="group-label">{{ g.label }}</span>
              <span class="group-count">{{ g.items.length }}</span>
            </div>

            <!-- 人物：横排卡（图区固定 16:9 + 样貌/妆造摘要 + 最终提示词） -->
            <div v-if="g.kindKey === 'character'" class="character-asset-grid">
              <article
                v-for="m in g.items"
                :key="'c' + m.id"
                class="card character-asset-card"
                tabindex="0" role="button"
                @click="openEdit(m)" @keydown.enter.prevent="openEdit(m)" @keydown.space.prevent="openEdit(m)"
              >
                <button class="asset-del-btn" type="button" title="删除人物" @click.stop="askDelete(m)">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
                <div class="character-asset-main">
                  <div class="character-asset-overview">
                    <div class="character-portrait">
                      <img v-if="m.image" :src="staticUrl(m.image)" class="previewable-image" loading="lazy" @click.stop="openViewer(m)" />
                      <div v-else class="character-portrait-empty">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                      </div>
                      <span class="asset-cover-badge" :class="m.image ? 'is-ready' : (isPending(m) ? 'is-pending' : '')">
                        {{ m.image ? '形象已生成' : (isPending(m) ? '出图中…' : '待生成') }}
                      </span>
                    </div>
                    <div class="character-asset-head">
                      <div class="character-title-block">
                        <div class="character-name-row">
                          <strong class="character-name">{{ m.name || '未命名' }}</strong>
                          <span class="tag">人物</span>
                        </div>
                        <div class="character-visual-summary" :title="m.appearance || ''">
                          <span>样貌 {{ m.appearance || '（待填写）' }}</span>
                          <span>妆造 {{ m.styling || '（待填写）' }}</span>
                        </div>
                      </div>
                      <div class="character-btn-row">
                        <button class="btn btn-sm" type="button" :disabled="promptBusy.includes(m.id)" @click.stop="genPrompt(m)">
                          {{ promptBusy.includes(m.id) ? '生成中…' : (m.prompt ? '重新生成提示词' : '生成提示词') }}
                        </button>
                        <button class="btn btn-sm" type="button" :disabled="isPending(m)" @click.stop="makeImage(m)">
                          {{ isPending(m) ? '出图中…' : (m.image ? '重绘' : '出图') }}
                        </button>
                        <button class="btn btn-sm" type="button" :disabled="!m.image || cardBusy.includes(m.id)" @click.stop="makeCard(m)">
                          {{ cardBusy.includes(m.id) ? '排队中…' : '生卡' }}
                        </button>
                        <span v-if="m.card" class="tag tag-success">卡已生成</span>
                      </div>
                    </div>
                  </div>
                  <div class="asset-final-prompt" :title="m.prompt || ''">
                    <span class="afp-label">最终提示词 · 三视图</span>
                    <span :class="['afp-text', !m.prompt && 'dim']">{{ m.prompt || '未生成（先点「生成提示词」）' }}</span>
                  </div>
                  <p v-if="isFailed(m)" class="bad asset-err">出图失败：{{ failMsg(m) }}</p>
                </div>
              </article>
            </div>

            <!-- 场景：竖排卡（封面跟随项目画幅） -->
            <div v-else class="asset-grid">
              <div
                v-for="m in g.items"
                :key="'s' + m.id"
                class="card asset-card asset-click-card"
                tabindex="0" role="button"
                @click="openEdit(m)" @keydown.enter.prevent="openEdit(m)" @keydown.space.prevent="openEdit(m)"
              >
                <button class="asset-del-btn" type="button" title="删除场景" @click.stop="askDelete(m)">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
                <div class="asset-cover wide">
                  <img v-if="m.image" :src="staticUrl(m.image)" class="previewable-image" loading="lazy" @click.stop="openViewer(m)" />
                  <div v-else class="asset-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </div>
                  <span class="asset-cover-badge" :class="m.image ? 'is-ready' : (isPending(m) ? 'is-pending' : '')">
                    {{ m.image ? '场景已生成' : (isPending(m) ? '出图中…' : '待生成') }}
                  </span>
                </div>
                <div class="asset-body">
                  <div class="asset-name" :title="m.name">{{ m.name || '未命名' }}</div>
                  <div class="asset-meta asset-desc dim" :title="m.description || ''">{{ m.description || '（待填写）' }}</div>
                  <div class="asset-meta asset-final" :class="{ dim: !m.prompt }" :title="m.prompt || ''">
                    <span class="afp-label">最终提示词 · 场景图</span>
                    {{ m.prompt || '未生成（先点「生成提示词」）' }}
                  </div>
                </div>
                <div class="asset-foot">
                  <span :class="['dot', m.image && 'ok', isPending(m) && 'pending']" />
                  <button class="btn btn-sm ml-auto" type="button" :disabled="promptBusy.includes(m.id)" @click.stop="genPrompt(m)">
                    {{ promptBusy.includes(m.id) ? '生成中…' : (m.prompt ? '重新生成提示词' : '生成提示词') }}
                  </button>
                  <button class="btn btn-sm" type="button" :disabled="isPending(m)" @click.stop="makeImage(m)">
                    {{ isPending(m) ? '出图中…' : (m.image ? '重绘' : '出图') }}
                  </button>
                  <button class="btn btn-sm" type="button" :disabled="!m.image || cardBusy.includes(m.id)" @click.stop="makeCard(m)">
                    {{ cardBusy.includes(m.id) ? '排队中…' : '生卡' }}
                  </button>
                </div>
              </div>
            </div>
          </template>
        </template>
      </div>
    </div>

    <!-- 素材编辑弹窗（照短剧素材详情弹窗：左预览 + 右编辑 + 最终提示词 + 底部操作） -->
    <Teleport to="body">
      <div v-if="editAsset" class="overlay mat-detail-overlay" @click.self="editAsset = null">
        <section class="dialog mat-detail-dialog">
          <header class="mat-detail-head">
            <div class="mat-detail-title-block">
              <span class="mat-detail-kicker">{{ editAsset.kind === 'character' ? '人物' : '场景' }}</span>
              <h2 class="mat-detail-title">{{ editAsset.name || '未命名' }}</h2>
            </div>
            <div class="mat-detail-head-actions">
              <span :class="['mat-detail-state', editAsset.image ? 'is-ready' : '']">{{ editAsset.image ? '已生成' : '待生成' }}</span>
              <button class="btn btn-ghost btn-icon" @click="editAsset = null">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </header>

          <div class="dialog-body mat-detail-body">
            <div class="mat-detail-shell">
              <aside class="mat-detail-preview-panel">
                <div class="mat-detail-section-title">
                  <span>视觉预览</span>
                  <span :class="['mat-detail-state', editAsset.image ? 'is-ready' : '']">{{ editAsset.image ? '已生成' : '待生成' }}</span>
                </div>
                <button type="button" class="mat-detail-media-frame" :disabled="!editAsset.image" @click.stop="openViewer(editAsset)">
                  <img v-if="editAsset.image" :src="staticUrl(editAsset.image)" />
                  <span v-else class="mat-detail-media-empty">{{ editAsset.kind === 'character' ? '未出形象图' : '未出场景图' }}</span>
                </button>
                <div class="mat-detail-meta-row">
                  <div class="mat-detail-meta-item">
                    <span>类型</span>
                    <strong>{{ editAsset.kind === 'character' ? '人物形象（16:9 三视图）' : '场景图（跟随项目画幅）' }}</strong>
                  </div>
                  <div class="mat-detail-meta-item">
                    <span>生卡</span>
                    <strong>{{ editAsset.card || '未生成' }}</strong>
                  </div>
                </div>
              </aside>

              <section class="mat-detail-editor-panel">
                <div class="mat-detail-section-title">
                  <span>编辑信息</span>
                  <span class="dim">改完点下面「保存修改」</span>
                </div>
                <div class="mat-detail-edit-grid" :class="editAsset.kind === 'character' ? 'is-character' : 'is-scene'">
                  <label class="mat-detail-edit-field">
                    <span>名字</span>
                    <input v-model="editAsset.name" class="input" placeholder="名字" />
                  </label>
                  <template v-if="editAsset.kind === 'character'">
                    <label class="mat-detail-edit-field">
                      <span>样貌</span>
                      <textarea v-model="editAsset.appearance" class="textarea mat-detail-textarea" rows="5" placeholder="脸 / 身形；颜色写唯一值，别写「或」"></textarea>
                    </label>
                    <label class="mat-detail-edit-field">
                      <span>妆造</span>
                      <textarea v-model="editAsset.styling" class="textarea mat-detail-textarea" rows="5" placeholder="服装 / 配饰（颜色 + 款式）"></textarea>
                    </label>
                  </template>
                  <label class="mat-detail-edit-field">
                    <span>{{ editAsset.kind === 'character' ? '描述（提取原文，可留空）' : '场景描述' }}</span>
                    <textarea v-model="editAsset.description" class="textarea mat-detail-textarea" rows="5"
                      :placeholder="editAsset.kind === 'character' ? '提取时写下的那段描述' : '地点 / 时间 / 光线 / 色调 / 氛围'"></textarea>
                  </label>
                </div>

                <section class="mat-detail-prompt-panel">
                  <div class="mat-detail-section-title">
                    <span>{{ editAsset.kind === 'character' ? '最终提示词 · 三视图' : '最终提示词 · 场景图' }}</span>
                    <button class="btn btn-sm mat-detail-prompt-gen" :disabled="promptBusy.includes(editAsset.id)" @click="genPrompt(editAsset)">
                      {{ promptBusy.includes(editAsset.id) ? '生成中…' : (editAsset.prompt ? '重新生成' : '生成提示词') }}
                    </button>
                  </div>
                  <textarea v-model="editAsset.prompt" class="textarea mat-detail-prompt-text" rows="6" placeholder="还没生成 —— 先点右上角「生成提示词」"></textarea>
                </section>
              </section>
            </div>
          </div>

          <footer class="dialog-foot mat-detail-foot">
            <div class="mat-detail-secondary-actions">
              <button class="btn" @click="editAsset = null">关闭</button>
            </div>
            <div class="mat-detail-primary-actions">
              <button class="btn" :disabled="isPending(editAsset)" @click="makeImage(editAsset)">
                {{ editAsset.image ? '重绘' : '出图' }}
              </button>
              <button class="btn btn-primary" @click="saveAsset">保存修改</button>
            </div>
          </footer>
        </section>
      </div>
    </Teleport>

    <!-- 看大图 -->
    <Teleport to="body">
      <div v-if="viewer.open" class="overlay viewer-overlay" @click.self="viewer.open = false">
        <div class="dialog viewer-dialog">
          <div class="viewer-head">
            <span class="viewer-title">{{ viewer.title }}</span>
            <button class="btn btn-icon btn-sm btn-ghost" @click="viewer.open = false">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <img :src="viewer.src" :alt="viewer.title" class="viewer-img" />
        </div>
      </div>
    </Teleport>

    <!-- 新建 MV（选歌 + 填原始内容） -->
    <Teleport to="body">
      <div v-if="showCreate" class="overlay" @click.self="showCreate = false">
        <div class="dialog create-dialog">
          <div class="dialog-head"><div class="dialog-title">新建 MV</div></div>
          <div class="dialog-body">
            <label class="field">
              <span class="field-label">名字 <span class="required">*</span></span>
              <input v-model.trim="form.title" class="input" placeholder="例：MV1 / 翻到那一页" />
            </label>
            <label class="field">
              <span class="field-label">类型</span>
              <BaseSelect v-model="form.kind" :options="KINDS" placeholder="选类型" />
              <span class="field-hint">{{ form.kind === 'dance'
                ? 'MV 舞蹈：给一段参考舞蹈视频（自带音乐），后台自动适配尺寸并按动作自然切段，人物卡锁人'
                : '唱歌 MV：给一首歌，按人声能量切镜头' }}</span>
            </label>
            <label class="field">
              <span class="field-label">{{ form.kind === 'dance' ? '参考舞蹈视频（mp4/mov）' : '歌文件（mp3/wav）' }}<span class="required">*</span></span>
              <input class="input" type="file" :accept="form.kind === 'dance' ? 'video/*' : 'audio/*'" @change="onSong" />
              <span v-if="form.song" class="field-hint">已选：{{ form.song.name }}</span>
            </label>
            <label class="field">
              <span class="field-label">画风</span>
              <BaseSelect v-model="form.style" :options="styleOptions" placeholder="选一个画风" searchable />
            </label>
            <label class="field">
              <span class="field-label">画幅</span>
              <BaseSelect v-model="form.aspectRatio" :options="RATIOS" placeholder="选画幅" />
              <span class="field-hint">人物板固定 16:9；场景图和成片按这个比例</span>
            </label>
            <label v-if="form.kind !== 'dance'" class="field">
              <span class="field-label">分镜提示词（先空着也行，进项目再写）</span>
              <textarea v-model="form.storyPrompt" class="textarea" rows="4"
                placeholder="例：开场雨夜的城市街道，主角撑伞独行；副歌切到房间里翻旧照片……"></textarea>
            </label>
            <label class="field">
              <span class="field-label">{{ form.kind === 'dance' ? '最长分镜（秒，默认 10，最大 15）' : '最长切分（秒，默认 10，最大 15）' }}</span>
              <input v-model.number="form.maxShotSeconds" class="input" type="number" min="5" max="15" step="0.5" style="width:110px" />
              <span v-if="form.kind === 'dance'" class="field-hint">参考视频按这个时长切成几段（每段吸附 17n+5 帧网格，最短 5.2 秒）</span>
            </label>
          </div>
          <div class="dialog-foot">
            <button class="btn" @click="showCreate = false">取消</button>
            <button class="btn btn-primary" :disabled="creating || !form.song || !form.title" @click="createSong">
              {{ creating ? '创建中…' : '创建' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 改项目名字 -->
    <div v-if="showRename" class="overlay" @click.self="showRename = false">
      <div class="dialog create-dialog">
        <div class="dialog-head"><div class="dialog-title">改项目名字</div></div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">项目名字</span>
            <input v-model.trim="renameTitle" class="input" placeholder="项目名字" @keyup.enter="doRename" />
          </label>
        </div>
        <div class="dialog-foot">
          <button class="btn" @click="showRename = false">取消</button>
          <button class="btn btn-primary" :disabled="!renameTitle" @click="doRename">保存</button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="!!deleteTarget"
      title="删除这个 MV"
      :message="`确定删除「${deleteTarget?.title || '未命名 MV'}」？这首歌的人物 / 场景 / 分镜 / 成片记录都会一起删掉，这一步不能撤销。`"
      :loading="deleting"
      @confirm="doDeleteSong"
      @cancel="deleteTarget = null"
    />
    <ConfirmDialog
      :open="!!assetDelete"
      title="删除素材"
      :message="`确定删除「${assetDelete?.name || '未命名'}」？已生成的图、身份卡和提示词都会一起删掉，这一步不能撤销。`"
      :loading="deletingAsset"
      @confirm="doDeleteAsset"
      @cancel="assetDelete = null"
    />
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue'
import { api, stylePresetAPI } from '~/composables/useApi'
import BaseSelect from '~/components/BaseSelect.vue'

const route = useRoute()
const seriesId = Number(route.params.id)

const series = ref(null)
const songs = ref([])
const assets = ref([])
const presets = ref([])
const loading = ref(false)
const activeTab = ref('songs')
const assetTab = ref('all')
const promptBusy = ref([])   // 正在生成提示词的资产 id 列表：每张卡各自锁
const cardBusy = ref([])
const viewer = ref({ open: false, src: '', title: '' })
const editAsset = ref(null)
const showCreate = ref(false)
const showRename = ref(false)
const renameTitle = ref('')
const creating = ref(false)
const deleteTarget = ref(null)
const deleting = ref(false)
const assetDelete = ref(null)
const deletingAsset = ref(false)

const RATIOS = [
  { label: '9:16 竖屏（手机/抖音）', value: '9:16' },
  { label: '16:9 横屏', value: '16:9' },
]
const assetTabs = [
  { label: '全部', value: 'all' },
  { label: '人物', value: 'character' },
  { label: '场景', value: 'scene' },
]
const KINDS = [
  { label: '唱歌 MV', value: 'song' },
  { label: 'MV 舞蹈（复刻参考视频动作）', value: 'dance' },
]
const form = reactive({ title: '', style: '', storyPrompt: '', aspectRatio: '16:9', maxShotSeconds: 10, song: null, kind: 'song' })

const styleOptions = computed(() => presets.value.map((p) => ({ label: p.name, value: p.value })))
const styleLabel = (key) => presets.value.find((p) => p.value === key)?.name || key || ''
const characters = computed(() => assets.value.filter((a) => a.kind === 'character'))
const scenes = computed(() => assets.value.filter((a) => a.kind === 'scene'))
const visibleAssets = computed(() => (assetTab.value === 'all' ? assets.value : assets.value.filter((a) => a.kind === assetTab.value)))
const assetGroups = computed(() => [
  { kindKey: 'character', label: '人物', items: visibleAssets.value.filter((a) => a.kind === 'character') },
  { kindKey: 'scene', label: '场景', items: visibleAssets.value.filter((a) => a.kind === 'scene') },
])
const tabLabel = (v) => assetTabs.find((x) => x.value === v)?.label || ''

const ZH = { draft: '未开始', planned: '有粗分镜', shots: '有分镜', rendering: '出片中', done: '已完成', pending: '待生成', processing: '生成中', completed: '已完成', failed: '失败' }
const statusZh = (s) => ZH[s] || s || '未开始'

// 资产图存的是 'mv/p1/x.png'（不带 static 前缀），视频/成片带前缀 —— 幂等处理（照旧口径）
function staticUrl(rel) {
  if (!rel) return ''
  return String(rel).startsWith('static/') ? `/${rel}` : `/static/${rel}`
}
function fmtDate(iso) {
  if (!iso) return ''
  const t = new Date(String(iso).replace(' ', 'T')).getTime()
  if (!t) return ''
  const diff = Date.now() - t
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
const isPending = (m) => m?.imageStatus === 'processing'
const isFailed = (m) => String(m?.imageStatus || '').startsWith('failed')
const failMsg = (m) => String(m?.imageStatus || '').slice(8)

async function load() {
  loading.value = true
  try {
    const r = await api.get(`/mv/series/${seriesId}`)
    series.value = r.series || null
    songs.value = r.songs || []
    assets.value = r.assets || []
    // 编辑弹窗开着时只同步易变字段（别把用户正在改的名字/描述冲掉）
    if (editAsset.value) {
      const f = assets.value.find((x) => x.id === editAsset.value.id)
      if (f) {
        editAsset.value.image = f.image
        editAsset.value.imageStatus = f.imageStatus
        editAsset.value.card = f.card
      }
    }
  } catch (err) {
    alert(String(err?.message || err))
  } finally {
    loading.value = false
  }
}

function openCreate() {
  form.title = ''
  form.storyPrompt = ''
  form.song = null
  form.aspectRatio = series.value?.aspectRatio || '16:9'
  form.style = series.value?.style || (presets.value[0]?.value || '')
  form.maxShotSeconds = 10
  form.kind = 'song'
  showCreate.value = true
}
function onSong(e) {
  const f = e.target.files?.[0]
  if (f) form.song = f
}
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('读文件失败'))
    fr.readAsDataURL(file)
  })
}
async function createSong() {
  if (!form.song || !form.title) return
  creating.value = true
  try {
    // MV 舞蹈：先建项目（无歌），再把参考视频交给后台适配 + 自动切段
    if (form.kind === 'dance') {
      const r = await api.post('/mv/projects', {
        series_id: seriesId,
        title: form.title,
        style: form.style,
        aspect_ratio: form.aspectRatio,
        kind: 'dance',
        max_shot_seconds: form.maxShotSeconds,
      })
      if (!r?.id) throw new Error('建项目没返回 id')
      await api.post(`/mv/projects/${r.id}/dance`, {
        video: { name: form.song.name || 'dance.mp4', data: await toBase64(form.song) },
      })
      showCreate.value = false
      navigateTo(`/mv/${r.id}`)
      return
    }
    const r = await api.post('/mv/projects', {
      series_id: seriesId,
      title: form.title,
      style: form.style,
      story_prompt: form.storyPrompt,
      aspect_ratio: form.aspectRatio,
      max_shot_seconds: form.maxShotSeconds,
      song: { name: form.song.name || 'song.mp3', data: await toBase64(form.song) },
    })
    showCreate.value = false
    if (r?.id) navigateTo(`/mv/${r.id}`)
  } catch (err) {
    alert(String(err?.message || err))
  } finally {
    creating.value = false
  }
}

function openRename() {
  renameTitle.value = series.value?.title || ''
  showRename.value = true
}
async function doRename() {
  if (!renameTitle.value) return
  try {
    await api.put(`/mv/series/${seriesId}`, { title: renameTitle.value })
    showRename.value = false
    await load()
  } catch (err) {
    alert(String(err?.message || err))
  }
}

async function doDeleteSong() {
  const so = deleteTarget.value
  if (!so) return
  deleting.value = true
  try {
    await api.del(`/mv/projects/${so.id}`)
    deleteTarget.value = null
    await load()
  } catch (err) {
    alert(String(err?.message || err))
  } finally {
    deleting.value = false
  }
}

function openViewer(m) {
  if (!m?.image) return
  viewer.value = { open: true, src: staticUrl(m.image), title: `${m.kind === 'character' ? '人物' : '场景'} · ${m.name || ''}` }
}
function openEdit(m) {
  editAsset.value = { ...m }
}

/** 资产行的写接口都挂在它自己所属的 project 上（assets 是项目级共享，行里带 projectId） */
const assetBase = (m) => `/mv/projects/${m.projectId}/assets/${m.id}`

async function saveAsset() {
  const a = editAsset.value
  if (!a) return
  try {
    const r = await api.put(assetBase(a), {
      name: a.name, description: a.description, appearance: a.appearance, styling: a.styling, prompt: a.prompt,
    })
    if (r?.assets) assets.value = r.assets
    const fresh = (r?.assets || []).find((x) => x.id === a.id)
    if (fresh) Object.assign(a, { image: fresh.image, imageStatus: fresh.imageStatus, card: fresh.card, prompt: fresh.prompt ?? a.prompt })
  } catch (err) {
    alert(String(err?.message || err))
  }
}

async function genPrompt(m) {
  if (!String(m.description || m.appearance || m.styling || '').trim()) {
    alert('这个资产还没有描述 —— 先写清外貌/场景，再生成提示词')
    return
  }
  if (promptBusy.value.includes(m.id)) return
  promptBusy.value = [...promptBusy.value, m.id]
  try {
    const r = await api.post(`${assetBase(m)}/prompt`, {
      name: m.name, description: m.description, appearance: m.appearance, styling: m.styling,
    })
    if (r?.assets) assets.value = r.assets
    const fresh = (r?.assets || []).find((x) => x.id === m.id)
    if (fresh && editAsset.value?.id === m.id) Object.assign(editAsset.value, { prompt: fresh.prompt })
  } catch (err) {
    alert(String(err?.message || err))
  } finally {
    promptBusy.value = promptBusy.value.filter((x) => x !== m.id)
  }
}

async function makeImage(m) {
  if (!m.prompt) {
    alert('先点「生成提示词」，再出图')
    return
  }
  try {
    const r = await api.post(`${assetBase(m)}/image`, { name: m.name, description: m.description, prompt: m.prompt })
    if (r?.assets) assets.value = r.assets
    startPoll()
  } catch (err) {
    alert(String(err?.message || err))
  }
}

async function makeCard(m) {
  if (!m.image) {
    alert('先给这个资产「出图」，再生卡')
    return
  }
  if (cardBusy.value.includes(m.id)) return
  cardBusy.value = [...cardBusy.value, m.id]
  try {
    const r = await api.post(`${assetBase(m)}/card`, {})
    const mine = (r?.assets || []).find((x) => x.id === m.id)
    if (mine) Object.assign(m, mine)
  } catch (err) {
    alert(`「${m.name || '这张卡'}」生卡失败：` + String(err?.message || err))
  } finally {
    cardBusy.value = cardBusy.value.filter((x) => x !== m.id)
  }
}

function askDelete(m) {
  assetDelete.value = m
}
async function doDeleteAsset() {
  const m = assetDelete.value
  if (!m) return
  deletingAsset.value = true
  try {
    await api.del(assetBase(m))
    if (editAsset.value?.id === m.id) editAsset.value = null
    assetDelete.value = null
    await load()
  } catch (err) {
    alert(String(err?.message || err))
  } finally {
    deletingAsset.value = false
  }
}

// 出图在后台排队 ⇒ 有 processing 的资产就每 6 秒拉一次（只合并易变字段）
let timer = null
function startPoll() {
  if (timer) return
  timer = setInterval(async () => {
    if (!assets.value.some((a) => a.imageStatus === 'processing')) {
      clearInterval(timer); timer = null; return
    }
    await load()
  }, 6000)
}

onMounted(async () => {
  const p = await stylePresetAPI.list().catch(() => [])
  presets.value = p || []
  await load()
  startPoll()
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
/* 全部数值照抄短剧 drama/detail.vue，不自造视觉 */
.page { padding: 20px 28px 40px; overflow-y: auto; height: 100%; animation: fadeUp 0.35s var(--ease-out) both; }
.page-head { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-radius: var(--radius-lg); margin-bottom: 14px; }
.head-info { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.head-action { flex-shrink: 0; }
.title-edit-btn { flex: 0 0 auto; color: var(--text-3); }
.title-edit-btn:hover { color: var(--accent); background: var(--accent-bg); }
.back-btn {
  width: 30px; height: 30px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  border: none; border-radius: 50%; background: var(--overlay-track); color: var(--text-1); cursor: pointer;
  transition: background 0.16s var(--ease-out), color 0.16s var(--ease-out);
}
.back-btn:hover { background: var(--bg-active); color: var(--text-0); }
.page-title { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.page-meta { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.meta-item { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-2); }

/* 主 Tab */
.page-tabs { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 14px; }
.tab-btn {
  position: relative; display: inline-flex; align-items: center; gap: 7px; border: none; background: transparent;
  padding: 8px 4px 10px; margin-right: 20px; font-size: 13.5px; font-weight: 600; color: var(--text-2); cursor: pointer;
  transition: color 0.16s var(--ease-out);
}
.tab-btn svg { opacity: 0.75; }
.tab-btn::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; border-radius: 2px; background: transparent; transition: background 0.16s var(--ease-out); }
.tab-btn:hover { color: var(--text-0); }
.tab-btn.on { color: var(--text-0); font-weight: 650; }
.tab-btn.on::after { background: var(--accent); }
.tab-count {
  display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 9px; font-size: 11px; font-weight: 700; font-family: var(--font-mono); background: var(--bg-2); color: var(--text-2);
}
.tab-btn.on .tab-count { background: var(--accent-bg); color: var(--accent-text); }

/* MV 卡片（照短剧 ep-card） */
.ep-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 10px; }
.ep-card {
  position: relative; display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 10px; cursor: pointer;
  animation: fadeUp 0.35s var(--ease-out) both; transition: border-color 0.18s var(--ease-out), background 0.18s var(--ease-out);
}
.ep-card:hover { border-color: var(--border-strong); }
.ep-card-top { display: flex; align-items: center; gap: 12px; min-width: 0; }
.ep-number {
  width: 40px; height: 40px; flex-shrink: 0; border-radius: var(--radius); border: 1px solid var(--border);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-family: var(--font-mono); background: var(--bg-2); color: var(--text-1);
}
.ep-num-label { font-size: 7.5px; letter-spacing: 0.18em; font-weight: 600; opacity: 0.55; line-height: 1; margin-bottom: 1px; }
.ep-number b { font-size: 15px; font-weight: 600; line-height: 1; }
.ep-main { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
.ep-title { font-size: 13.5px; font-weight: 600; color: var(--text-0); line-height: 1.35; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ep-meta-row { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; overflow: hidden; white-space: nowrap; }
.ep-meta { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-3); white-space: nowrap; flex-shrink: 0; }
.ep-meta svg { opacity: 0.7; flex-shrink: 0; }
.ep-time { flex-shrink: 1; overflow: hidden; text-overflow: ellipsis; }
.ep-badges { display: flex; align-items: center; flex-shrink: 0; }
.ep-card-foot { display: flex; align-items: center; gap: 6px; padding-top: 9px; border-top: 1px solid var(--border); }
.ep-foot-spacer { flex: 1; }
.ep-enter {
  display: inline-flex; align-items: center; gap: 4px; padding: 4px 12px; border: none; border-radius: var(--radius);
  background: var(--accent-bg); color: var(--accent-text); font-size: 12px; font-weight: 600; cursor: pointer;
  transition: background 0.15s, color 0.15s; white-space: nowrap;
}
.ep-enter:hover { background: var(--accent-gradient); color: var(--on-accent, #fff); box-shadow: 0 2px 8px var(--accent-glow); }
.ep-status-btn {
  cursor: default; border: none; font: inherit; display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 10px; border-radius: 20px; background: var(--bg-2); color: var(--text-2); font-size: 11px; font-weight: 500; white-space: nowrap;
}
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); }
.status-dot.dot-active { background: var(--success); }
.status-dot.dot-done { background: var(--accent); }
.ep-delete { flex-shrink: 0; }
.ep-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  padding: 26px 16px; min-height: 140px; cursor: pointer; color: var(--text-3); font-size: 12.5px;
  border-style: dashed; transition: border-color 0.16s, color 0.16s;
}
.ep-empty:hover { border-color: var(--accent); color: var(--accent-text); }
.ep-empty-icon {
  width: 40px; height: 40px; border-radius: 50%; background: var(--bg-2);
  display: flex; align-items: center; justify-content: center; color: var(--text-3);
}
.ep-add { min-height: 140px; }

/* 素材库 */
.assets-wrap { padding-bottom: 20px; }
.assets-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.assets-refresh { margin-left: auto; flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; }
.field-hint { font-size: 11.5px; color: var(--text-3); }
.asset-group-head {
  display: flex; align-items: center; gap: 8px; padding: 7px 14px; margin: 4px 0 14px;
  border-radius: var(--radius); border-left: 3px solid var(--text-3); background: var(--bg-1);
  font-size: 13.5px; font-weight: 700; color: var(--text-1);
}
.asset-group-head .group-icon { display: inline-flex; color: var(--text-2); }
.asset-group-head .group-count {
  margin-left: auto; font-size: 11.5px; font-weight: 600; color: var(--text-3);
  background: var(--bg-2); border-radius: 99px; padding: 1px 9px;
}
.asset-group-head.is-character { border-left-color: var(--accent); background: var(--accent-bg); color: var(--accent-text); }
.asset-group-head.is-character .group-icon { color: var(--accent-text); }
.asset-group-head.is-scene { border-left-color: var(--success); background: var(--success-bg); color: var(--tag-success-text); }
.asset-group-head.is-scene .group-icon { color: var(--tag-success-text); }

.character-asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 260px)); justify-content: start; gap: 10px; }
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; align-items: stretch; }
.character-asset-card, .asset-card {
  position: relative; display: flex; flex-direction: column; overflow: hidden; min-height: 0; cursor: pointer;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
}
.character-asset-card:hover, .asset-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); border-color: var(--border-strong); }
.asset-del-btn {
  position: absolute; top: 8px; right: 8px; z-index: 3; width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; border: none; background: rgba(0, 0, 0, 0.5);
  color: #fff; cursor: pointer; opacity: 0; transition: opacity 0.15s, background 0.15s;
}
.asset-del-btn:hover { background: var(--action-danger); }
.character-asset-card:hover .asset-del-btn, .asset-card:hover .asset-del-btn { opacity: 1; }

.character-asset-main { min-width: 0; width: 100%; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.character-asset-overview { display: flex; flex-direction: column; gap: 8px; }
.character-portrait {
  position: relative; width: 100%; aspect-ratio: 16 / 9; border: 1px solid var(--surface-outline);
  border-radius: var(--radius); background: var(--bg-2); overflow: hidden;
}
.character-portrait img, .asset-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.character-portrait-empty, .asset-cover-empty {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3);
}
.previewable-image { cursor: zoom-in; transition: transform 0.18s var(--ease-out), filter 0.18s var(--ease-out); }
.previewable-image:hover { transform: scale(1.015); filter: saturate(1.04); }
.asset-cover-badge {
  position: absolute; top: 7px; left: 7px; display: inline-flex; align-items: center; padding: 2px 7px;
  border-radius: 999px; background: var(--header-bg); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--shadow-xs); color: var(--text-2); font-size: 9.5px; font-weight: 700;
}
.asset-cover-badge.is-ready { background: var(--success-bg); color: var(--tag-success-text); }
.asset-cover-badge.is-pending { background: var(--accent-bg); color: var(--accent-text); }
.character-asset-head { display: flex; flex-direction: column; align-items: stretch; gap: 6px; min-width: 0; }
.character-btn-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.character-title-block { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.character-name-row { display: flex; align-items: center; gap: 5px; min-width: 0; flex-wrap: wrap; }
.character-name { font-size: 13px; line-height: 1.25; color: var(--text-0); }
.character-visual-summary {
  max-width: 100%; display: flex; gap: 8px; overflow: hidden; color: var(--text-3);
  font-size: 10.5px; line-height: 1.45; white-space: nowrap;
}
.character-visual-summary span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.asset-final-prompt {
  display: flex; flex-direction: column; gap: 2px; padding-top: 7px; border-top: 1px solid var(--border);
  font-size: 10.5px; line-height: 1.5;
}
.afp-label { font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em; color: var(--text-3); }
.afp-text { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; word-break: break-word; color: var(--text-2); }
.afp-text.dim { color: var(--text-3); }
.asset-cover { position: relative; aspect-ratio: 1; background: var(--bg-2); overflow: hidden; }
.asset-cover.wide { aspect-ratio: 16/9; }
.asset-body { flex: 1; display: flex; flex-direction: column; gap: 3px; padding: 9px 11px 8px; min-width: 0; }
.asset-name { font-size: 13px; font-weight: 650; color: var(--text-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.asset-meta { font-size: 11px; line-height: 1.5; }
.asset-desc { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; word-break: break-word; }
.asset-final { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; word-break: break-word; color: var(--text-2); }
.asset-final .afp-label { margin-right: 4px; }
.asset-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 7px 11px; border-top: 1px solid var(--border); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bg-3); flex-shrink: 0; }
.dot.ok { background: var(--success); }
.dot.pending { background: var(--accent); }
.asset-err { font-size: 11.5px; margin: 0; line-height: 1.5; color: var(--action-danger); }
.bad { color: var(--action-danger); }

.empty-state {
  min-height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); background: var(--surface-raised); text-align: center;
}
.empty-icon {
  width: 56px; height: 56px; border-radius: var(--radius-lg); background: var(--bg-2); color: var(--text-3);
  display: flex; align-items: center; justify-content: center; margin-bottom: 4px;
}
.empty-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.empty-desc { font-size: 12px; color: var(--text-3); max-width: 280px; line-height: 1.6; }

/* 看大图（照短剧原值） */
.viewer-overlay { align-items: center; }
.viewer-dialog { width: min(960px, calc(100vw - 48px)); padding: 14px; }
.viewer-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.viewer-title { font-size: 13px; font-weight: 600; color: var(--text-1); }
.viewer-img { width: 100%; max-height: 76vh; object-fit: contain; border-radius: var(--radius); background: var(--bg-2); display: block; }

/* 素材编辑弹窗（照短剧 .mat-detail-* 原值） */
.mat-detail-overlay { z-index: 118; padding: 28px; }
.mat-detail-dialog { width: min(1040px, calc(100vw - 56px)); max-height: calc(100vh - 56px); }
.mat-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--surface-outline); }
.mat-detail-title-block { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mat-detail-kicker { color: var(--text-3); font-size: 10px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
.mat-detail-title { margin: 0; color: var(--text-0); font-size: 18px; line-height: 1.2; }
.mat-detail-head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.mat-detail-body { min-height: 0; overflow: auto; padding: 16px; }
.mat-detail-shell { display: grid; grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); gap: 14px; align-items: start; }
.mat-detail-preview-panel, .mat-detail-editor-panel { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.mat-detail-preview-panel { position: sticky; top: 0; }
.mat-detail-section-title {
  min-height: 24px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
  color: var(--text-1); font-size: 12px; font-weight: 820; letter-spacing: 0.02em;
}
.mat-detail-section-title .dim { font-size: 11px; font-weight: 560; letter-spacing: 0; text-align: right; }
.mat-detail-state {
  min-height: 20px; display: inline-flex; align-items: center; padding: 0 7px; border-radius: 999px;
  background: var(--overlay-track); color: var(--text-3); font-size: 10px; font-weight: 760; white-space: nowrap;
}
.mat-detail-state.is-ready { color: var(--success); background: var(--success-bg); }
.mat-detail-media-frame {
  position: relative; width: 100%; aspect-ratio: 16/9; display: block; padding: 0;
  border: 1px solid var(--surface-outline); border-radius: var(--radius); background: var(--bg-2);
  color: var(--text-3); overflow: hidden; cursor: zoom-in;
}
.mat-detail-media-frame:disabled { cursor: default; opacity: 1; }
.mat-detail-media-frame img { width: 100%; height: 100%; display: block; object-fit: cover; }
.mat-detail-media-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.mat-detail-meta-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.mat-detail-meta-item {
  min-width: 0; padding: 9px 10px; border: 1px solid var(--surface-outline);
  border-radius: var(--radius); background: var(--surface-muted);
}
.mat-detail-meta-item span { display: block; color: var(--text-3); font-size: 10px; font-weight: 780; letter-spacing: 0.04em; }
.mat-detail-meta-item strong {
  display: block; margin-top: 4px; min-width: 0; color: var(--text-0); font-size: 12px;
  line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mat-detail-edit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.mat-detail-edit-grid.is-character, .mat-detail-edit-grid.is-scene { grid-template-columns: 1fr; }
.mat-detail-edit-field { min-width: 0; display: flex; flex-direction: column; gap: 7px; }
.mat-detail-edit-field > span { color: var(--text-3); font-size: 10px; font-weight: 780; letter-spacing: 0.04em; }
.mat-detail-textarea { min-height: 164px; resize: vertical; }
.mat-detail-prompt-panel { margin-top: 18px; border-top: 1px solid var(--border); padding-top: 16px; }
.mat-detail-prompt-gen { margin-left: auto; flex-shrink: 0; }
.mat-detail-prompt-text {
  width: 100%; margin-top: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface); color: var(--text-0); font-size: 12.5px; line-height: 1.6; resize: vertical; min-height: 112px; font-family: inherit;
}
.mat-detail-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 16px;
  border-top: 1px solid var(--surface-outline);
}
.mat-detail-secondary-actions, .mat-detail-primary-actions { display: flex; align-items: center; gap: 8px; }

.create-dialog { width: 460px; max-width: calc(100vw - 32px); }
.dialog-body { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.required { color: var(--error); }

@media (max-width: 860px) {
  .page { padding: 16px 16px 32px; }
  .page-head { flex-wrap: wrap; }
  .ep-grid { grid-template-columns: 1fr; }
}
</style>

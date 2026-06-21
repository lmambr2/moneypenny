<template>
  <div class="settings-page">
    <button class="back-btn" @click="$router.back()">
      <Icon icon="mdi:arrow-left" />
      Back
    </button>
    <h1 class="page-title">Settings</h1>

    <!-- Theme Toggle -->
    <section class="settings-section">
      <h2 class="section-title">Appearance</h2>
      <div class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:theme-light-dark" class="setting-icon" />
          Theme
        </div>
        <button class="theme-toggle" @click="store.toggleTheme()">
          <Icon :icon="store.theme === 'dark' ? 'mdi:weather-night' : 'mdi:weather-sunny'" />
          {{ store.theme === 'dark' ? 'Dark' : 'Light' }}
        </button>
      </div>
    </section>

    <!-- Account: own password change -->
    <section class="settings-section">
      <h2 class="section-title">Account</h2>
      <div class="account-info-card">
        <div class="account-row">
          <span class="account-label">Username</span>
          <span class="account-value">{{ session.currentUser.value?.username ?? '—' }}</span>
        </div>
        <div class="account-row">
          <span class="account-label">Role</span>
          <span class="account-value">
            <span class="user-role-badge" :class="`role-${session.currentUser.value?.role}`">
              {{ session.currentUser.value?.role === 'admin' ? 'Admin' : 'Member' }}
            </span>
          </span>
        </div>
      </div>
      <form class="change-pw-form" @submit.prevent="onChangeOwnPassword">
        <input v-model="ownPw.old" type="password" autocomplete="current-password" class="input" placeholder="Current password" required />
        <input v-model="ownPw.new" type="password" autocomplete="new-password" minlength="8" class="input" placeholder="New password (min 8 characters)" required />
        <input v-model="ownPw.confirm" type="password" autocomplete="new-password" minlength="8" class="input" placeholder="Confirm new password" required />
        <button class="btn-sm btn-primary" type="submit" :disabled="changingOwnPw">
          {{ changingOwnPw ? 'Updating…' : 'Change Password' }}
        </button>
      </form>
      <p v-if="ownPwError" class="user-error">{{ ownPwError }}</p>
      <p v-if="ownPwSuccess" class="user-success">{{ ownPwSuccess }}</p>
    </section>

    <!-- Bot Management -->
    <section class="settings-section">
      <h2 class="section-title">Bot Management</h2>
      <div class="bot-list">
        <div v-for="bot in store.bots" :key="bot.id" class="bot-item">
          <div class="bot-info">
            <div class="bot-name">{{ bot.name }}</div>
            <div class="bot-status" :class="botStatusClass(bot)">
              {{ botStatusText(bot) }}
            </div>
          </div>
          <div class="bot-actions">
            <button class="btn-sm" @click="toggleBot(bot.id, bot.connected)">
              {{ bot.connected ? 'Stop' : 'Start' }}
            </button>
            <button class="btn-sm btn-edit" @click="openEditBot(bot)">
              <Icon icon="mdi:pencil" />
            </button>
            <button class="btn-sm btn-delete" @click="deleteBot(bot.id, bot.name)">
              <Icon icon="mdi:delete" />
            </button>
          </div>
        </div>
      </div>

      <!-- Edit Bot Modal -->
      <div v-if="editingBot" class="edit-modal-overlay" @click.self="editingBot = null">
        <div class="edit-modal">
          <h3 class="modal-title">Edit Bot</h3>
          <div class="form-group">
            <label>Name</label>
            <input v-model="editForm.name" class="input" />
          </div>
          <div class="form-group">
            <label>Server Address</label>
            <input v-model="editForm.serverAddress" class="input" placeholder="ts.example.com" />
          </div>
          <div class="form-row">
            <div class="form-group" style="flex:1">
              <label>Port</label>
              <input v-model.number="editForm.serverPort" type="number" class="input" />
            </div>
            <div class="form-group" style="flex:2">
              <label>Nickname</label>
              <input v-model="editForm.nickname" class="input" />
            </div>
          </div>
          <div class="form-group">
            <label>Default Channel (optional)</label>
            <input v-model="editForm.defaultChannel" class="input" placeholder="Music channel" />
          </div>
          <div class="form-group">
            <label>Channel Password (optional)</label>
            <input v-model="editForm.channelPassword" class="input" type="password" />
          </div>
          <div class="form-group">
            <label>Server Password (optional)</label>
            <input v-model="editForm.serverPassword" class="input" type="password" placeholder="Enter if server requires password" />
          </div>
          <div class="form-group">
            <label>Custom Avatar</label>
            <CustomAvatarRow :bot-id="editingBot" />
          </div>
          <div class="modal-actions">
            <button class="btn-secondary" @click="editingBot = null">Cancel</button>
            <button class="btn-primary" @click="saveEditBot">Save (requires bot restart)</button>
          </div>
        </div>
      </div>

      <!-- Create Bot -->
      <div class="create-bot">
        <h3 class="subsection-title">Create New Bot</h3>
        <div class="form-group">
          <label>Name</label>
          <input v-model="newBotName" class="input" placeholder="My Music Bot" />
        </div>
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>Server Address</label>
            <input v-model="newBotServer" class="input" placeholder="localhost or ts.example.com" />
          </div>
          <div class="form-group" style="flex:1">
            <label>Port</label>
            <input v-model.number="newBotPort" type="number" class="input" placeholder="9987" />
          </div>
        </div>
        <div class="form-group">
          <label>Nickname</label>
          <input v-model="newBotNickname" class="input" placeholder="Moneypenny" />
        </div>
        <div class="form-group">
          <label>Default Channel (optional)</label>
          <input v-model="newBotChannel" class="input" placeholder="Music channel" />
        </div>
        <div class="form-group">
          <label>Server Password (optional)</label>
          <input v-model="newBotServerPassword" class="input" type="password" placeholder="Enter if server requires password" />
        </div>
        <div class="form-group">
          <label>Custom Avatar (optional)</label>
          <AvatarUpload v-model="newBotAvatar" />
        </div>
        <button class="btn-primary" @click="createBot">Create</button>
      </div>
    </section>

    <!-- Music Sources (Local-first) -->
    <section class="settings-section">
      <h2 class="section-title">Music Sources</h2>

      <div class="account-card">
        <div class="account-header">
          <Icon icon="mdi:folder-music-outline" class="account-icon" />
          <div class="account-info">
            <div class="account-name">Local Music Library (Primary Source)</div>
            <div class="account-status logged">
              {{ store.localTrackCount || store.localRecent.length }} tracks indexed
            </div>
          </div>
        </div>
        <div class="source-note">
          Configure via the MUSIC_DIR environment variable on the server. Supports metadata indexing, M3U/M3U8 playlists, and strict path safety.
        </div>
      </div>

      <div class="account-card">
        <div class="account-header">
          <Icon icon="mdi:youtube" class="account-icon" />
          <div class="account-info">
            <div class="account-name">YouTube</div>
            <div class="account-status logged">
              Available via yt-dlp (supports many video platforms)
            </div>
          </div>
        </div>
        <div class="source-note">
          Search or play any YouTube URL directly. High-quality audio extraction.
        </div>
      </div>

      <div class="account-card">
        <div class="account-header">
          <Icon icon="mdi:cloud-outline" class="account-icon" />
          <div class="account-info">
            <div class="account-name">Stream</div>
            <div class="account-status logged">
              Direct HTTP/Icecast URLs — play with <code>!play -s &lt;url&gt;</code> or just paste a stream URL
            </div>
          </div>
        </div>
        <div class="source-note">
          Spotify/Tidal play through an optional external bridge (set the bridge URL on the server). Direct stream URLs work without one.
        </div>
      </div>
    </section>

    <!-- Command Prefix -->
    <section class="settings-section">
      <h2 class="section-title">Command Prefix</h2>
      <div class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:console" class="setting-icon" />
          Command Prefix
        </div>
        <div class="prefix-input-wrap">
          <input v-model="commandPrefix" class="input input-sm" placeholder="!" />
          <button class="btn-primary" @click="savePrefix">Save</button>
        </div>
      </div>
    </section>
    
    <!-- Idle Timeout -->
    <section class="settings-section">
      <h2 class="section-title">Behavior</h2>
      <div class="setting-row">
        <div class="setting-label">
          <Icon icon="mdi:timer-off-outline" class="setting-icon" />
          <div>
            <div>Auto-disconnect when idle</div>
            <div style="font-size:12px; opacity:0.6; margin-top:2px">Time to wait before the bot disconnects when no users are in the channel (0 = never disconnect)</div>
          </div>
        </div>
        <div class="prefix-input-wrap">
          <input
            v-model.number="idleTimeout"
            type="number"
            min="0"
            class="input input-sm"
            style="max-width:80px"
            placeholder="0"
          />
          <span style="font-size:13px; opacity:0.7">min</span>
          <button class="btn-primary" @click="saveIdleTimeout">Save</button>
        </div>
      </div>
    </section>

    <!-- AI & Permissions (admin only) -->
    <section v-if="session.isAdmin.value" class="settings-section">
      <h2 class="section-title">AI &amp; Permissions</h2>

      <!-- LLM toggle -->
      <label class="profile-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">
            <Icon icon="mdi:robot-outline" class="setting-icon" /> AI assistant
          </div>
          <div class="profile-toggle-hint">Enables <code>!ask</code> Q&amp;A and natural-language music control. Point at any OpenAI-compatible endpoint — local ollama/RKLLama on the Pi, or a remote GPU box.</div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.llmEnabled" />
      </label>

      <div v-if="ai.llmEnabled" class="form-group" style="margin: 8px 0 4px">
        <label>Endpoint preset</label>
        <div class="preset-row">
          <select v-model="ai.llmPreset" class="input" @change="applyLlmPreset">
            <option value="custom">Custom</option>
            <option value="local_ollama">Local — ollama (Orange Pi, recommended)</option>
            <option value="local_rkllama">Local — RKLLama (NPU, Qwen-only legacy)</option>
            <option value="remote_chat_local_embed">Remote chat (LAN) + local embeddings (Pi)</option>
            <option value="remote_gpu">Remote GPU server (chat + embeddings)</option>
          </select>
        </div>
        <div class="profile-toggle-hint">Presets fill chat + embedding URLs below. Remote path is ideal for heavy RAG over large doctrine corpora.</div>
      </div>

      <div v-if="ai.llmEnabled" class="form-row" style="margin: 8px 0 4px">
        <div class="form-group" style="flex:2">
          <label>Chat completions URL</label>
          <input v-model="ai.llmUrl" class="input" placeholder="http://ollama:11434" @input="ai.llmPreset = 'custom'" />
        </div>
        <div class="form-group" style="flex:1">
          <label>Chat model</label>
          <input v-model="ai.llmModel" class="input" placeholder="hf.co/unsloth/gemma-4-…" @input="ai.llmPreset = 'custom'" />
        </div>
      </div>

      <div v-if="ai.llmEnabled" class="form-row" style="margin: 4px 0">
        <div class="form-group" style="flex:2">
          <label>Fallback chat URL <span style="opacity:.6">(optional — Pi ollama when primary is down)</span></label>
          <input v-model="ai.llmFallbackUrl" class="input" placeholder="http://ollama:11434" @input="ai.llmPreset = 'custom'" />
        </div>
        <div class="form-group" style="flex:1">
          <label>Fallback model</label>
          <input v-model="ai.llmFallbackModel" class="input" placeholder="hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL" @input="ai.llmPreset = 'custom'" />
        </div>
      </div>

      <div v-if="ai.llmEnabled" class="form-row" style="margin: 4px 0">
        <div class="form-group" style="flex:2">
          <label>Delegate analyst URL <span style="opacity:.6">(optional — heavy model for !analyst)</span></label>
          <input v-model="ai.llmDelegateUrl" class="input" placeholder="http://analyst-host:11434" @input="ai.llmPreset = 'custom'" />
        </div>
        <div class="form-group" style="flex:1">
          <label>Delegate model</label>
          <input v-model="ai.llmDelegateModel" class="input" placeholder="hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL" @input="ai.llmPreset = 'custom'" />
        </div>
      </div>

      <div v-if="ai.llmEnabled" class="form-row" style="margin: 4px 0">
        <div class="form-group" style="flex:2">
          <label>System prompt <span style="opacity:.6">(optional — persona / reply language)</span></label>
          <textarea v-model="ai.llmSystemPrompt" class="input" rows="3" placeholder="Leave blank for the built-in default. e.g. 'You are Moneypenny. Always respond in English.'"></textarea>
        </div>
        <div class="form-group" style="flex:1">
          <label>Temperature</label>
          <input v-model.number="ai.llmTemperature" type="number" min="0" max="2" step="0.1" class="input" />
          <div class="profile-toggle-hint">0 = focused, higher = more varied (0–2).</div>
        </div>
      </div>

      <!-- LLM live status + test box -->
      <div v-if="ai.llmEnabled" class="llm-status-card">
        <div class="llm-status-row">
          <span
            class="llm-dot"
            :class="llm.available ? 'ok' : (llm.configured ? 'warn' : 'off')"
          ></span>
          <span class="llm-status-text">
            {{ llmStatusLabel }}
          </span>
          <button class="btn-sm" :disabled="llm.checking" @click="refreshLlmStatus">
            {{ llm.checking ? 'Checking…' : 'Check' }}
          </button>
        </div>
        <div class="llm-test-row">
          <input
            v-model="llm.question"
            class="input"
            placeholder="Ask the AI a test question…"
            @keyup.enter="testAsk"
          />
          <button class="btn-primary" :disabled="llm.asking || !llm.question.trim()" @click="testAsk">
            {{ llm.asking ? 'Asking…' : 'Ask' }}
          </button>
        </div>
        <p v-if="llm.answer" class="llm-answer">{{ llm.answer }}</p>
        <p v-if="llm.error" class="user-error">{{ llm.error }}</p>
        <p class="profile-toggle-hint">Save changes above before testing — the test uses the running bot's current LLM config.</p>
      </div>

      <!-- Rank gating toggle -->
      <label class="profile-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">
            <Icon icon="mdi:shield-account-outline" class="setting-icon" /> Rank gating
          </div>
          <div class="profile-toggle-hint">
            Restrict commands by TeamSpeak server-group. When on with no admin groups set, admin commands (stop/clear/move/vol/mode/remove/follow) are denied to everyone.
          </div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.rightsEnabled" />
      </label>

      <div v-if="ai.rightsEnabled" class="rights-panel">
        <div class="form-group">
          <label>Rules mode</label>
          <select v-model="ai.rightsMode" class="input">
            <option value="simple">Simple (admin server-groups)</option>
            <option value="advanced">Advanced (custom JSON rules)</option>
          </select>
        </div>

        <div v-if="ai.rightsMode === 'simple'" class="form-group">
          <label>Admin server-group IDs (comma-separated)</label>
          <input v-model="ai.adminGroupsText" class="input" placeholder="e.g. 105, 106" />
          <div class="profile-toggle-hint" style="margin-top:4px">Members of these server-groups may use admin commands. Everyone keeps public commands.</div>
        </div>

        <div v-else class="form-group">
          <label>Rights rules JSON</label>
          <textarea v-model="ai.rightsJson" class="input rights-json" rows="12" spellcheck="false" placeholder='{"defaultAllow":["play"],"rules":[...]}' />
          <div class="profile-toggle-hint">Ordered rules with <code>match</code>, <code>allow</code>, <code>deny</code>, and optional <code>scope</code> (<code>voice</code> | <code>chat</code> | <code>both</code>). Use <code>@groupName</code> tokens.</div>
          <button type="button" class="btn-sm" style="margin-top:8px" @click="resetRightsTemplate">Load example template</button>
        </div>

        <div class="rights-debug-card">
          <div class="profile-toggle-label" style="margin-bottom:8px">
            <Icon icon="mdi:shield-search" class="setting-icon" /> Rights debugger
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>User UID (optional)</label>
              <input v-model="rightsDebug.uid" class="input" placeholder="TeamSpeak unique id" />
            </div>
            <div class="form-group">
              <label>Server groups (optional)</label>
              <input v-model="rightsDebug.groups" class="input" placeholder="e.g. 105, 106" />
            </div>
          </div>
          <button type="button" class="btn-sm" :disabled="rightsDebug.busy" @click="runRightsDebug">
            {{ rightsDebug.busy ? 'Checking…' : 'Test effective rights' }}
          </button>
          <div v-if="rightsDebug.result" class="rights-debug-result">
            <p><strong>Subject:</strong> {{ rightsDebug.result.subject.uid }}
              <span v-if="rightsDebug.result.subject.nickname"> ({{ rightsDebug.result.subject.nickname }})</span>
              — groups: {{ rightsDebug.result.subject.serverGroups.join(', ') || 'none' }}
            </p>
            <p><strong>Chat:</strong> <code>{{ rightsDebug.result.chat.join(', ') }}</code></p>
            <p><strong>Voice:</strong> <code>{{ rightsDebug.result.voice.join(', ') }}</code></p>
          </div>
          <p v-if="rightsDebug.error" class="user-error">{{ rightsDebug.error }}</p>
        </div>
      </div>

      <label class="profile-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">
            <Icon icon="mdi:fire" class="setting-icon" /> Roast (community layer)
          </div>
          <div class="profile-toggle-hint">
            Capture members' chat lines, let the AI cringe-grade them, and auto-post a "greatest hits" reel when enough people are present. Requires the AI assistant. Members can opt out + purge with <code>!roastout</code>; <code>!roast</code> shows the current reel.
          </div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.roastEnabled" />
      </label>

      <div v-if="ai.roastEnabled" class="form-row" style="margin: 8px 0 4px">
        <div class="form-group">
          <label>Min. people present to auto-fire</label>
          <input v-model.number="ai.roastMinPresent" type="number" min="1" step="1" class="input" />
        </div>
        <div class="form-group">
          <label>Cooldown (minutes)</label>
          <input v-model.number="ai.roastCooldownMinutes" type="number" min="0" step="1" class="input" />
        </div>
        <div class="form-group">
          <label>Min. score for reel (0–10)</label>
          <input v-model.number="ai.roastMinScore" type="number" min="0" max="10" step="1" class="input" />
        </div>
      </div>

      <label class="profile-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">
            <Icon icon="mdi:youtube" class="setting-icon" /> Save YouTube to library
          </div>
          <div class="profile-toggle-hint">
            When a YouTube link is played, also download it as a tagged MP3 into your local library (cover art + title/artist), deduped by video ID so the same video is never re-downloaded. Replays then play the saved copy. Off by default — downloading is against YouTube's ToS (a self-hosted call).
          </div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.youtubeSaveEnabled" />
      </label>

      <label class="profile-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">
            <Icon icon="mdi:book-search-outline" class="setting-icon" /> Knowledge base (RAG)
          </div>
          <div class="profile-toggle-hint">
            Retrieve relevant chunks from ingested docs and feed them to <code>!ask</code> so Moneypenny can answer from your knowledge base. Requires the AI assistant + the vector DB sidecar (<code>--profile rag</code>). Upload doctrine in <strong>Library</strong>. Enabling needs a restart if it was off at boot.
          </div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.ragEnabled" />
      </label>

      <div v-if="ai.ragEnabled" class="form-row" style="margin: 8px 0 4px">
        <div class="form-group">
          <label>Chunks to retrieve (top-k)</label>
          <input v-model.number="ai.ragTopK" type="number" min="1" step="1" class="input" />
        </div>
      </div>

      <div v-if="ai.ragEnabled" class="rag-substrate-card">
        <div class="profile-toggle-label" style="margin-bottom:8px">
          <Icon icon="mdi:database-cog-outline" class="setting-icon" /> RAG substrate
        </div>
        <p class="profile-toggle-hint" style="margin:0 0 10px">
          Vector DB + embeddings endpoints. Changing these requires a <strong>bot restart</strong> (with <code>--profile rag</code>).
          Chat model can differ from embedding model — point embeddings at the same host as chat, or a dedicated GPU box.
        </p>
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>Vector DB URL (Qdrant)</label>
            <input v-model="ai.vectorDbUrl" class="input" placeholder="http://qdrant:6333" />
          </div>
          <div class="form-group" style="flex:1">
            <label>Collection name</label>
            <input v-model="ai.ragCollection" class="input" placeholder="moneypenny_docs" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>Embeddings URL</label>
            <input v-model="ai.embeddingUrl" class="input" placeholder="http://ollama:11434 (defaults to chat URL)" />
          </div>
          <div class="form-group" style="flex:1">
            <label>Embedding model</label>
            <input v-model="ai.embeddingModel" class="input" placeholder="embeddinggemma" />
          </div>
        </div>
      </div>

      <div v-if="ai.ragEnabled" class="llm-status-card">
        <div class="llm-status-row">
          <span
            class="llm-dot"
            :class="rag.available ? 'ok' : (rag.configured ? 'warn' : 'off')"
          />
          <span class="llm-status-text">
            {{ rag.available
              ? `Substrate OK — ${rag.docCount} doc${rag.docCount === 1 ? '' : 's'} · embed: ${rag.embeddingModel || 'default'}`
              : (rag.configured ? 'Enabled but substrate unreachable (restart with --profile rag?)' : 'Disabled') }}
          </span>
          <button class="btn-sm" :disabled="rag.checking" @click="refreshRagStatus">
            {{ rag.checking ? 'Checking…' : 'Check' }}
          </button>
        </div>
        <div class="llm-test-row">
          <input
            v-model="rag.question"
            class="input"
            style="flex:1"
            placeholder="Test retrieval query…"
            @keyup.enter="testRagQuery"
          />
          <button class="btn-primary" :disabled="rag.querying || !rag.question.trim()" @click="testRagQuery">
            {{ rag.querying ? 'Querying…' : 'Query' }}
          </button>
        </div>
        <div class="form-group" style="margin-top:8px">
          <label>Classification filter (optional, comma-separated)</label>
          <input v-model="rag.classifications" class="input" placeholder="e.g. unclassified, secret" />
        </div>
        <div v-if="rag.chunks.length > 0" class="rag-results">
          <div v-for="(chunk, i) in rag.chunks" :key="i" class="rag-chunk">
            <div class="rag-chunk-meta">
              <span class="rag-chunk-source">{{ chunk.source }}</span>
              <span class="rag-chunk-score">{{ (chunk.score * 100).toFixed(1) }}% match</span>
              <span class="rag-chunk-class">{{ chunk.classification }}</span>
            </div>
            <p class="rag-chunk-text">{{ chunk.text }}</p>
          </div>
        </div>
        <p v-if="rag.emptyResult" class="profile-toggle-hint">No chunks matched — try a different query or upload doctrine in Library.</p>
        <p v-if="rag.error" class="user-error">{{ rag.error }}</p>
        <p class="profile-toggle-hint">Save top-k above before testing — uses the running bot's current RAG config.</p>
      </div>

      <label class="profile-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">
            <Icon icon="mdi:brain" class="setting-icon" /> Per-user memory
          </div>
          <div class="profile-toggle-hint">
            Weave each member's <code>!remember</code>-ed facts into their <code>!ask</code> answers, so Moneypenny recalls who they are. Facts are stored either way; this only gates injection. Off by default.
          </div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.memoryEnabled" />
      </label>

      <label class="profile-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">
            <Icon icon="mdi:castle" class="setting-icon" /> MemPalace (semantic memory)
          </div>
          <div class="profile-toggle-hint">
            Sync <code>!remember</code> facts to a MemPalace sidecar for semantic recall in <code>!ask</code>. SQLite keeps a local copy either way. Docker: <code>docker compose --profile memory up -d</code>
          </div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.mempalaceEnabled" />
      </label>

      <div v-if="ai.mempalaceEnabled" class="form-group" style="margin: 8px 0 4px">
        <label>MemPalace bridge URL</label>
        <input v-model="ai.mempalaceUrl" class="input" placeholder="http://mempalace-bridge:8090" />
      </div>
      <div v-if="ai.mempalaceEnabled && ai.mempalaceUrl.trim()" class="llm-status-card">
        <div class="llm-status-row">
          <span
            class="llm-dot"
            :class="memPalace.available ? 'ok' : (memPalace.configured ? 'warn' : 'off')"
          />
          <span class="llm-status-text">
            {{ memPalace.available
              ? 'MemPalace bridge reachable'
              : (memPalace.configured ? 'Configured but unreachable' : 'Not checked') }}
          </span>
          <button class="btn-sm" :disabled="memPalace.checking" @click="refreshMemPalaceStatus">
            {{ memPalace.checking ? 'Checking…' : 'Check' }}
          </button>
          <button
            class="btn-sm"
            :disabled="memPalace.syncing || !memPalace.available"
            @click="syncMemPalace"
            title="Copy all SQLite !remember facts into MemPalace (safe to re-run)"
          >
            {{ memPalace.syncing ? 'Syncing…' : 'Sync SQLite → MemPalace' }}
          </button>
        </div>
        <p v-if="memPalace.syncMsg" class="profile-toggle-hint">{{ memPalace.syncMsg }}</p>
      </div>

      <label class="profile-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">
            <Icon icon="mdi:folder-upload" class="setting-icon" /> File drop (TeamSpeak)
          </div>
          <div class="profile-toggle-hint">
            Watch a TeamSpeak channel named <code>moneypenny-drop</code> and auto-ingest files dropped into its file browser: <code>.md</code>/<code>.markdown</code> → the knowledge base, audio → the music library. Create that channel and restrict who can upload to it — the uploader's frontmatter sets a doc's classification. Off by default.
          </div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.fileDropEnabled" />
      </label>

      <div v-if="ai.fileDropEnabled" class="form-row" style="margin: 8px 0 4px">
        <div class="form-group">
          <label>Poll interval (seconds)</label>
          <input v-model.number="ai.fileDropPollSec" type="number" min="5" step="1" class="input" />
        </div>
      </div>

      <div class="form-group" style="margin-top: 16px">
        <label>
          <Icon icon="mdi:spotify" class="setting-icon" /> Stream bridge URL
        </label>
        <input v-model="ai.streamBridgeUrl" class="input" placeholder="http://tidal-bridge:8081" />
        <div class="profile-toggle-hint">
          Optional sidecar for real Spotify/Tidal streaming. Without it, links resolve to Local/YouTube instead.
          Docker: <code>docker compose --profile stream up -d</code>
        </div>
      </div>
      <div v-if="ai.streamBridgeUrl.trim()" class="llm-status-card">
        <div class="llm-status-row">
          <span
            class="llm-dot"
            :class="bridge.available ? (bridge.loggedIn ? 'ok' : 'warn') : 'off'"
          />
          <span class="llm-status-text">
            {{ bridge.available
              ? (bridge.loggedIn ? 'Bridge reachable and logged in' : 'Bridge up — Tidal login pending (see bridge logs)')
              : (bridge.configured ? 'Configured but unreachable' : 'Not checked') }}
          </span>
          <button class="btn-sm" :disabled="bridge.checking" @click="refreshBridgeStatus">
            {{ bridge.checking ? 'Checking…' : 'Check' }}
          </button>
        </div>
      </div>

      <label class="profile-toggle">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">
            <Icon icon="mdi:microphone" class="setting-icon" /> Voice loop (Phase 2)
          </div>
          <div class="profile-toggle-hint">
            Inbound voice → STT → the same control router → optional TTS reply. Say the <strong>watchword</strong> first (default <code>Moneypenny</code>), e.g. “Moneypenny, pause”. Requires sherpa-onnx STT and Kokoro TTS sidecars (<code>--profile voice</code>).
          </div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.voiceEnabled" />
      </label>

      <div v-if="ai.voiceEnabled" class="form-row" style="margin: 8px 0 4px">
        <div class="form-group">
          <label>STT URL (sherpa-onnx)</label>
          <input v-model="ai.voiceSttUrl" class="input" placeholder="http://sherpa-stt:9000" />
        </div>
        <div class="form-group">
          <label>TTS URL (Kokoro)</label>
          <input v-model="ai.voiceTtsUrl" class="input" placeholder="http://kokoro:8880" />
        </div>
        <div class="form-group">
          <label>TTS voice</label>
          <input v-model="ai.voiceTtsVoice" class="input" placeholder="bf_emma" />
        </div>
        <div class="form-group">
          <label>Watchword</label>
          <input v-model="ai.voiceWatchword" class="input" placeholder="moneypenny" />
        </div>
      </div>
      <label v-if="ai.voiceEnabled" class="profile-toggle" style="margin-top: 4px">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">Require watchword</div>
          <div class="profile-toggle-hint">When on, only utterances containing the watchword are routed (recommended).</div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.voiceRequireWatchword" />
      </label>
      <label v-if="ai.voiceEnabled" class="profile-toggle" style="margin-top: 4px">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">Duck music while listening</div>
          <div class="profile-toggle-hint">Pauses bot playback when you speak so channel audio does not drown out STT.</div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.voiceDuckMusicOnSpeech" />
      </label>
      <label v-if="ai.voiceEnabled" class="profile-toggle" style="margin-top: 4px">
        <div class="profile-toggle-text">
          <div class="profile-toggle-label">Speak replies (TTS)</div>
          <div class="profile-toggle-hint">When off, voice commands still work but replies go to chat only.</div>
        </div>
        <input type="checkbox" class="profile-toggle-switch" v-model="ai.voiceRespondWithVoice" />
      </label>

      <div v-if="ai.voiceEnabled" class="llm-status-card">
        <div class="llm-status-row">
          <span
            class="llm-dot"
            :class="voicePanel.active && voicePanel.sttAvailable ? 'ok' : (voicePanel.enabled ? 'warn' : 'off')"
          />
          <span class="llm-status-text">
            {{ voicePanel.active && voicePanel.sttAvailable
              ? `Pipeline active — STT ${voicePanel.sttAvailable ? 'OK' : 'down'} · TTS ${voicePanel.ttsAvailable ? 'OK' : (ai.voiceTtsUrl.trim() ? 'down' : 'off')}`
              : (voicePanel.enabled ? 'Enabled but pipeline inactive or STT unreachable' : 'Disabled') }}
          </span>
          <button class="btn-sm" :disabled="voicePanel.checking" @click="refreshVoiceStatus">
            {{ voicePanel.checking ? 'Checking…' : 'Check' }}
          </button>
        </div>
        <div class="llm-test-row">
          <input
            v-model="voicePanel.transcript"
            class="input"
            style="flex:1"
            placeholder="Synthetic transcript (e.g. Moneypenny pause)…"
            @keyup.enter="testVoiceTurn"
          />
          <button class="btn-primary" :disabled="voicePanel.testing || !voicePanel.transcript.trim()" @click="testVoiceTurn">
            {{ voicePanel.testing ? 'Testing…' : 'Test' }}
          </button>
        </div>
        <p v-if="voicePanel.reply" class="llm-answer">
          <strong>Reply:</strong> {{ voicePanel.reply }}
          <span v-if="voicePanel.ttsBytes > 0" class="profile-toggle-hint"> · TTS {{ voicePanel.ttsBytes }} bytes</span>
        </p>
        <p v-if="voicePanel.error" class="user-error">{{ voicePanel.error }}</p>
        <p class="profile-toggle-hint">
          Smoke test routes a transcript through the control router (no Opus capture). Save settings first — needs an active bot connection.
          Dev STT: <code>docker compose --profile voice up -d</code> then <code>http://sherpa-stt:9000</code> (mock: <code>--profile voice-dev</code> on port 9001).
        </p>
      </div>

      <p v-if="aiError" class="user-error">{{ aiError }}</p>
      <p v-if="aiSuccess" class="user-success">{{ aiSuccess }}</p>
      <button class="btn-primary" style="margin-top: 12px" :disabled="savingAi" @click="saveAiSettings">
        {{ savingAi ? 'Saving…' : 'Save AI & Permissions' }}
      </button>
    </section>

    <!-- Bot Profile (TeamSpeak Behavior) -->
    <section class="settings-section">
      <h2 class="section-title">Bot Profile (TeamSpeak Behavior)</h2>
      <p class="profile-section-hint">Control how the bot automatically syncs song information on TeamSpeak. ⚠️ Items marked with warning will trigger notification sounds for everyone in the channel.</p>
      <div v-if="store.bots.length === 0" class="empty-hint">No bots yet — create one above first.</div>
      <div v-else class="profile-bot-list">
        <div v-for="bot in store.bots" :key="bot.id" class="profile-bot">
          <button
            class="profile-bot-header"
            :class="{ expanded: profileExpanded[bot.id] }"
            @click="toggleProfileExpanded(bot.id)"
          >
            <Icon :icon="profileExpanded[bot.id] ? 'mdi:chevron-down' : 'mdi:chevron-right'" />
            <span class="profile-bot-name">{{ bot.name }}</span>
          </button>
          <div v-if="profileExpanded[bot.id]" class="profile-toggles">
            <div v-if="profileLoadError[bot.id]" class="profile-loading profile-error">
              {{ profileLoadError[bot.id] }}
              <button class="btn-link" @click="loadProfileConfig(bot.id)">Retry</button>
            </div>
            <div v-else-if="!profileConfigs[bot.id]" class="profile-loading">Loading…</div>
            <label
              v-else
              v-for="t in PROFILE_TOGGLES"
              :key="t.key"
              class="profile-toggle"
            >
              <div class="profile-toggle-text">
                <div class="profile-toggle-label">
                  {{ t.label }}
                  <span v-if="t.warning" class="profile-warn-tag">⚠️ {{ t.warning }}</span>
                </div>
                <div class="profile-toggle-hint">{{ t.hint }}</div>
              </div>
              <input
                type="checkbox"
                class="profile-toggle-switch"
                :checked="profileConfigs[bot.id][t.key]"
                @change="updateProfile(bot.id, t.key, ($event.target as HTMLInputElement).checked)"
              />
            </label>
            <div v-if="profileConfigs[bot.id]" class="profile-toggle profile-toggle-static">
              <div class="profile-toggle-text">
                <div class="profile-toggle-label">Custom Avatar</div>
                <div class="profile-toggle-hint">This image is shown whenever playback is stopped, regardless of cover sync.</div>
              </div>
              <CustomAvatarRow :bot-id="bot.id" />
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- User Management -->
    <section v-if="session.isAdmin.value" class="settings-section">
      <h2 class="section-title">User Management</h2>
      <div class="user-list">
        <div v-for="u in userList" :key="u.id" class="user-item">
          <div class="user-info">
            <div class="user-name">
              {{ u.username }}
              <span class="user-role-badge" :class="`role-${u.role}`">
                {{ u.role === 'admin' ? 'Admin' : 'Member' }}
              </span>
              <span v-if="session.currentUser.value && u.id === session.currentUser.value.id" class="user-self-badge">You</span>
            </div>
            <div class="user-created">Created {{ formatDate(u.createdAt) }}</div>
          </div>
          <div class="user-actions">
            <button class="btn-sm" @click="openResetPassword(u)">
              <Icon icon="mdi:lock-reset" /> Reset Password
            </button>
            <button
              class="btn-sm"
              :disabled="changingRoleId === u.id || isLastAdmin(u)"
              :title="isLastAdmin(u) ? 'Cannot demote the only admin' : (u.role === 'admin' ? 'Demote to Member' : 'Promote to Admin')"
              @click="onToggleRole(u)"
            >
              <Icon icon="mdi:account-cog" />
              {{ u.role === 'admin' ? 'Demote to Member' : 'Promote to Admin' }}
            </button>
            <button
              class="btn-sm btn-delete"
              :disabled="!!(session.currentUser.value && u.id === session.currentUser.value.id) || isLastAdmin(u)"
              :title="session.currentUser.value && u.id === session.currentUser.value.id ? 'Cannot delete yourself' : (isLastAdmin(u) ? 'Cannot delete the only admin' : '')"
              @click="onDeleteUser(u)"
            >
              <Icon icon="mdi:delete" />
            </button>
          </div>
        </div>
        <div v-if="userList.length === 0 && !userLoadError" class="user-empty">Loading…</div>
        <div v-if="userLoadError" class="user-error">{{ userLoadError }}</div>
      </div>

      <form class="user-add-form" @submit.prevent="onCreateUser">
        <input v-model="newUser.username" class="input" placeholder="New username (3-32 chars)" required />
        <input v-model="newUser.password" type="password" class="input" placeholder="Password (min 8 chars)" minlength="8" required />
        <select v-model="newUser.role" class="input user-role-select">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button class="btn-sm btn-primary" type="submit" :disabled="creatingUser">
          {{ creatingUser ? 'Creating…' : 'Add User' }}
        </button>
      </form>
      <p v-if="userMutationError" class="user-error">{{ userMutationError }}</p>

      <!-- Reset password modal -->
      <div v-if="resetTarget" class="edit-modal-overlay" @click.self="resetTarget = null">
        <div class="edit-modal">
          <h3 class="modal-title">Reset password for {{ resetTarget.username }}</h3>
          <p class="modal-hint">All sessions for this user will be forcefully logged out.</p>
          <div class="form-group">
            <label>New password (min 8 chars)</label>
            <input v-model="resetPassword" type="password" class="input" minlength="8" />
          </div>
          <p v-if="resetError" class="user-error">{{ resetError }}</p>
          <div class="form-actions">
            <button class="btn-sm" @click="resetTarget = null">Cancel</button>
            <button class="btn-sm btn-primary" :disabled="resettingPw" @click="onConfirmReset">
              {{ resettingPw ? 'Saving…' : 'Confirm Reset' }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Audit Log -->
    <section v-if="session.isAdmin.value" class="settings-section">
      <h2 class="section-title">
        Audit Log
        <button class="audit-refresh-btn" @click="loadAudit" :disabled="auditLoading" title="Refresh">
          <Icon icon="mdi:refresh" :class="{ spinning: auditLoading }" />
        </button>
      </h2>
      <div v-if="auditLoadError" class="user-error">{{ auditLoadError }}</div>
      <div v-else-if="auditEntries.length === 0 && !auditLoading" class="user-empty">No audit records yet</div>
      <div v-else class="audit-list">
        <div v-for="e in auditEntries" :key="e.id" class="audit-row">
          <div class="audit-time">{{ formatDateTime(e.timestamp) }}</div>
          <div class="audit-actor">{{ e.actorUsername ?? '—' }}</div>
          <div class="audit-action" :class="auditActionClass(e.action)">{{ describeAction(e) }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import api from '../api/axios.js';
import AvatarUpload from '../components/AvatarUpload.vue';
import CustomAvatarRow from '../components/CustomAvatarRow.vue';
import { usePlayerStore } from '../stores/player.js';
import { useSession } from '../composables/useSession.js';

const store = usePlayerStore();

function botStatusClass(bot: any) {
  if (!bot.connected) return 'offline';
  if (bot.playing) return 'playing';
  if (bot.paused) return 'paused';
  return 'online';
}

function botStatusText(bot: any) {
  if (!bot.connected) return 'Offline';
  if (bot.playing) return 'Playing';
  if (bot.paused) return 'Paused';
  return 'Online';
}

const newBotName = ref('');
const newBotServer = ref('');
const newBotPort = ref(9987);
const newBotNickname = ref('Moneypenny');
const newBotChannel = ref('');
const newBotServerPassword = ref('');
const newBotAvatar = ref<string | null>(null);

// Edit bot
const editingBot = ref<string | null>(null);
const editForm = reactive({
  name: '',
  serverAddress: '',
  serverPort: 9987,
  nickname: '',
  defaultChannel: '',
  channelPassword: '',
  serverPassword: '',
});

const commandPrefix = ref('!');

async function createBot() {
  if (!newBotName.value || !newBotServer.value) return;
  try {
    const res = await api.post('/api/bot', {
      name: newBotName.value,
      serverAddress: newBotServer.value,
      serverPort: newBotPort.value || 9987,
      nickname: newBotNickname.value || newBotName.value,
      defaultChannel: newBotChannel.value || undefined,
      serverPassword: newBotServerPassword.value || undefined,
      autoStart: false,
    });
    if (newBotAvatar.value && res.data?.id) {
      try {
        await api.put(`/api/bot/${res.data.id}/avatar`, { dataUrl: newBotAvatar.value });
      } catch (err: any) {
        const playerStore = usePlayerStore();
        const msg = err?.response?.data?.message || err?.response?.data?.error || 'Failed to set avatar';
        playerStore.notify(msg, 'error');
      }
    }
    newBotName.value = '';
    newBotServer.value = '';
    newBotPort.value = 9987;
    newBotNickname.value = 'Moneypenny';
    newBotChannel.value = '';
    newBotServerPassword.value = '';
    newBotAvatar.value = null;
    await store.fetchBots();
  } catch (err: any) {
    const playerStore = usePlayerStore();
    const msg = err?.response?.data?.message || err?.response?.data?.error || 'Action failed';
    playerStore.notify(msg, 'error');
  }
}

async function deleteBot(botId: string, botName: string) {
  if (!confirm(`Delete bot "${botName}"? This cannot be undone.`)) return;
  try {
    await api.delete(`/api/bot/${botId}`);
    // If deleted bot was the active one, reset activeBotId
    if (store.activeBotId === botId) {
      store.activeBotId = null;
    }
    store.removeBotStatus(botId);
    await store.fetchBots();
  } catch (err: any) {
    const playerStore = usePlayerStore();
    const msg = err?.response?.data?.message || err?.response?.data?.error || 'Action failed';
    playerStore.notify(msg, 'error');
  }
}

async function openEditBot(bot: any) {
  editingBot.value = bot.id;
  editForm.name = bot.name;
  // Fetch saved config to fill all fields
  try {
    const res = await api.get(`/api/bot/${bot.id}/config`);
    editForm.serverAddress = res.data.serverAddress ?? '';
    editForm.serverPort = res.data.serverPort ?? 9987;
    editForm.nickname = res.data.nickname ?? '';
    editForm.defaultChannel = res.data.defaultChannel ?? '';
    editForm.channelPassword = res.data.channelPassword ?? '';
    editForm.serverPassword = res.data.serverPassword ?? '';
  } catch (err: any) {
    // Config not found — use defaults
    if (err?.response?.status !== 404) {
      const playerStore = usePlayerStore();
      const msg = err?.response?.data?.message || err?.response?.data?.error || 'Failed to load bot config';
      playerStore.notify(msg, 'error');
    }
    editForm.serverAddress = '';
    editForm.serverPort = 9987;
    editForm.nickname = bot.name;
    editForm.defaultChannel = '';
    editForm.channelPassword = '';
    editForm.serverPassword = '';
  }
}

async function saveEditBot() {
  if (!editingBot.value) return;
  try {
    await api.put(`/api/bot/${editingBot.value}`, editForm);
    editingBot.value = null;
    await store.fetchBots();
  } catch (err: any) {
    const playerStore = usePlayerStore();
    const msg = err?.response?.data?.message || err?.response?.data?.error || 'Action failed';
    playerStore.notify(msg, 'error');
  }
}

async function toggleBot(botId: string, connected: boolean) {
  try {
    if (connected) {
      await api.post(`/api/bot/${botId}/stop`);
    } else {
      await api.post(`/api/bot/${botId}/start`);
    }
    await store.fetchBots();
  } catch (err: any) {
    const playerStore = usePlayerStore();
    const msg = err?.response?.data?.message || err?.response?.data?.error || 'Action failed';
    playerStore.notify(msg, 'error');
  }
}

async function savePrefix() {
  // Prefix is saved client-side for now
}

// Idle timeout
const idleTimeout = ref(0);

async function loadIdleTimeout() {
  try {
    const res = await api.get('/api/bot/settings');
    idleTimeout.value = res.data.idleTimeoutMinutes ?? 0;
  } catch (e) { console.error('Settings load/save failed', e); }
}

async function saveIdleTimeout() {
  try {
    await api.post('/api/bot/settings', { idleTimeoutMinutes: idleTimeout.value });
  } catch (e) { console.error('Settings load/save failed', e); }
}

// --- AI & Permissions (admin only) ---
type LlmPresetId = 'custom' | 'local_ollama' | 'local_rkllama' | 'remote_chat_local_embed' | 'remote_gpu';

const LLM_PRESETS: Record<LlmPresetId, {
  llmUrl: string;
  llmModel: string;
  llmFallbackUrl: string;
  llmFallbackModel: string;
  llmDelegateUrl: string;
  llmDelegateModel: string;
  embeddingUrl: string;
  embeddingModel: string;
}> = {
  custom: { llmUrl: '', llmModel: '', llmFallbackUrl: '', llmFallbackModel: '', llmDelegateUrl: '', llmDelegateModel: '', embeddingUrl: '', embeddingModel: '' },
  local_ollama: {
    llmUrl: 'http://ollama:11434',
    llmModel: 'hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL',
    llmFallbackUrl: '',
    llmFallbackModel: '',
    llmDelegateUrl: '',
    llmDelegateModel: '',
    embeddingUrl: 'http://ollama:11434',
    embeddingModel: 'embeddinggemma',
  },
  local_rkllama: {
    llmUrl: 'http://rkllama:8080',
    llmModel: 'qwen3-4b-instruct-2507',
    llmFallbackUrl: '',
    llmFallbackModel: '',
    llmDelegateUrl: '',
    llmDelegateModel: '',
    embeddingUrl: 'http://ollama:11434',
    embeddingModel: 'embeddinggemma',
  },
  remote_chat_local_embed: {
    llmUrl: 'http://gpu-host:11434',
    llmModel: 'hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL',
    llmFallbackUrl: 'http://ollama:11434',
    llmFallbackModel: 'hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL',
    llmDelegateUrl: 'http://gpu-host:11434',
    llmDelegateModel: 'hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL',
    embeddingUrl: 'http://ollama:11434',
    embeddingModel: 'embeddinggemma',
  },
  remote_gpu: {
    llmUrl: 'http://gpu-host:11434',
    llmModel: 'hf.co/unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL',
    llmFallbackUrl: 'http://ollama:11434',
    llmFallbackModel: 'hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL',
    llmDelegateUrl: 'http://gpu-host:11434',
    llmDelegateModel: 'hf.co/unsloth/gemma-4-31B-it-qat-GGUF:UD-Q4_K_XL',
    embeddingUrl: 'http://gpu-host:11434',
    embeddingModel: 'embeddinggemma',
  },
};

const ai = reactive({
  llmEnabled: false,
  llmPreset: 'custom' as LlmPresetId,
  llmUrl: '',
  llmModel: '',
  llmFallbackUrl: '',
  llmFallbackModel: '',
  llmDelegateUrl: '',
  llmDelegateModel: '',
  llmSystemPrompt: '',
  llmTemperature: 0.2,
  roastEnabled: false,
  roastMinPresent: 3,
  roastCooldownMinutes: 180,
  roastMinScore: 4,
  youtubeSaveEnabled: false,
  ragEnabled: false,
  ragTopK: 4,
  vectorDbUrl: '',
  embeddingUrl: '',
  embeddingModel: '',
  ragCollection: 'moneypenny_docs',
  memoryEnabled: false,
  mempalaceEnabled: false,
  mempalaceUrl: '',
  fileDropEnabled: false,
  fileDropPollSec: 30,
  rightsEnabled: false,
  adminGroupsText: '',
  rightsMode: 'simple' as 'simple' | 'advanced',
  rightsJson: '',
  streamBridgeUrl: '',
  voiceEnabled: false,
  voiceSttUrl: '',
  voiceTtsUrl: '',
  voiceTtsVoice: 'bf_emma',
  voiceWatchword: 'moneypenny',
  voiceRequireWatchword: true,
  voiceDuckMusicOnSpeech: true,
  voiceRespondWithVoice: true,
});
const rightsDebug = reactive({
  uid: '',
  groups: '',
  busy: false,
  error: '',
  result: null as null | {
    subject: { uid: string; serverGroups: string[]; nickname?: string };
    chat: string[];
    voice: string[];
  },
});
const bridge = reactive({
  configured: false,
  available: false,
  loggedIn: false,
  checking: false,
});
const memPalace = reactive({
  configured: false,
  available: false,
  checking: false,
  syncing: false,
  syncMsg: '',
});
const rag = reactive({
  configured: false,
  available: false,
  docCount: 0,
  topK: 4,
  embeddingModel: '',
  checking: false,
  question: '',
  classifications: '',
  chunks: [] as Array<{ text: string; source: string; score: number; classification: string }>,
  querying: false,
  error: '',
  emptyResult: false,
});
const voicePanel = reactive({
  enabled: false,
  active: false,
  sttAvailable: false,
  ttsAvailable: false,
  checking: false,
  transcript: 'skip',
  testing: false,
  reply: '',
  ttsBytes: 0,
  error: '',
});
const aiError = ref('');
const aiSuccess = ref('');
const savingAi = ref(false);

async function loadAiSettings() {
  try {
    const res = await api.get('/api/bot/settings');
    ai.llmEnabled = !!res.data.llmEnabled;
    ai.llmUrl = res.data.llmUrl ?? '';
    ai.llmModel = res.data.llmModel ?? '';
    ai.llmFallbackUrl = res.data.llmFallbackUrl ?? '';
    ai.llmFallbackModel = res.data.llmFallbackModel ?? '';
    ai.llmDelegateUrl = res.data.llmDelegateUrl ?? '';
    ai.llmDelegateModel = res.data.llmDelegateModel ?? '';
    ai.llmSystemPrompt = res.data.llmSystemPrompt ?? '';
    ai.llmTemperature = res.data.llmTemperature ?? 0.2;
    ai.roastEnabled = !!res.data.roastEnabled;
    ai.roastMinPresent = res.data.roastMinPresent ?? 3;
    ai.roastCooldownMinutes = res.data.roastCooldownMinutes ?? 180;
    ai.roastMinScore = res.data.roastMinScore ?? 4;
    ai.youtubeSaveEnabled = !!res.data.youtubeSaveEnabled;
    ai.ragEnabled = !!res.data.ragEnabled;
    ai.ragTopK = res.data.ragTopK ?? 4;
    ai.vectorDbUrl = res.data.vectorDbUrl ?? '';
    ai.embeddingUrl = res.data.embeddingUrl ?? '';
    ai.embeddingModel = res.data.embeddingModel ?? '';
    ai.ragCollection = res.data.ragCollection ?? 'moneypenny_docs';
    ai.llmPreset = detectLlmPreset();
    ai.memoryEnabled = !!res.data.memoryEnabled;
    ai.mempalaceEnabled = !!res.data.mempalaceEnabled;
    ai.mempalaceUrl = res.data.mempalaceUrl ?? '';
    ai.fileDropEnabled = !!res.data.fileDropEnabled;
    ai.fileDropPollSec = res.data.fileDropPollSec ?? 30;
    ai.rightsEnabled = !!res.data.rightsEnabled;
    ai.adminGroupsText = (res.data.adminGroups ?? []).join(', ');
    if (res.data.rights && typeof res.data.rights === 'object') {
      ai.rightsMode = 'advanced';
      ai.rightsJson = JSON.stringify(res.data.rights, null, 2);
    } else {
      ai.rightsMode = 'simple';
      ai.rightsJson = '';
    }
    ai.streamBridgeUrl = res.data.streamBridgeUrl ?? '';
    const voice = res.data.voice ?? {};
    ai.voiceEnabled = !!voice.enabled;
    ai.voiceSttUrl = voice.sttUrl ?? '';
    ai.voiceTtsUrl = voice.ttsUrl ?? '';
    ai.voiceTtsVoice = voice.ttsVoice ?? 'bf_emma';
    ai.voiceWatchword = voice.watchword ?? 'moneypenny';
    ai.voiceRequireWatchword = voice.requireWatchword !== false;
    ai.voiceDuckMusicOnSpeech = voice.duckMusicOnSpeech !== false;
    ai.voiceRespondWithVoice = voice.respondWithVoice !== false;
  } catch (e) { console.error('Settings load/save failed', e); }
  if (ai.llmEnabled) refreshLlmStatus();
  if (ai.ragEnabled) refreshRagStatus();
  if (ai.streamBridgeUrl.trim()) refreshBridgeStatus();
  if (ai.mempalaceEnabled && ai.mempalaceUrl.trim()) refreshMemPalaceStatus();
  if (ai.voiceEnabled) refreshVoiceStatus();
}

function detectLlmPreset(): LlmPresetId {
  for (const [id, preset] of Object.entries(LLM_PRESETS) as [LlmPresetId, typeof LLM_PRESETS.custom][]) {
    if (id === 'custom') continue;
    if (
      ai.llmUrl === preset.llmUrl
      && ai.llmModel === preset.llmModel
      && ai.llmFallbackUrl === preset.llmFallbackUrl
      && ai.llmFallbackModel === preset.llmFallbackModel
      && ai.llmDelegateUrl === preset.llmDelegateUrl
      && ai.llmDelegateModel === preset.llmDelegateModel
      && (ai.embeddingUrl || ai.llmUrl) === (preset.embeddingUrl || preset.llmUrl)
      && ai.embeddingModel === preset.embeddingModel
    ) {
      return id;
    }
  }
  return 'custom';
}

function applyLlmPreset() {
  const preset = LLM_PRESETS[ai.llmPreset];
  if (ai.llmPreset === 'custom') return;
  ai.llmUrl = preset.llmUrl;
  ai.llmModel = preset.llmModel;
  ai.llmFallbackUrl = preset.llmFallbackUrl;
  ai.llmFallbackModel = preset.llmFallbackModel;
  ai.llmDelegateUrl = preset.llmDelegateUrl;
  ai.llmDelegateModel = preset.llmDelegateModel;
  ai.embeddingUrl = preset.embeddingUrl;
  ai.embeddingModel = preset.embeddingModel;
}

async function refreshRagStatus() {
  rag.checking = true;
  try {
    const res = await api.get('/api/bot/rag/status');
    rag.configured = !!res.data.configured;
    rag.available = !!res.data.available;
    rag.docCount = res.data.docCount ?? 0;
    rag.topK = res.data.topK ?? ai.ragTopK;
    if (res.data.embeddingModel) rag.embeddingModel = res.data.embeddingModel;
  } catch {
    rag.configured = ai.ragEnabled;
    rag.available = false;
    rag.docCount = 0;
  } finally {
    rag.checking = false;
  }
}

async function testRagQuery() {
  if (!rag.question.trim()) return;
  rag.querying = true;
  rag.error = '';
  rag.chunks = [];
  rag.emptyResult = false;
  try {
    const allowedClassifications = rag.classifications
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await api.post('/api/bot/rag/query', {
      q: rag.question.trim(),
      topK: ai.ragTopK,
      ...(allowedClassifications.length > 0 ? { allowedClassifications } : {}),
    });
    rag.chunks = res.data.chunks ?? [];
    rag.emptyResult = rag.chunks.length === 0;
  } catch (e: any) {
    rag.error = e?.response?.data?.error ?? 'RAG query failed.';
  } finally {
    rag.querying = false;
  }
}

function resetRightsTemplate() {
  ai.rightsJson = JSON.stringify({
    defaultAllow: ['play', 'skip', 'pause', 'resume', 'now', 'ask', 'add'],
    commandGroups: { admin: ['stop', 'clear', 'vol', 'mode', 'remove', 'move', 'follow'] },
    superAdminUids: [],
    rules: [
      { name: 'admins', match: { serverGroups: ['105'] }, allow: ['@admin'] },
      { name: 'voice-stop-officers', match: { serverGroups: ['106'] }, allow: ['stop'], scope: 'voice' },
    ],
  }, null, 2);
}

async function runRightsDebug() {
  rightsDebug.busy = true;
  rightsDebug.error = '';
  rightsDebug.result = null;
  try {
    const params: Record<string, string> = {};
    if (rightsDebug.uid.trim()) params.uid = rightsDebug.uid.trim();
    if (rightsDebug.groups.trim()) params.groups = rightsDebug.groups.trim();
    const res = await api.get('/api/bot/rights/debug', { params });
    rightsDebug.result = res.data;
  } catch (e: any) {
    rightsDebug.error = e?.response?.data?.error ?? 'Rights debug failed.';
  } finally {
    rightsDebug.busy = false;
  }
}

async function refreshBridgeStatus() {
  bridge.checking = true;
  try {
    const res = await api.get('/api/bot/stream-bridge/status');
    bridge.configured = !!res.data.configured;
    bridge.available = !!res.data.available;
    bridge.loggedIn = !!res.data.loggedIn;
  } catch {
    bridge.configured = !!ai.streamBridgeUrl.trim();
    bridge.available = false;
    bridge.loggedIn = false;
  } finally {
    bridge.checking = false;
  }
}

async function refreshMemPalaceStatus() {
  memPalace.checking = true;
  try {
    const res = await api.get('/api/bot/memory/status');
    memPalace.configured = !!res.data.configured;
    memPalace.available = !!res.data.available;
  } catch {
    memPalace.configured = ai.mempalaceEnabled && !!ai.mempalaceUrl.trim();
    memPalace.available = false;
  } finally {
    memPalace.checking = false;
  }
}

async function syncMemPalace() {
  memPalace.syncing = true;
  memPalace.syncMsg = '';
  try {
    const res = await api.post('/api/bot/memory/sync');
    if (res.data.skipped) {
      memPalace.syncMsg = 'Enable MemPalace and set a bridge URL first.';
    } else {
      memPalace.syncMsg = `Synced ${res.data.synced ?? 0} fact(s)` +
        (res.data.failed ? `, ${res.data.failed} failed` : '') + '.';
    }
  } catch (err: any) {
    memPalace.syncMsg = err?.response?.data?.error ?? 'Sync failed.';
  } finally {
    memPalace.syncing = false;
  }
}

async function refreshVoiceStatus() {
  voicePanel.checking = true;
  try {
    const res = await api.get('/api/bot/voice/status');
    voicePanel.enabled = !!res.data.enabled;
    voicePanel.active = !!res.data.active;
    voicePanel.sttAvailable = !!res.data.sttAvailable;
    voicePanel.ttsAvailable = !!res.data.ttsAvailable;
  } catch {
    voicePanel.enabled = ai.voiceEnabled;
    voicePanel.active = false;
    voicePanel.sttAvailable = false;
    voicePanel.ttsAvailable = false;
  } finally {
    voicePanel.checking = false;
  }
}

async function testVoiceTurn() {
  if (!voicePanel.transcript.trim()) return;
  voicePanel.testing = true;
  voicePanel.error = '';
  voicePanel.reply = '';
  voicePanel.ttsBytes = 0;
  try {
    const res = await api.post('/api/bot/voice/test', {
      transcript: voicePanel.transcript.trim(),
      speak: false,
    });
    voicePanel.reply = res.data.reply ?? '(no reply)';
    voicePanel.ttsBytes = res.data.ttsBytes ?? 0;
  } catch (e: any) {
    voicePanel.error = e?.response?.data?.error ?? 'Voice test failed.';
  } finally {
    voicePanel.testing = false;
  }
}

// --- LLM live status + test box ---
const llm = reactive({
  configured: false,
  available: false,
  primaryAvailable: false,
  fallbackAvailable: false,
  fallbackConfigured: false,
  activeFallback: false,
  delegateConfigured: false,
  delegateAvailable: false,
  checking: false,
  question: '',
  answer: '',
  asking: false,
  error: '',
});

const llmStatusLabel = computed(() => {
  if (!llm.configured) return 'Not configured';
  if (llm.available && llm.activeFallback) return 'Reachable via Pi NPU fallback';
  if (llm.available && llm.fallbackConfigured && llm.primaryAvailable) {
    return 'Primary reachable (fallback ready)';
  }
  if (llm.available) return 'Reachable';
  if (llm.fallbackConfigured && llm.fallbackAvailable) return 'Primary down — fallback only';
  if (llm.delegateConfigured && !llm.delegateAvailable) return 'Primary OK — analyst node unreachable';
  if (llm.delegateConfigured && llm.delegateAvailable) return 'Primary + analyst reachable';
  return 'Configured but unreachable';
});

async function refreshLlmStatus() {
  llm.checking = true;
  try {
    const res = await api.get('/api/bot/llm/status');
    llm.configured = !!res.data.configured;
    llm.available = !!res.data.available;
    llm.primaryAvailable = !!res.data.primaryAvailable;
    llm.fallbackAvailable = !!res.data.fallbackAvailable;
    llm.fallbackConfigured = !!res.data.fallbackConfigured;
    llm.activeFallback = !!res.data.activeFallback;
    llm.delegateConfigured = !!res.data.delegateConfigured;
    llm.delegateAvailable = !!res.data.delegateAvailable;
  } catch (err: any) {
    const playerStore = usePlayerStore();
    const msg = err?.response?.data?.message || err?.response?.data?.error || 'Failed to test LLM';
    playerStore.notify(msg, 'error');
    llm.configured = false;
    llm.available = false;
  } finally {
    llm.checking = false;
  }
}

async function testAsk() {
  if (!llm.question.trim()) return;
  llm.asking = true;
  llm.answer = '';
  llm.error = '';
  try {
    const res = await api.post('/api/bot/llm/ask', { question: llm.question.trim() });
    llm.answer = res.data.answer ?? '';
  } catch (e: any) {
    llm.error = e?.response?.data?.error ?? 'Ask failed.';
  } finally {
    llm.asking = false;
  }
}

function parseAdminGroups(text: string): number[] | null {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0) return null;
    nums.push(n);
  }
  return nums;
}

async function saveAiSettings() {
  aiError.value = '';
  aiSuccess.value = '';
  let adminGroups: number[] = [];
  if (ai.rightsEnabled && ai.rightsMode === 'simple') {
    const parsed = parseAdminGroups(ai.adminGroupsText);
    if (parsed === null) {
      aiError.value = 'Admin server-group IDs must be non-negative integers separated by commas.';
      return;
    }
    adminGroups = parsed;
  } else if (ai.rightsEnabled && ai.rightsMode === 'advanced') {
    const parsed = parseAdminGroups(ai.adminGroupsText);
    adminGroups = parsed ?? [];
  }

  let rightsPayload: object | null | undefined = undefined;
  if (ai.rightsEnabled) {
    if (ai.rightsMode === 'advanced') {
      try {
        rightsPayload = JSON.parse(ai.rightsJson);
      } catch {
        aiError.value = 'Rights JSON is invalid — fix syntax before saving.';
        return;
      }
    } else {
      rightsPayload = null;
    }
  }

  savingAi.value = true;
  try {
    await api.post('/api/bot/settings', {
      llmEnabled: ai.llmEnabled,
      llmUrl: ai.llmUrl.trim(),
      llmModel: ai.llmModel.trim(),
      llmFallbackUrl: ai.llmFallbackUrl.trim(),
      llmFallbackModel: ai.llmFallbackModel.trim(),
      llmDelegateUrl: ai.llmDelegateUrl.trim(),
      llmDelegateModel: ai.llmDelegateModel.trim(),
      llmSystemPrompt: ai.llmSystemPrompt,
      llmTemperature: ai.llmTemperature,
      roastEnabled: ai.roastEnabled,
      roastMinPresent: ai.roastMinPresent,
      roastCooldownMinutes: ai.roastCooldownMinutes,
      roastMinScore: ai.roastMinScore,
      youtubeSaveEnabled: ai.youtubeSaveEnabled,
      ragEnabled: ai.ragEnabled,
      ragTopK: ai.ragTopK,
      vectorDbUrl: ai.vectorDbUrl.trim(),
      embeddingUrl: ai.embeddingUrl.trim(),
      embeddingModel: ai.embeddingModel.trim(),
      ragCollection: ai.ragCollection.trim() || 'moneypenny_docs',
      memoryEnabled: ai.memoryEnabled,
      mempalaceEnabled: ai.mempalaceEnabled,
      mempalaceUrl: ai.mempalaceUrl.trim(),
      fileDropEnabled: ai.fileDropEnabled,
      fileDropPollSec: ai.fileDropPollSec,
      rightsEnabled: ai.rightsEnabled,
      adminGroups,
      ...(rightsPayload !== undefined ? { rights: rightsPayload } : {}),
      streamBridgeUrl: ai.streamBridgeUrl.trim(),
      voice: {
        enabled: ai.voiceEnabled,
        respondWithVoice: ai.voiceRespondWithVoice,
        sttUrl: ai.voiceSttUrl.trim(),
        ttsUrl: ai.voiceTtsUrl.trim(),
        ttsVoice: ai.voiceTtsVoice.trim() || 'bf_emma',
        watchword: ai.voiceWatchword.trim() || 'moneypenny',
        requireWatchword: ai.voiceRequireWatchword,
        duckMusicOnSpeech: ai.voiceDuckMusicOnSpeech,
      },
    });
    aiSuccess.value = 'Saved. Applied to running bots.';
    if (ai.llmEnabled) refreshLlmStatus();
    if (ai.ragEnabled) refreshRagStatus();
    if (ai.streamBridgeUrl.trim()) refreshBridgeStatus();
    if (ai.mempalaceEnabled && ai.mempalaceUrl.trim()) refreshMemPalaceStatus();
  } catch (e: any) {
    aiError.value = e?.response?.data?.error ?? 'Failed to save settings.';
  } finally {
    savingAi.value = false;
  }
}

// --- Bot Profile config ---
interface ProfileConfig {
  avatarEnabled: boolean;
  descriptionEnabled: boolean;
  nicknameEnabled: boolean;
  awayStatusEnabled: boolean;
  channelDescEnabled: boolean;
  nowPlayingMsgEnabled: boolean;
}

const PROFILE_TOGGLES: ReadonlyArray<{
  key: keyof ProfileConfig;
  label: string;
  hint: string;
  warning: string | null;
}> = [
  { key: 'avatarEnabled',       label: 'Sync Avatar',           hint: 'Use the current album cover as the bot\'s avatar', warning: null },
  { key: 'descriptionEnabled',  label: 'Sync Description',      hint: 'Show the currently playing song in the bot\'s description', warning: null },
  { key: 'nicknameEnabled',     label: 'Sync Nickname',         hint: 'Update the bot\'s nickname to the song title', warning: null },
  { key: 'awayStatusEnabled',   label: 'Away Status',           hint: 'Set bot to "Away" when playback stops', warning: null },
  { key: 'channelDescEnabled',  label: 'Update Channel Description', hint: 'Write "Now Playing" info into the channel description', warning: 'Triggers edit notification sound for everyone' },
  { key: 'nowPlayingMsgEnabled',label: 'Post Now-Playing Message', hint: 'Send a text message in the channel when the song changes', warning: 'Triggers new message notification sound' },
];

const profileConfigs = reactive<Record<string, ProfileConfig>>({});
const profileExpanded = reactive<Record<string, boolean>>({});
const profileLoadError = reactive<Record<string, string | null>>({});

async function loadProfileConfig(botId: string) {
  if (profileConfigs[botId]) return;
  profileLoadError[botId] = null;
  try {
    const res = await api.get(`/api/player/${botId}/profile`);
    // Defensive: a 200 response with non-object body (empty / proxy
    // injection / etc.) would otherwise leave the row stuck on
    // "Loading…" because profileConfigs[botId] would be falsy.
    if (!res.data || typeof res.data !== 'object' || typeof res.data.avatarEnabled !== 'boolean') {
      profileLoadError[botId] = 'Unexpected response format';
      return;
    }
    profileConfigs[botId] = res.data;
  } catch (err: any) {
    profileLoadError[botId] = err?.response?.status === 404
      ? 'Bot not loaded'
      : 'Failed to load, please retry';
  }
}

function toggleProfileExpanded(botId: string) {
  profileExpanded[botId] = !profileExpanded[botId];
  if (profileExpanded[botId]) loadProfileConfig(botId);
}

async function updateProfile(botId: string, key: keyof ProfileConfig, value: boolean) {
  const cfg = profileConfigs[botId];
  if (!cfg) return;
  const prev = cfg[key];
  cfg[key] = value; // optimistic
  try {
    const res = await api.put(`/api/player/${botId}/profile`, { [key]: value });
    profileConfigs[botId] = res.data;
  } catch (err: any) {
    const playerStore = usePlayerStore();
    const msg = err?.response?.data?.message || err?.response?.data?.error || 'Failed to update profile';
    playerStore.notify(msg, 'error');
    cfg[key] = prev; // revert
  }
}

// --- User Management ---
const session = useSession();

// --- Own password change (available to all authenticated users) ---
const ownPw = reactive({ old: '', new: '', confirm: '' });
const ownPwError = ref('');
const ownPwSuccess = ref('');
const changingOwnPw = ref(false);

async function onChangeOwnPassword() {
  ownPwError.value = '';
  ownPwSuccess.value = '';
  if (ownPw.new !== ownPw.confirm) {
    ownPwError.value = 'New passwords do not match';
    return;
  }
  if (ownPw.new.length < 8) {
    ownPwError.value = 'New password must be at least 8 characters';
    return;
  }
  changingOwnPw.value = true;
  try {
    await api.post('/api/session/change-password', {
      oldPassword: ownPw.old,
      newPassword: ownPw.new,
    });
    ownPw.old = '';
    ownPw.new = '';
    ownPw.confirm = '';
    ownPwSuccess.value = 'Password updated';
    // The server kills other sessions but keeps the current one. No reload needed.
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } }; message?: string };
    ownPwError.value = err.response?.data?.error ?? err.message ?? 'Request failed';
  } finally {
    changingOwnPw.value = false;
  }
}

interface UserListEntry { id: string; username: string; createdAt: number; role: 'admin' | 'member' }
const userList = ref<UserListEntry[]>([]);
const userLoadError = ref('');
const userMutationError = ref('');
const newUser = reactive({ username: '', password: '', role: 'member' as 'admin' | 'member' });
const creatingUser = ref(false);
const resetTarget = ref<UserListEntry | null>(null);
const resetPassword = ref('');
const resetError = ref('');
const resettingPw = ref(false);
const changingRoleId = ref<string | null>(null);

function isLastAdmin(u: UserListEntry): boolean {
  if (u.role !== 'admin') return false;
  const adminCount = userList.value.filter((x) => x.role === 'admin').length;
  return adminCount <= 1;
}

async function onToggleRole(u: UserListEntry) {
  const newRole = u.role === 'admin' ? 'member' : 'admin';
  if (!confirm(`Change ${u.username} to ${newRole === 'admin' ? 'Admin' : 'Member'}?`)) return;
  userMutationError.value = '';
  changingRoleId.value = u.id;
  try {
    await api.patch(`/api/users/${u.id}/role`, { role: newRole });
    await loadUsers();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } }; message?: string };
    userMutationError.value = err.response?.data?.error ?? err.message ?? 'Request failed';
  } finally {
    changingRoleId.value = null;
  }
}

async function loadUsers() {
  userLoadError.value = '';
  try {
    const res = await api.get<{ users?: UserListEntry[] }>('/api/users');
    userList.value = res.data.users ?? [];
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } }; message?: string };
    userLoadError.value = err.response?.data?.error ?? err.message ?? 'Request failed';
  }
}

async function onCreateUser() {
  userMutationError.value = '';
  creatingUser.value = true;
  try {
    await api.post('/api/users', {
      username: newUser.username,
      password: newUser.password,
      role: newUser.role,
    });
    newUser.username = '';
    newUser.password = '';
    newUser.role = 'member';
    await loadUsers();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } }; message?: string };
    userMutationError.value = err.response?.data?.error ?? err.message ?? 'Request failed';
  } finally {
    creatingUser.value = false;
  }
}

async function onDeleteUser(u: UserListEntry) {
  if (!confirm(`Delete user ${u.username}?`)) return;
  userMutationError.value = '';
  try {
    await api.delete(`/api/users/${u.id}`);
    await loadUsers();
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } }; message?: string };
    userMutationError.value = err.response?.data?.error ?? err.message ?? 'Request failed';
  }
}

function openResetPassword(u: UserListEntry) {
  resetTarget.value = u;
  resetPassword.value = '';
  resetError.value = '';
}

async function onConfirmReset() {
  if (!resetTarget.value) return;
  if (resetPassword.value.length < 8) {
    resetError.value = 'Password must be at least 8 characters';
    return;
  }
  resettingPw.value = true;
  resetError.value = '';
  try {
    await api.post(`/api/users/${resetTarget.value.id}/reset-password`, {
      newPassword: resetPassword.value,
    });
    resetTarget.value = null;
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } }; message?: string };
    resetError.value = err.response?.data?.error ?? err.message ?? 'Request failed';
  } finally {
    resettingPw.value = false;
  }
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- Audit Log ---
interface AuditEntry {
  id: number;
  timestamp: number;
  actorId: string | null;
  actorUsername: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  action: string;
}

const auditEntries = ref<AuditEntry[]>([]);
const auditLoadError = ref('');
const auditLoading = ref(false);

async function loadAudit() {
  auditLoadError.value = '';
  auditLoading.value = true;
  try {
    const res = await api.get<{ entries?: AuditEntry[] }>('/api/audit?limit=100');
    auditEntries.value = res.data.entries ?? [];
  } catch (e: unknown) {
    const err = e as { response?: { data?: { error?: string } }; message?: string };
    auditLoadError.value = err.response?.data?.error ?? err.message ?? 'Request failed';
  } finally {
    auditLoading.value = false;
  }
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function describeAction(e: AuditEntry): string {
  const target = e.targetUsername ?? e.targetUserId ?? '—';
  switch (e.action) {
    case 'admin.first_created':     return `First admin created: ${target}`;
    case 'user.created':            return `User created: ${target}`;
    case 'user.deleted':            return `User deleted: ${target}`;
    case 'user.password_reset':     return `Password reset for ${target}`;
    case 'user.password_changed':   return `Own password changed`;
    case 'user.role_changed':       return `Role changed for ${target}`;
    default:                        return `${e.action} → ${target}`;
  }
}

function auditActionClass(action: string): string {
  if (action === 'user.deleted') return 'audit-action-danger';
  if (action === 'user.password_reset' || action === 'user.password_changed') return 'audit-action-warn';
  return 'audit-action-ok';
}

onMounted(() => {
  store.fetchBots(); // Refresh bot status on page visit
  store.fetchHomeData(); // Library track count + home cards (YT saves land in /music/youtube/)
  loadIdleTimeout();
  if (session.isAdmin.value) {
    loadUsers();
    loadAudit();
    loadAiSettings();
  }
});
</script>

<style lang="scss" scoped>
.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  opacity: 0.7;
  margin-bottom: 16px;
  transition: opacity var(--transition-fast);
  &:hover { opacity: 1; }
}

.page-title {
  font-size: 28px;
  font-weight: 800;
  margin-bottom: 32px;
}

.settings-section {
  margin-bottom: 36px;
  padding: 24px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
}

.section-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 16px;
}

.subsection-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  margin-top: 16px;
}

.setting-row {
  margin-bottom: 16px;
}

.setting-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 8px;
}

.setting-icon {
  font-size: 18px;
  opacity: 0.6;
}

.theme-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 600;
  transition: all var(--transition-fast);
  &:hover { background: var(--color-primary); color: white; }
}

// Bot management
.bot-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bot-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
}

.bot-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bot-name {
  font-size: 14px;
  font-weight: 500;
}

.bot-status {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: var(--border-color);
  color: var(--text-tertiary);
  &.online {
    background: var(--color-primary-15);
    color: var(--color-primary);
  }
  &.playing {
    background: var(--color-online-15);
    color: var(--color-online);
  }
  &.paused {
    background: var(--color-paused-15);
    color: var(--color-paused);
  }
}

// Account cards
.account-card {
  margin-bottom: 20px;
  padding: 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
}

.account-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.account-icon {
  font-size: 28px;
  color: var(--color-primary);
}

.account-name {
  font-size: 15px;
  font-weight: 600;
}

.account-status {
  font-size: 12px;
  color: var(--text-tertiary);
  &.logged { color: var(--color-online); }
}

.login-methods {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.login-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  transition: all var(--transition-fast);

  &:hover { border-color: var(--color-primary); color: var(--color-primary); }
  &.active {
    background: var(--color-primary-10);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

.btn-link {
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 600;
  text-decoration: underline;
  margin-left: 8px;
}

// Shared
.form-row {
  display: flex;
  gap: 8px;
}

.input {
  flex: 1;
  padding: 10px 14px;
  background: var(--hover-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  &:focus { border-color: var(--color-primary); }
}

.input-sm { max-width: 80px; }

.textarea {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  resize: vertical;
  &:focus { border-color: var(--color-primary); }
}

.quality-options {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.quality-btn {
  padding: 12px;
  background: var(--hover-bg);
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  text-align: center;
  transition: all var(--transition-fast);
  cursor: pointer;

  &:hover { border-color: var(--border-color); }
  &.active {
    border-color: var(--color-primary);
    background: var(--color-primary-10);
  }
}

.quality-name {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 2px;
}

.quality-desc {
  font-size: 11px;
  color: var(--text-tertiary);
}

.prefix-input-wrap {
  display: flex;
  gap: 8px;
  align-items: center;
}

.btn-primary {
  padding: 10px 20px;
  background: var(--color-primary);
  color: white;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  transition: transform var(--transition-fast);
  &:hover { transform: scale(1.02); }
  &:active { transform: scale(0.98); }
}

.btn-sm {
  padding: 6px 14px;
  background: var(--hover-bg);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  transition: all var(--transition-fast);
  &:hover { background: var(--color-primary); color: white; }
}

.btn-edit {
  padding: 6px 8px;
  font-size: 14px;
}

.btn-delete {
  padding: 6px 8px;
  font-size: 14px;
  &:hover { background: #f44336; color: white; }
}

.btn-secondary {
  padding: 10px 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
}

.bot-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.create-bot {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.form-group {
  margin-bottom: 12px;
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 4px;
    opacity: 0.7;
  }
}

.edit-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
}

.edit-modal {
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  padding: 28px;
  width: 480px;
  max-width: 90vw;
  max-height: 80vh;
  overflow-y: auto;
}

.modal-title {
  font-size: 20px;
  font-weight: 700;
  margin-bottom: 20px;
}

.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 20px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

// --- Bot Profile section ---
.profile-section-hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin: -8px 0 16px;
  line-height: 1.5;
}

.empty-hint {
  font-size: 13px;
  color: var(--text-tertiary);
  padding: 12px;
}

.profile-bot-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-bot {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.profile-bot-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: transparent;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--transition-fast);

  &:hover { background: var(--hover-bg); }
  &.expanded { background: var(--hover-bg); }
}

.profile-bot-name {
  flex: 1;
  text-align: left;
}

.profile-toggles {
  display: flex;
  flex-direction: column;
  padding: 0 16px 8px;
  border-top: 1px solid var(--border-color);
}

.profile-loading {
  padding: 16px 0;
  font-size: 13px;
  color: var(--text-tertiary);
  text-align: center;
}

.profile-error {
  color: var(--color-danger); // re-uses red brand color for error state

  .btn-link {
    margin-left: 8px;
    font-size: 13px;
    color: var(--color-primary);
    text-decoration: underline;
    background: transparent;
    cursor: pointer;
  }
}

.profile-toggle {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;

  &:last-child { border-bottom: none; }
}

.profile-toggle-text {
  flex: 1;
  min-width: 0;
}

.profile-toggle-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  line-height: 1.3;
}

.profile-warn-tag {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 6px;
  background: var(--color-paused-15);
  color: var(--color-paused);
  border-radius: var(--radius-xs);
  white-space: nowrap;
}

.profile-toggle-hint {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
  line-height: 1.4;
}

.profile-toggle-switch {
  flex-shrink: 0;
  appearance: none;
  -webkit-appearance: none;
  width: 40px;
  height: 22px;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  position: relative;
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
  margin: 0;

  &::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text-secondary);
    transition: transform var(--transition-fast), background var(--transition-fast);
  }

  &:checked {
    background: var(--color-primary);
    border-color: var(--color-primary);

    &::before {
      transform: translateX(18px);
      background: white;
    }
  }
}

.profile-toggle-static {
  cursor: default;
  align-items: flex-start;
}

@media (max-width: 768px) {
  .profile-bot-header {
    padding: 14px 12px;
    font-size: 15px;
  }

  .profile-toggles {
    padding: 0 12px 6px;
  }

  .profile-toggle {
    gap: 12px;
    padding: 14px 0;
  }

  .profile-toggle-switch {
    width: 44px;
    height: 24px;

    &::before {
      width: 18px;
      height: 18px;
    }
    &:checked::before {
      transform: translateX(20px);
    }
  }
}

// --- User Management ---
.user-list { display: flex; flex-direction: column; gap: 8px; }
.user-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px; background: var(--bg-secondary); border-radius: var(--radius-sm);
}
.user-info { display: flex; flex-direction: column; gap: 4px; }
.user-name { font-weight: 500; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
.user-self-badge {
  font-size: 11px; padding: 2px 6px; border-radius: 4px;
  background: var(--color-primary); color: #fff;
}
.user-created { font-size: 12px; color: var(--text-secondary); }
.user-actions { display: flex; gap: 8px; }
.user-add-form {
  display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;
}
.user-add-form .input { flex: 1; min-width: 140px; }
.user-empty, .user-error { font-size: 12px; color: var(--text-secondary); padding: 8px 0; }
.user-error { color: #e26a6a; }
.modal-hint { color: var(--text-secondary); font-size: 12px; margin: 0 0 8px; }
.form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }

.audit-refresh-btn {
  margin-left: 10px;
  border: 0; background: transparent;
  color: var(--text-secondary); cursor: pointer;
  display: inline-flex; align-items: center;
  font-size: 16px;
  &:hover { color: var(--text-primary); }
  &:disabled { opacity: 0.5; cursor: progress; }
}
.spinning { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.audit-list {
  display: flex; flex-direction: column;
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  max-height: 480px;
  overflow-y: auto;
}
.audit-row {
  display: grid;
  grid-template-columns: 170px 120px 1fr;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
  font-size: 13px;
  &:last-child { border-bottom: 0; }
}
.audit-time {
  color: var(--text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  white-space: nowrap;
}
.audit-actor {
  color: var(--text-primary);
  font-weight: 500;
}
.audit-action { color: var(--text-primary); }
.audit-action-ok      { color: var(--text-primary); }
.audit-action-warn    { color: #d3a44b; }
.audit-action-danger  { color: #e26a6a; }

@media (max-width: 640px) {
  .audit-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}

.user-role-badge {
  font-size: 11px; padding: 2px 6px; border-radius: 4px; margin-left: 6px;
  font-weight: 500;
}
.role-admin { background: rgba(99, 145, 226, 0.18); color: #6391e2; }
.role-member { background: rgba(150, 150, 150, 0.18); color: var(--text-secondary); }
.user-role-select { flex: 0 0 110px; }

// --- Account section (own password change) ---
.account-info-card {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px; background: var(--bg-secondary); border-radius: var(--radius-sm);
  margin-bottom: 12px;
}
.account-row {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 13px;
}
.account-label { color: var(--text-secondary); }
.account-value { color: var(--text-primary); font-weight: 500; }
.change-pw-form {
  display: flex; flex-direction: column; gap: 8px;
  max-width: 360px;
}
.change-pw-form .input { width: 100%; }
.change-pw-form button { align-self: flex-start; }
.user-success { color: #4caf7a; font-size: 13px; margin: 4px 0 0; }

// --- LLM status + test box ---
.llm-status-card {
  margin: 12px 0;
  padding: 14px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}
.llm-status-row {
  display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
}
.llm-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  background: var(--text-tertiary);
  &.ok { background: #4caf7a; }
  &.warn { background: #d3a44b; }
  &.off { background: var(--text-tertiary); }
}
.llm-status-text { font-size: 13px; color: var(--text-secondary); flex: 1; }
.llm-test-row { display: flex; gap: 8px; align-items: center; }
.llm-answer {
  margin: 10px 0 0; padding: 10px 12px;
  background: var(--hover-bg); border-radius: var(--radius-sm);
  font-size: 13px; line-height: 1.5; white-space: pre-wrap;
}

.rights-panel { margin-top: 8px; }
.rights-json { font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.45; }
.rights-debug-card {
  margin-top: 12px; padding: 12px;
  background: var(--bg-secondary); border-radius: var(--radius-md);
}
.rights-debug-result {
  margin-top: 10px; font-size: 13px; line-height: 1.5;
  code { font-size: 12px; word-break: break-word; }
}
.rag-results { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.rag-chunk {
  padding: 10px 12px; background: var(--hover-bg); border-radius: var(--radius-sm);
}
.rag-chunk-meta {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  font-size: 12px; margin-bottom: 6px;
}
.rag-chunk-source { font-family: ui-monospace, monospace; color: var(--text-primary); }
.rag-chunk-score { color: var(--text-secondary); }
.rag-chunk-class {
  font-size: 11px; text-transform: uppercase; padding: 2px 8px;
  border-radius: 10px; background: var(--surface-2, #2a2a2a);
}
.rag-chunk-text {
  margin: 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap;
  color: var(--text-secondary);
}
.rag-substrate-card {
  margin: 8px 0 12px; padding: 12px;
  background: var(--bg-secondary); border-radius: var(--radius-md);
}
.preset-row { display: flex; gap: 8px; align-items: center; }
</style>

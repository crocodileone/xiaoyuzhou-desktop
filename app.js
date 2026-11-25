const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const SIDEBAR_COLLAPSED_KEY = "xyzSidebarCollapsed";
const QUEUE_KEY = "xyzPlaybackQueue";
const LAST_EPISODE_KEY = "xyzLastEpisode";
const POSITION_PREFIX = "xyzPlaybackPosition:";
const AUTO_ADVANCE_KEY = "xyzAutoAdvance";
const SUMMARY_PROVIDERS = [
  { id: "qwen", label: "Qwen", keyField: "summaryQwenApiKey" },
  { id: "doubao", label: "豆包", keyField: "summaryDoubaoApiKey" },
  { id: "deepseek", label: "DeepSeek", keyField: "summaryDeepseekApiKey" },
  { id: "kimi", label: "Kimi", keyField: "summaryKimiApiKey" },
  { id: "glm", label: "GLM", keyField: "summaryGlmApiKey" }
];

const state = {
  route: "discover",
  searchType: "episode",
  feed: [],
  discoverySourceIndex: 0,
  subscriptions: [],
  current: null,
  episodeDetails: new Map(),
  auth: null,
  settings: null,
  settingsTab: "files",
  searchRequest: 0,
  searchKeyword: "",
  searchResultsByType: { episode: null, podcast: null },
  searchErrorsByType: {},
  podcastView: null,
  episodeView: null,
  subscribedPids: new Set(),
  currentTranscriptPath: "",
  currentTranscriptEpisodeId: "",
  currentTranscriptSegments: [],
  currentSummaryPath: "",
  summaryHistory: new Map(),
  summaryPromptDrafts: [],
  summaryPromptEditorId: "",
  queue: [],
  autoAdvance: true,
  playRequest: 0,
  playPending: false,
  pendingPosition: null,
  lastProgressWrite: 0,
  advancingQueue: false,
  episodeRequests: new Map()
};

const routeMeta = {
  discover: ["EXPLORE", "发现"],
  search: ["FIND YOUR NEXT STORY", "搜索"],
  subscriptions: ["YOUR LIBRARY", "我的订阅"],
  settings: ["PREFERENCES", "设置"]
};

const SEARCH_TYPES = ["episode", "podcast"];
const SEARCH_TYPE_LABELS = {
  episode: "单集",
  podcast: "节目"
};

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "请求失败"));
      resolve(response.data);
    });
  });
}

function api(endpoint, body = {}, method = "POST") {
  return send("api", { payload: { endpoint, body, method } });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function summaryRecordOf(item) {
  return state.summaryHistory.get(episodeIdOf(item)) || null;
}

function summaryActionButton(item, className, actionAttribute) {
  const eid = episodeIdOf(item);
  const completed = Boolean(eid && state.summaryHistory.has(eid));
  return `<button
    class="${className}${completed ? " is-complete" : ""}"
    ${actionAttribute}
    ${eid ? `data-summary-eid="${esc(eid)}"` : ""}
    title="${completed ? "已有总结，再次点击可重新生成" : "生成 AI 总结"}"
  >${completed ? "已 AI 总结" : "AI 总结"}</button>`;
}

function transcriptActionLabel(source = state.settings?.transcriptSource) {
  return source === "asr" ? "ASR 转写" : "导出文字稿";
}

function refreshSummaryIndicators(episodeId = "") {
  const eid = String(episodeId || "");
  $$("[data-summary-eid]").forEach((button) => {
    if (button.dataset.summaryEid !== eid) return;
    button.classList.add("is-complete");
    button.textContent = "已 AI 总结";
    button.title = "已有总结，再次点击可重新生成";
  });
  if (episodeIdOf(state.current) === eid) updatePlayerLinkButtons(state.current);
}

function moreActions(content, className = "") {
  if (!content) return "";
  return `<details class="action-menu ${className}">
    <summary class="more-button" title="更多操作" aria-label="更多操作">⋮</summary>
    <div class="action-menu-panel" role="menu">${content}</div>
  </details>`;
}

function queueActions(item, attribute) {
  if (!episodeIdOf(item)) return "";
  return `<button ${attribute}="queue" role="menuitem">加入队列</button>
    <button ${attribute}="queue-next" role="menuitem">下一首播放</button>`;
}

function closeActionMenu(target) {
  target?.closest(".action-menu")?.removeAttribute("open");
}

function dataOf(response) {
  return response?.data ?? response?.list ?? response?.items ?? response ?? [];
}

function itemOf(value) {
  if (["EPISODE", "PODCAST", "USER"].includes(value?.type) || value?.eid || value?.pid) return value;
  return value?.episode || value?.podcast || value?.item || value;
}

function isContentItem(item) {
  return Boolean(item?.eid || item?.pid || item?.episode?.eid || item?.podcast?.pid || item?.podcast?.id ||
    (["EPISODE", "PODCAST"].includes(item?.type) && item?.id));
}

function listOf(response) {
  const data = dataOf(response);
  if (Array.isArray(data)) return data;
  return data?.data ?? data?.list ?? data?.items ?? data?.episodes ?? data?.podcasts ?? data?.picks ?? [];
}

function extractContent(response) {
  const items = [];
  const visited = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) return value.forEach(walk);
    const item = itemOf(value);
    if (item !== value && item && typeof item === "object") {
      if (isContentItem(item)) items.push(item);
      return;
    }
    if (isContentItem(value)) {
      items.push(value);
      return;
    }
    ["data", "list", "items", "picks", "target", "collections", "sections"].forEach((key) => walk(value[key]));
  };
  walk(response);
  return [...new Map(items.map((item) => [`${episodeIdOf(item)}:${podcastIdOf(item)}`, item])).values()];
}

function unwrapDiscovery(response) {
  const collections = listOf(response);
  return collections.flatMap((collection) => {
    if (collection?.type !== "DISCOVERY_COLLECTION") return [collection];
    const sections = Array.isArray(collection?.data) ? collection.data : [collection?.data || collection];
    return sections.flatMap((section) => {
      const targets = section?.target || collection?.target || [];
      return targets.map((target) => target?.episode || target?.podcast || target).filter(Boolean);
    });
  }).filter((item) => item?.type !== "HEADER" && item?.type !== "FOOTER");
}

function unwrapCollectionItems(response) {
  const items = listOf(response);
  return items.flatMap((item) => {
    if (item?.type !== "DISCOVERY_COLLECTION") return [item];
    const sections = Array.isArray(item.data) ? item.data : [item.data || item];
    return sections.flatMap((section) => section?.target || []).map((target) => target?.episode || target?.podcast || target).filter(Boolean);
  }).filter((item) => !["HEADER", "FOOTER"].includes(item?.type));
}

function unwrapDetail(response) {
  const data = dataOf(response);
  return data?.data || data?.episode || data;
}

function imageOf(item) {
  return item?.podcast?.image?.picUrl || item?.podcast?.image?.middlePicUrl || item?.podcast?.cover?.url || item?.podcast?.imageUrl || item?.image?.picUrl || item?.imageUrl || "";
}

function titleOf(item) {
  return item?.title || item?.name || item?.podcast?.title || item?.podcast?.name || "未命名节目";
}

function episodeMetricNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatEpisodeMetricCount(value) {
  const count = episodeMetricNumber(value);
  if (count === null) return "";
  if (count < 10_000) return String(Math.floor(count));
  if (count < 100_000_000) {
    const compact = Math.round(count / 1_000) / 10;
    return `${String(compact).replace(/\.0$/, "")}万`;
  }
  const compact = Math.round(count / 10_000_000) / 10;
  return `${String(compact).replace(/\.0$/, "")}亿`;
}

function formatEpisodePublishDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}.${month}.${day}`;
}

function episodeCardFacts(item) {
  const source = item?.episode?.eid ? item.episode : item;
  const duration = durationOf(source);
  const facts = [
    {
      className: "is-duration",
      label: "时长",
      value: duration ? formatTime(duration) : "",
      icon: ""
    },
    {
      className: "is-published",
      label: "发布日期",
      value: formatEpisodePublishDate(source?.pubDate || source?.publishedAt || source?.createdAt),
      icon: ""
    },
    {
      className: "is-listens",
      label: "收听数",
      value: formatEpisodeMetricCount(source?.playCount),
      icon: "metric-icon-listens"
    },
    {
      className: "is-comments",
      label: "评论数",
      value: formatEpisodeMetricCount(source?.commentCount),
      icon: "metric-icon-comments"
    }
  ].filter((fact) => fact.value);
  if (!facts.length) return "";
  return `<div class="episode-card-facts" aria-label="单集数据">${
    facts.map((fact) => `<span class="episode-card-metric ${fact.className}" aria-label="${esc(`${fact.label} ${fact.value}`)}" title="${esc(`${fact.label} ${fact.value}`)}">${
      fact.icon ? `<i class="metric-icon ${fact.icon}" aria-hidden="true"></i>` : ""
    }<span>${esc(fact.value)}</span></span>`).join("")
  }</div>`;
}

function podcastIdOf(item) {
  return item?.pid || item?.podcast?.pid || item?.podcast?.id || (item?.type === "PODCAST" ? item.id : "") || "";
}

function episodeIdOf(item) {
  return item?.eid || item?.episode?.eid || item?.episode?.id || (item?.type === "EPISODE" ? item.id : "") || "";
}

function podcastOf(item) {
  return item?.podcast && podcastIdOf(item.podcast) ? item.podcast : item;
}

function isPodcastItem(item) {
  return Boolean(podcastIdOf(item) && !episodeIdOf(item));
}

function audioOf(item) {
  return item?.media?.source?.url || item?.media?.url || item?.enclosure?.url || item?.audioUrl || item?.url || "";
}

function episodeContentOf(item) {
  const html = String(item?.shownotes || "");
  if (html) {
    const documentValue = new DOMParser().parseFromString(html, "text/html");
    documentValue.querySelectorAll("[data-timestamp]").forEach((node) => {
      const seconds = Number(node.getAttribute("data-timestamp"));
      const label = Number.isFinite(seconds) ? formatTime(seconds) : "";
      if (label && !String(node.textContent || "").includes(label)) {
        node.prepend(`${label} `);
      }
      node.after(" ");
    });
    documentValue.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    documentValue.querySelectorAll("p, li, h1, h2, h3, h4")
      .forEach((node) => node.append("\n"));
    const content = String(documentValue.body.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (content) return content;
  }
  const plain = item?.description || item?.brief || item?.introduction || "";
  return String(plain).replace(/\\n/g, "\n").trim();
}

function durationOf(item) {
  const value = Number(item?.duration || item?.media?.duration || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function audioExtensionOf(item) {
  try {
    const extension = new URL(audioOf(item)).pathname.match(/\.(mp3|m4a|wav|ogg|flac|aac|aiff|wma|webm)$/i)?.[1];
    return extension ? `.${extension.toLowerCase()}` : ".m4a";
  } catch {
    return ".m4a";
  }
}

function filenamePart(value, fallback) {
  const clean = String(value || fallback).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  return clean || fallback;
}

function audioFilenameOf(item) {
  const extension = audioExtensionOf(item);
  const filename = `${filenamePart(item?.podcast?.title || item?.podcast?.name, "小宇宙")} - ${filenamePart(titleOf(item), "单集")}`;
  return `${filename.slice(0, 160)}${extension}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  return XYZEpisodeContent.formatTimestamp(seconds);
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function setTranscriptionStatus(message = "", type = "pending") {
  const status = $("#transcription-status");
  status.hidden = !message;
  status.textContent = message;
  status.title = message;
  status.style.color = type === "success" ? "#377551" : type === "error" ? "#9a5146" : "#8a6a16";
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const toggle = $("#sidebar-toggle");
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.title = collapsed ? "展开侧栏" : "折叠侧栏";
  toggle.querySelector(".sr-only").textContent = toggle.title;
  toggle.querySelector('[aria-hidden="true"]').textContent = collapsed ? "›" : "‹";
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
}

function setRoute(route) {
  state.podcastView = null;
  state.episodeView = null;
  state.route = route;
  $$(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.route === route));
  const [eyebrow, title] = routeMeta[route];
  $("#route-eyebrow").textContent = eyebrow;
  $("#route-title").textContent = title;
  $("#back-button").hidden = true;
  renderRoute();
}

function markConnection() {
  const node = $("#connection-state");
  node.classList.toggle("is-online", Boolean(state.auth));
  $("#connection-state em").textContent = state.auth ? "已连接" : "未连接";
  const account = $("#account-button");
  const accountName = state.auth?.user?.nickname || state.auth?.user?.name || "";
  account.textContent = state.auth
    ? `${accountName || "已登录"} · 退出`
    : "登录";
  account.classList.toggle("is-logged", Boolean(state.auth));
}

function renderRoute() {
  const root = $("#page-content");
  if (state.episodeView) return renderEpisodePage(root);
  if (state.podcastView) return renderPodcastPage(root);
  if (state.route === "search") return renderSearchPage(root);
  if (state.route === "subscriptions") return renderSubscriptionsPage(root);
  if (state.route === "settings") return renderSettingsPage(root);
  return renderDiscoverPage(root);
}

function renderDiscoverPage(root) {
  root.innerHTML = `
    <section class="hero">
      <div><div class="route-eyebrow">THE DAILY FREQUENCY</div><h1>今天，听点<br /><span>不一样的。</span></h1><p>从精选节目、热门单集和你可能喜欢的声音里，挑一段刚好适合此刻的陪伴。</p></div>
      <div class="hero-figure" aria-hidden="true"></div>
    </section>
    <div class="section-heading"><h2>为你精选</h2><div class="heading-actions"><span>CURATED FOR YOU</span><button id="refresh-discover" class="refresh-button" type="button" title="刷新推荐" aria-label="刷新推荐">↻</button></div></div>
    <div id="discover-feed" class="feed-grid"><div class="loading">正在接收今天的声音……</div></div>`;
  $("#refresh-discover").addEventListener("click", () => {
    const button = $("#refresh-discover");
    if (button.classList.contains("is-spinning")) return;
    button.classList.add("is-spinning");
    loadDiscovery((state.discoverySourceIndex + 1) % DISCOVERY_SOURCES.length)
      .finally(() => button.classList.remove("is-spinning"));
  });
  loadDiscovery();
}

const DISCOVERY_SOURCES = [
  { endpoint: "/editor_pick", body: {}, label: "编辑精选" },
  { endpoint: "/discovery", body: {}, label: "发现" },
  { endpoint: "/top_list", body: { category: "HOT" }, label: "热榜" }
];

async function loadDiscovery(startIndex = 0) {
  const holder = $("#discover-feed");
  const setHolder = (html) => { if ($("#discover-feed") === holder) holder.innerHTML = html; };
  try {
    let lastError;
    for (const offset of DISCOVERY_SOURCES.keys()) {
      const index = (startIndex + offset) % DISCOVERY_SOURCES.length;
      const source = DISCOVERY_SOURCES[index];
      setHolder(`<div class="loading">正在接收${source.label}……</div>`);
      try {
        const items = extractContent(await api(source.endpoint, source.body));
        if (items.length) {
          state.feed = items;
          state.discoverySourceIndex = index;
          holder.innerHTML = state.feed.slice(0, 12).map((item, i) => podcastCard(item, i)).join("");
          bindCardActions(holder, state.feed);
          return;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    setHolder(`<div class="empty">暂无发现内容。请确认登录状态或稍后重试。</div>`);
  } catch (error) {
    setHolder(`<div class="empty">${esc(error.message)}<br /><button class="mini-button" data-action="login">去登录</button></div>`);
    holder.querySelector("[data-action=login]")?.addEventListener("click", openLogin);
  }
}

function podcastCard(item, index) {
  const image = imageOf(item);
  const pid = podcastIdOf(item);
  const canViewPodcast = Boolean(pid);
  const subscribed = state.subscribedPids.has(pid);
  const canResolveEpisode = Boolean(episodeIdOf(item) || pid);
  const viewPodcast = canViewPodcast ? `<button class="mini-button" data-card-action="view-podcast">查看节目</button>` : "";
  const summary = canResolveEpisode
    ? summaryActionButton(item, "mini-button is-accent", 'data-card-action="summarize"')
    : "";
  const secondaryActions = [
    canViewPodcast ? `<button data-card-action="subscribe" role="menuitem" ${subscribed ? "disabled" : ""}>${subscribed ? "已订阅" : "订阅节目"}</button>` : "",
    canResolveEpisode ? `<button data-card-action="download" role="menuitem">下载音频</button>` : "",
    canResolveEpisode ? `<button data-card-action="transcribe" role="menuitem">${transcriptActionLabel()}</button>` : "",
    episodeIdOf(item) ? `<button data-card-action="copy-episode" role="menuitem">复制单集链接</button>` : "",
    canViewPodcast ? `<button data-card-action="copy-podcast" role="menuitem">复制节目链接</button>` : ""
  ].join("");
  return `<article class="podcast-card" data-index="${index}">
    <div class="cover">${image ? `<img src="${esc(image)}" alt="" loading="lazy" />` : ""}</div>
    <div class="card-main">
      <div class="card-copy"><strong title="${esc(titleOf(item))}">${esc(titleOf(item))}</strong>${episodeCardFacts(item)}</div>
      <div class="card-actions"><button class="mini-button" data-card-action="play">播放</button>${viewPodcast}${summary}${moreActions(secondaryActions, "action-menu-card")}</div>
    </div>
  </article>`;
}

function bindCardActions(holder, items) {
  $$(".podcast-card", holder).forEach((card) => {
    card.addEventListener("click", (event) => {
      const item = items[Number(card.dataset.index)];
      const control = event.target.closest("button, summary");
      if (!control) return isPodcastItem(item) ? openPodcast(item) : browseEpisode(item);
      if (control.tagName === "SUMMARY") return;
      const action = control.dataset.cardAction;
      closeActionMenu(control);
      if (action === "play") playEpisode(item);
      if (action === "queue" || action === "queue-next") addToQueue(item, action === "queue-next");
      if (action === "view-podcast") openPodcast(item);
      if (action === "summarize") summarizeEpisode(item, control).catch((error) => notify(error.message));
      if (action === "subscribe") toggleSubscription(item, control);
      if (action === "download") downloadEpisodeAudio(item);
      if (action === "transcribe") exportEpisodeTranscript(item, control);
      if (action === "copy-episode") copyEpisodeLink(item);
      if (action === "copy-podcast") copyPodcastLink(item);
    });
  });
}

function renderSearchPage(root) {
  root.innerHTML = `
    <section><div class="route-eyebrow">SEARCH THE UNIVERSE</div><div class="search-bar"><input id="search-input" type="search" value="${esc(state.searchKeyword)}" placeholder="搜索节目、单集或主播" autocomplete="off" /><button id="search-submit" title="搜索">⌕</button></div>
    <div class="filter-row"><button class="filter-button" data-search-type="episode">单集</button><button class="filter-button" data-search-type="podcast">节目</button></div><div id="search-results" class="result-list"></div></section>`;
  $$("[data-search-type]").forEach((button) => button.classList.toggle("is-active", button.dataset.searchType === state.searchType));
  $$("[data-search-type]").forEach((button) => button.addEventListener("click", () => {
    state.searchType = button.dataset.searchType;
    $$("[data-search-type]").forEach((item) => item.classList.toggle("is-active", item === button));
    renderSearchResults($("#search-results"));
  }));
  $("#search-submit").addEventListener("click", performSearch);
  $("#search-input").addEventListener("keydown", (event) => { if (event.key === "Enter") performSearch(); });
  renderSearchResults($("#search-results"));
}

async function performSearch() {
  const keyword = $("#search-input").value.trim();
  const holder = $("#search-results");
  if (!keyword) return notify("先输入一个关键词");
  state.searchKeyword = keyword;
  state.searchResultsByType = { episode: null, podcast: null };
  state.searchErrorsByType = {};
  const requestId = ++state.searchRequest;
  renderSearchResults(holder, { loading: true });
  const responses = await Promise.allSettled(
    SEARCH_TYPES.map(async (type) => {
      const response = await api("/search", {
        keyword,
        type: type.toUpperCase()
      });
      return {
        type,
        items: listOf(response)
          .map(itemOf)
          .filter((item) => item?.type === type.toUpperCase())
      };
    })
  );
  if (requestId !== state.searchRequest) return;
  responses.forEach((result, index) => {
    const type = SEARCH_TYPES[index];
    if (result.status === "fulfilled") {
      state.searchResultsByType[result.value.type] = result.value.items;
      delete state.searchErrorsByType[result.value.type];
    } else {
      state.searchResultsByType[type] = [];
      state.searchErrorsByType[type] = result.reason?.message || "搜索失败";
    }
  });
  renderSearchResults(holder);
}

function renderSearchResults(holder, { loading = false } = {}) {
  const activeType = state.searchType;
  const label = SEARCH_TYPE_LABELS[activeType] || "内容";
  const results = state.searchResultsByType[activeType];
  const inputValue = $("#search-input")?.value.trim() || state.searchKeyword;
  if (!state.searchKeyword || inputValue !== state.searchKeyword) {
    holder.innerHTML = `<div class="empty">输入关键词，去找到下一段想听的声音。</div>`;
    return;
  }
  if (loading || results === null) {
    holder.innerHTML = `<div class="loading">正在搜索「${esc(state.searchKeyword)}」相关${esc(label)}……</div>`;
    return;
  }
  const error = state.searchErrorsByType[activeType];
  if (error) {
    holder.innerHTML = `<div class="empty">${esc(label)}搜索失败：${esc(error)}<br /><button class="mini-button" data-retry-search>重新搜索</button></div>`;
    holder.querySelector("[data-retry-search]")?.addEventListener("click", performSearch);
    return;
  }
  holder.innerHTML = results.length
    ? results.map((item, index) => searchResultRow(item, index)).join("")
    : `<div class="empty">没有找到和「${esc(state.searchKeyword)}」相关的${esc(label)}。</div>`;
  bindSearchRows(holder, results);
}

function searchResultText(item, isPodcast) {
  return item?.description
    || item?.brief
    || item?.introduction
    || item?.podcast?.title
    || item?.podcast?.name
    || (isPodcast ? "播客节目" : "小宇宙单集");
}

function descriptionBlock(text) {
  const value = String(text || "").trim();
  const collapsible = value.length > 110;
  return `<div class="result-description-wrap${collapsible ? " is-collapsed" : ""}">
    <span class="result-description">${esc(value)}</span>
    ${collapsible ? '<button class="description-toggle" data-row-action="toggle-description" type="button">展开</button>' : ""}
  </div>`;
}

function searchResultRow(item, index) {
  const isPodcast = isPodcastItem(item);
  const pid = podcastIdOf(item);
  const canViewPodcast = Boolean(pid);
  const subscribed = state.subscribedPids.has(pid);
  const canResolveEpisode = item?.type !== "USER" && Boolean(episodeIdOf(item) || pid);
  const secondaryActions = item?.type === "USER" ? "" : [
    isPodcast ? `<button data-row-action="subscribe" role="menuitem" ${subscribed ? "disabled" : ""}>${subscribed ? "已订阅" : "订阅节目"}</button>` : "",
    canResolveEpisode ? `<button data-row-action="download" role="menuitem">下载音频</button>` : "",
    canResolveEpisode ? `<button data-row-action="transcribe" role="menuitem">${transcriptActionLabel()}</button>` : "",
    queueActions(item, "data-row-action"),
    episodeIdOf(item) ? `<button data-row-action="copy-episode" role="menuitem">复制单集链接</button>` : "",
    canViewPodcast ? `<button data-row-action="copy-podcast" role="menuitem">复制节目链接</button>` : ""
  ].join("");
  const actions = item?.type === "USER" ? "" : `
    <button class="row-action" data-row-action="play">播放</button>
    <button class="row-action" data-row-action="view-podcast" ${canViewPodcast ? "" : "disabled"}>查看节目</button>
    ${summaryActionButton(item, "row-action is-primary", 'data-row-action="summarize"')}
    ${moreActions(secondaryActions, "action-menu-row")}`;
  return `<article class="episode-row" data-index="${index}">
    <div class="episode-thumb">${imageOf(item) ? `<img src="${esc(imageOf(item))}" alt="" />` : ""}</div>
    <div class="episode-meta"><strong>${esc(titleOf(item))}</strong>${descriptionBlock(searchResultText(item, isPodcast))}</div>
    <div class="row-actions">${actions}</div>
  </article>`;
}

function bindSearchRows(holder, items) {
  $$(".episode-row", holder).forEach((row) => row.addEventListener("click", (event) => {
    const item = items[Number(row.dataset.index)];
    const control = event.target.closest("button, summary");
    if (!control) {
      if (isPodcastItem(item)) openPodcast(item);
      else if (episodeIdOf(item)) browseEpisode(item);
      return;
    }
    if (control.tagName === "SUMMARY") return;
    const action = control.dataset.rowAction;
    closeActionMenu(control);
    if (action === "toggle-description") {
      const wrapper = control.closest(".result-description-wrap");
      wrapper?.classList.toggle("is-collapsed");
      control.textContent = wrapper?.classList.contains("is-collapsed") ? "展开" : "收起";
      return;
    }
    if (action === "play") playEpisode(item);
    if (action === "queue" || action === "queue-next") addToQueue(item, action === "queue-next");
    if (action === "view-podcast") openPodcast(item);
    if (action === "summarize") summarizeEpisode(item, control).catch((error) => notify(error.message));
    if (action === "subscribe") toggleSubscription(item, control);
    if (action === "download") downloadEpisodeAudio(item);
    if (action === "transcribe") exportEpisodeTranscript(item, control);
    if (action === "copy-episode") copyEpisodeLink(item);
    if (action === "copy-podcast") copyPodcastLink(item);
  }));
}

function renderSubscriptionsPage(root) {
  root.innerHTML = `<section><div class="section-heading"><h2>我的订阅</h2><span>YOUR SUBSCRIPTIONS</span></div><div id="subscriptions-list" class="feed-grid"><div class="loading">正在读取你的订阅……</div></div></section>`;
  loadSubscriptions();
}

async function loadSubscriptions() {
  const holder = $("#subscriptions-list");
  try {
    let response;
    try {
      response = await api("/subscription", { limit: "50", sortOrder: "desc", sortBy: "subscribedAt" });
    } catch {
      response = await api("/subscription", { limit: "20", sortOrder: "desc", sortBy: "subscribedAt" });
    }
    state.subscriptions = listOf(response).map(itemOf).filter((item) => item?.type === "PODCAST");
    const order = state.settings?.subscriptionOrder || [];
    if (order.length) {
      const rank = new Map(order.map((pid, i) => [String(pid), i]));
      state.subscriptions.sort((a, b) => (rank.get(String(podcastIdOf(a))) ?? order.length) - (rank.get(String(podcastIdOf(b))) ?? order.length));
    }
    state.subscriptions.forEach((item) => state.subscribedPids.add(podcastIdOf(item)));
    holder.innerHTML = state.subscriptions.length ? state.subscriptions.map((item, index) => podcastCard(item, index)).join("") : `<div class="empty">还没有订阅节目。去发现页逛逛吧。</div>`;
    bindCardActions(holder, state.subscriptions);
    if (state.subscriptions.length) initSubscriptionDrag(holder, state.subscriptions);
  } catch (error) {
    holder.innerHTML = `<div class="empty">${esc(error.message)}<br /><button class="mini-button" data-action="login">去登录</button></div>`;
    holder.querySelector("[data-action=login]")?.addEventListener("click", openLogin);
  }
}

function initSubscriptionDrag(holder, items) {
  let dragging = null;
  let dragY = 0;
  let rafId = 0;
  const startAutoScroll = (y) => {
    dragY = y;
    cancelAnimationFrame(rafId);
    const tick = () => {
      const zone = 100;
      let speed = 0;
      if (dragY < zone) speed = -Math.pow((zone - dragY) / zone, 1.5) * 26;
      else if (dragY > window.innerHeight - zone) speed = Math.pow((dragY - (window.innerHeight - zone)) / zone, 1.5) * 26;
      if (speed) window.scrollBy({ top: speed });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  };
  const stopAutoScroll = () => cancelAnimationFrame(rafId);
  const persist = () => {
    const byIndex = new Map(items.map((item, index) => [String(index), item]));
    const nextItems = $$(".podcast-card", holder).map((card) => byIndex.get(card.dataset.index));
    if (nextItems.length !== items.length) return;
    state.subscriptions = nextItems;
    send("set-subscription-order", { order: nextItems.map((item) => podcastIdOf(item)).filter(Boolean) }).catch(() => {});
  };
  $$(".podcast-card", holder).forEach((card) => {
    card.draggable = true;
    card.addEventListener("dragstart", (event) => {
      dragging = card;
      card.classList.add("is-dragging");
      const rect = card.getBoundingClientRect();
      const ghost = card.cloneNode(true);
      ghost.classList.add("drag-ghost");
      ghost.style.cssText = `left: -2000px; position: fixed; top: -2000px; width: ${rect.width}px`;
      document.body.appendChild(ghost);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", "");
      const offsetX = Math.max(4, Math.min(rect.width - 4, event.clientX - rect.left));
      const offsetY = Math.max(4, Math.min(rect.height - 4, event.clientY - rect.top));
      event.dataTransfer.setDragImage(ghost, offsetX, offsetY);
      requestAnimationFrame(() => ghost.remove());
      startAutoScroll(event.clientY);
    });
    card.addEventListener("dragend", () => {
      dragging = null;
      card.classList.remove("is-dragging");
      stopAutoScroll();
      persist();
    });
    card.addEventListener("dragover", (event) => {
      event.preventDefault();
      dragY = event.clientY;
      if (!dragging || dragging === card) return;
      const rect = card.getBoundingClientRect();
      const before = event.clientY - rect.top < rect.height / 2;
      holder.insertBefore(dragging, before ? card : card.nextSibling);
    });
  });
  holder.addEventListener("dragover", (event) => event.preventDefault());
  holder.addEventListener("drop", (event) => event.preventDefault());
}

function openPodcast(item) {
  const podcast = podcastOf(item);
  const pid = podcastIdOf(podcast);
  if (!pid) return notify("无法识别这个节目");
  state.episodeView = null;
  state.podcastView = {
    podcast,
    pages: [],
    page: 0,
    exhausted: false,
    pagerBusy: false,
    sourceRoute: state.route,
    scrollY: window.scrollY
  };
  $("#route-eyebrow").textContent = "PROGRAM ARCHIVE";
  $("#route-title").textContent = titleOf(podcast);
  $("#back-button").hidden = false;
  renderRoute();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function closePodcast() {
  if (!state.podcastView) return;
  const { sourceRoute, scrollY } = state.podcastView;
  state.podcastView = null;
  state.route = sourceRoute;
  const [eyebrow, title] = routeMeta[sourceRoute];
  $("#route-eyebrow").textContent = eyebrow;
  $("#route-title").textContent = title;
  $("#back-button").hidden = true;
  renderRoute();
  requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
}

function closeEpisode() {
  if (!state.episodeView) return;
  const { scrollY } = state.episodeView;
  state.episodeView = null;
  if (state.podcastView) {
    $("#route-eyebrow").textContent = "PROGRAM ARCHIVE";
    $("#route-title").textContent = titleOf(state.podcastView.podcast);
    $("#back-button").hidden = false;
  } else {
    const [eyebrow, title] = routeMeta[state.route];
    $("#route-eyebrow").textContent = eyebrow;
    $("#route-title").textContent = title;
    $("#back-button").hidden = true;
  }
  renderRoute();
  requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
}

function timestampDeepLink(item, seconds) {
  return XYZEpisodeContent.deepLink(episodeIdOf(item), seconds);
}

function seekToTimestamp(episode, seconds, { scroll = false } = {}) {
  if (!episode) return;
  const target = Math.max(0, Number(seconds) || 0);
  if (scroll && episodeIdOf(state.episodeView?.episode) === episodeIdOf(episode)) {
    document.querySelector(`[data-content-timestamp="${Math.floor(target)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  return playEpisode(episode, { startAt: target });
}

function renderEpisodeContentBlocks(episode) {
  const content = episodeContentOf(episode);
  const blocks = XYZEpisodeContent.parseContent(content);
  if (!blocks.length) return `<div class="empty">这期暂时没有 Show Notes 正文。</div>`;
  let listOpen = false;
  const output = [];
  const closeList = () => {
    if (listOpen) output.push("</ul>");
    listOpen = false;
  };

  blocks.forEach((block) => {
    if (block.type !== "bullet") closeList();
    if (block.type === "heading") {
      output.push(`<h2>${esc(block.text)}</h2>`);
    } else if (block.type === "timestamp") {
      const deepLink = timestampDeepLink(episode, block.seconds);
      output.push(`<div class="episode-timestamp-row" data-content-timestamp="${block.seconds}">
        <button class="timestamp-button" type="button" data-seek-seconds="${block.seconds}" title="跳转到 ${esc(block.label)}">${esc(block.label)}</button>
        <p>${esc(block.text || "从这里继续收听")}</p>
        ${deepLink ? `<a href="${esc(deepLink)}" title="在小宇宙打开这个时间点">小宇宙 ↗</a>` : ""}
      </div>`);
    } else if (block.type === "bullet") {
      if (!listOpen) {
        output.push('<ul class="episode-content-list">');
        listOpen = true;
      }
      output.push(`<li>${esc(block.text)}</li>`);
    } else {
      output.push(`<p>${esc(block.text)}</p>`);
    }
  });
  closeList();
  return output.join("");
}

function renderEpisodePage(root) {
  const { episode, loading, error } = state.episodeView;
  const image = imageOf(episode);
  const podcastTitle = episode?.podcast?.title || episode?.podcast?.name || "小宇宙节目";
  const published = episode?.pubDate || episode?.publishedAt || episode?.createdAt || "";
  const publishedText = published ? new Date(published).toLocaleString("zh-CN", { dateStyle: "medium" }) : "";
  const sourceUrl = episodeLinkOf(episode);
  const timeline = XYZEpisodeContent.extractTimeline(episodeContentOf(episode));
  const duration = durationOf(episode);
  root.innerHTML = `
    <article class="episode-content-page">
      <header class="episode-content-hero">
        <div class="episode-content-cover">${image ? `<img src="${esc(image)}" alt="${esc(titleOf(episode))}" />` : "<span>◌</span>"}</div>
        <div class="episode-content-heading">
          <div class="route-eyebrow">SHOW NOTES</div>
          <h1>${esc(titleOf(episode))}</h1>
          <button class="episode-podcast-link" type="button" data-open-current-podcast>${esc(podcastTitle)}</button>
          <div class="episode-facts">
            ${duration ? `<span>${esc(formatTime(duration))}</span>` : ""}
            ${publishedText ? `<span>${esc(publishedText)}</span>` : ""}
            ${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noreferrer">真实单集链接 ↗</a>` : ""}
          </div>
          <div class="episode-content-actions">
            <button class="primary-button" type="button" data-toggle-current-play>${isPlaying(episode) ? "暂停" : "播放"}</button>
            <button class="secondary-button" type="button" data-copy-current-link>复制单集链接</button>
            <button class="secondary-button" type="button" data-queue-current-view>加入队列</button>
          </div>
        </div>
      </header>
      ${timeline.length ? `<section class="episode-chapter-strip" aria-label="本期时间轴">
        ${timeline.map((item) => `<button type="button" data-seek-seconds="${item.seconds}"><strong>${esc(item.label)}</strong><span>${esc(item.text || "继续收听")}</span></button>`).join("")}
      </section>` : ""}
      <section class="episode-show-notes">
        <div class="section-heading"><h2>本期内容</h2><span>${timeline.length ? `${timeline.length} TIMESTAMPS` : "SHOW NOTES"}</span></div>
        <div class="episode-content-body">${loading ? '<p class="loading">正在载入单集详情……</p>' : ""}
          ${error ? `<p class="empty">${esc(error)}</p>` : ""}${renderEpisodeContentBlocks(episode)}</div>
      </section>
    </article>`;
  $$("[data-seek-seconds]", root).forEach((button) => button.addEventListener("click", () => seekToTimestamp(episode, button.dataset.seekSeconds)));
  $("[data-open-current-podcast]", root)?.addEventListener("click", () => openPodcast(episode));
  $("[data-toggle-current-play]", root)?.addEventListener("click", () => togglePlayback(episode));
  $("[data-copy-current-link]", root)?.addEventListener("click", () => copyEpisodeLink(episode));
  $("[data-queue-current-view]", root)?.addEventListener("click", () => addToQueue(episode));
}

function renderPodcastPage(root) {
  const view = state.podcastView;
  const podcast = view.podcast;
  const image = imageOf(podcast);
  const author = podcast?.author?.nickname || podcast?.author?.name || "小宇宙节目";
  const description = podcast?.description || podcast?.brief || podcast?.introduction || "暂无节目简介。";
  const subscribed = state.subscribedPids.has(podcastIdOf(podcast));
  root.innerHTML = `
    <section class="podcast-detail">
      <header class="podcast-detail-hero">
        <div class="podcast-detail-cover">${image ? `<img src="${esc(image)}" alt="${esc(titleOf(podcast))}" />` : "<span>◌</span>"}</div>
        <div class="podcast-detail-copy">
          <div class="route-eyebrow">PODCAST ARCHIVE</div>
          <h1>${esc(titleOf(podcast))}</h1>
          <p class="podcast-detail-author">${esc(author)}</p>
          <p class="podcast-detail-description">${esc(description)}</p>
          <div class="podcast-detail-actions">
            <button id="detail-subscribe" class="primary-button" type="button" ${subscribed ? "disabled" : ""}>${subscribed ? "已订阅" : "订阅节目"}</button>
            <button id="detail-copy-podcast" class="secondary-button" type="button">复制节目链接</button>
          </div>
        </div>
      </header>
      <div class="section-heading"><h2>全部单集</h2><span>EPISODE ARCHIVE</span></div>
      <div id="podcast-episodes" class="result-list">${view.pages.length === 0 ? '<div class="loading">正在读取节目单集……</div>' : ""}</div>
    </section>`;
  $("#detail-subscribe").addEventListener("click", (event) => toggleSubscription(podcast, event.currentTarget));
  $("#detail-copy-podcast").addEventListener("click", () => copyPodcastLink(podcast));
  if (view.pages.length === 0) loadPodcastEpisodes(view);
  else renderPodcastEpisodes($("#podcast-episodes"), view);
}

async function loadPodcastEpisodes(view) {
  const holder = $("#podcast-episodes");
  view.pages = [];
  view.page = 0;
  view.exhausted = false;
  try {
    const response = await api("/episode_list", { pid: podcastIdOf(view.podcast), order: "desc" });
    if (state.podcastView !== view) return;
    view.pages.push(parseEpisodePage(response));
    view.exhausted = !view.pages[0].loadMoreKey;
    renderPodcastEpisodes(holder, view);
  } catch (error) {
    if (state.podcastView !== view) return;
    holder.innerHTML = `<div class="empty">${esc(error.message)}<br /><button class="mini-button" data-retry-episodes>重新加载</button></div>`;
    holder.querySelector("[data-retry-episodes]")?.addEventListener("click", () => {
      holder.innerHTML = `<div class="loading">正在重新读取节目单集……</div>`;
      loadPodcastEpisodes(view);
    });
  }
}

function parseEpisodePage(response) {
  return {
    episodes: extractContent(response).filter((item) => episodeIdOf(item)),
    loadMoreKey: response?.loadMoreKey ?? null
  };
}

function renderPodcastEpisodes(holder, view) {
  const episodes = view.pages[view.page]?.episodes || [];
  holder.innerHTML = (episodes.length
    ? episodes.map((episode, index) => podcastEpisodeRow(episode, index)).join("")
    : `<div class="empty">这个节目暂时没有可展示的单集。</div>`)
    + (episodes.length ? renderEpisodePager(view) : "");
  bindPodcastEpisodeRows(holder, episodes);
  bindEpisodePager(holder, view);
}

function renderEpisodePager(view) {
  const total = view.exhausted ? view.pages.length : `${view.pages.length}+`;
  const atNewest = view.page === 0;
  const atOldest = view.exhausted && view.page === view.pages.length - 1;
  return `
    <div class="episode-pager">
      <button class="pager-button" type="button" data-pager-action="newest" ${atNewest ? "disabled" : ""}>首页</button>
      <button class="pager-button" type="button" data-pager-action="prev" ${atNewest ? "disabled" : ""}>◀</button>
      <span class="pager-indicator" data-pager-indicator>${view.page + 1} / ${total}</span>
      <button class="pager-button" type="button" data-pager-action="next" ${atOldest ? "disabled" : ""}>▶</button>
      <button class="pager-button" type="button" data-pager-action="oldest" ${atOldest ? "disabled" : ""}>尾页</button>
    </div>`;
}

function bindEpisodePager(holder, view) {
  $$("[data-pager-action]", holder).forEach((button) => button.addEventListener("click", () => handlePagerAction(view, button.dataset.pagerAction)));
}

async function handlePagerAction(view, action) {
  if (view.pagerBusy) return;
  if (action === "newest" || action === "prev") {
    const index = action === "newest" ? 0 : view.page - 1;
    if (index < 0) return;
    gotoPodcastEpisodePage(view, index);
    return;
  }
  if (action === "next") {
    if (view.page + 1 < view.pages.length) return gotoPodcastEpisodePage(view, view.page + 1);
    if (view.exhausted) return;
    view.pagerBusy = true;
    setPagerStatus(view, "读取中……");
    try {
      await loadNextEpisodePage(view);
    } catch (error) {
      if (state.podcastView === view) notify(error.message);
    } finally {
      view.pagerBusy = false;
    }
    if (state.podcastView === view) gotoPodcastEpisodePage(view, view.page + 1);
    return;
  }
  if (action === "oldest") {
    if (view.exhausted) return gotoPodcastEpisodePage(view, view.pages.length - 1);
    view.pagerBusy = true;
    setPagerStatus(view, "读取中……");
    try {
      while (!view.exhausted && state.podcastView === view) {
        await loadNextEpisodePage(view);
        setPagerStatus(view, `读取第 ${view.pages.length} 页……`);
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
    } catch (error) {
      if (state.podcastView === view) notify(error.message);
    } finally {
      view.pagerBusy = false;
    }
    if (state.podcastView === view) gotoPodcastEpisodePage(view, view.pages.length - 1);
  }
}

async function loadNextEpisodePage(view) {
  const cursor = view.pages[view.pages.length - 1]?.loadMoreKey;
  if (!cursor) {
    view.exhausted = true;
    return;
  }
  const response = await api("/episode_list", { pid: podcastIdOf(view.podcast), order: "desc", loadMoreKey: cursor });
  if (state.podcastView !== view) return;
  view.pages.push(parseEpisodePage(response));
  view.exhausted = !view.pages[view.pages.length - 1].loadMoreKey;
}

function gotoPodcastEpisodePage(view, index) {
  view.page = Math.max(0, Math.min(index, view.pages.length - 1));
  renderPodcastEpisodes($("#podcast-episodes"), view);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setPagerStatus(view, text) {
  const indicator = $("[data-pager-indicator]", $("#podcast-episodes"));
  if (indicator) indicator.textContent = text;
}

function podcastEpisodeRow(episode, index) {
  const published = episode?.pubDate || episode?.publishedAt || episode?.createdAt || "";
  const publishedText = published ? new Date(published).toLocaleDateString("zh-CN") : "节目单集";
  const secondaryActions = [
    `<button data-episode-action="download" role="menuitem">下载音频</button>`,
    `<button data-episode-action="transcribe" role="menuitem">${transcriptActionLabel()}</button>`,
    queueActions(episode, "data-episode-action"),
    `<button data-episode-action="copy-episode" role="menuitem">复制单集链接</button>`,
    `<button data-episode-action="copy-podcast" role="menuitem">复制节目链接</button>`
  ].join("");
  return `<article class="episode-row podcast-episode-row" data-index="${index}">
    <div class="episode-thumb">${imageOf(episode) ? `<img src="${esc(imageOf(episode))}" alt="" />` : ""}</div>
    <div class="episode-meta"><strong>${esc(titleOf(episode))}</strong><span>${esc(publishedText)}</span></div>
    <div class="row-actions">
      <button class="row-action" data-episode-action="play">播放</button>
      <button class="row-action" data-episode-action="view-podcast">查看节目</button>
      ${summaryActionButton(episode, "row-action is-primary", 'data-episode-action="summarize"')}
      ${moreActions(secondaryActions, "action-menu-row")}
    </div>
  </article>`;
}

function bindPodcastEpisodeRows(holder, episodes) {
  $$(".podcast-episode-row", holder).forEach((row) => row.addEventListener("click", (event) => {
    const episode = episodes[Number(row.dataset.index)];
    const control = event.target.closest("button, summary");
    if (!control) return browseEpisode(episode);
    if (control.tagName === "SUMMARY") return;
    const action = control.dataset.episodeAction;
    closeActionMenu(control);
    if (action === "play") playEpisode(episode);
    if (action === "queue" || action === "queue-next") addToQueue(episode, action === "queue-next");
    if (action === "view-podcast") openPodcast(episode);
    if (action === "summarize") summarizeEpisode(episode, control).catch((error) => notify(error.message));
    if (action === "copy-episode") copyEpisodeLink(episode);
    if (action === "copy-podcast") copyPodcastLink(episode);
    if (action === "download") downloadEpisodeAudio(episode);
    if (action === "transcribe") exportEpisodeTranscript(episode, control);
  }));
}

function renderSettingsPage(root) {
  const settings = state.settings || {};
  const activeSettingsTab = state.settingsTab || "files";
  const panelHidden = (id) => activeSettingsTab === id ? "" : "hidden";
  const audioPath = String(settings.audioDownloadPath || "");
  const transcriptPath = String(settings.transcriptDownloadPath || "");
  const summaryPath = String(settings.summaryDownloadPath || "");
  state.summaryPromptDrafts = (settings.summaryPromptVersions || []).map((prompt) => ({ ...prompt }));
  const summaryProviderOptions = SUMMARY_PROVIDERS.map(
    (provider) => `<option value="${provider.id}">${provider.label}</option>`
  ).join("");
  const summaryProviderPanels = SUMMARY_PROVIDERS.map((provider) => {
    const config = settings.summaryProviders?.[provider.id] || {};
    return `<div class="provider-settings" data-summary-provider-settings="${provider.id}">
      <label>${provider.label} API Key
        <div class="credential-row"><input id="summary-${provider.id}-api-key" type="password" placeholder="已保存则留空；输入新值会覆盖" autocomplete="new-password" /><button class="mini-button" type="button" data-clear-summary-key="${provider.keyField}">清除</button></div>
      </label>
      <label>API Base URL 或完整地址<input id="summary-${provider.id}-endpoint" type="url" value="${esc(config.endpoint || "")}" /></label>
      <label>模型<input id="summary-${provider.id}-model" type="text" value="${esc(config.model || "")}" /></label>
    </div>`;
  }).join("");
  root.innerHTML = `
    <section class="settings-page">
      <div class="section-heading"><h2>设置</h2><span>PREFERENCES</span></div>
      <nav class="settings-tabs" role="tablist" aria-label="设置分类">
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "files"}" data-settings-tab="files" class="${activeSettingsTab === "files" ? "is-active" : ""}">文件与助手</button>
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "asr"}" data-settings-tab="asr" class="${activeSettingsTab === "asr" ? "is-active" : ""}">文字稿与 ASR</button>
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "summary"}" data-settings-tab="summary" class="${activeSettingsTab === "summary" ? "is-active" : ""}">AI 总结</button>
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "advanced"}" data-settings-tab="advanced" class="${activeSettingsTab === "advanced" ? "is-active" : ""}">高级</button>
      </nav>
      <form id="settings-form" class="settings-form">
        <section class="settings-section settings-panel" data-settings-panel="files" ${panelHidden("files")}>
          <div class="settings-section-heading"><div><h3>文件与本地助手</h3></div><p>统一管理下载目录和 Native Host。</p></div>
          <label>音频保存目录
            <div class="path-input-row"><input id="audio-download-path" type="text" value="${esc(audioPath)}" placeholder="留空使用浏览器默认下载目录/小宇宙音频" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="audio-download-path">选择目录</button></div>
          </label>
          <p class="field-hint">实际位置：<code id="audio-path-preview"></code>。支持输入系统绝对路径或使用“选择目录”。</p>
          <label>文字稿保存目录
            <div class="path-input-row"><input id="transcript-download-path" type="text" value="${esc(transcriptPath)}" placeholder="留空使用浏览器默认下载目录/小宇宙转写稿" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="transcript-download-path">选择目录</button></div>
          </label>
          <p class="field-hint">实际位置：<code id="transcript-path-preview"></code>。</p>
          <label>AI 总结稿保存目录
            <div class="path-input-row"><input id="summary-download-path" type="text" value="${esc(summaryPath)}" placeholder="留空使用文字稿保存目录" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="summary-download-path">选择目录</button></div>
          </label>
          <p class="field-hint">实际位置：<code id="summary-path-preview"></code>。三个目录可分别配置。</p>
          <label class="checkbox-row"><input id="download-save-as" type="checkbox" ${settings.downloadSaveAs ? "checked" : ""} /><span>使用浏览器默认目录时，每次下载询问保存位置</span></label>
          <div id="native-host-status" class="native-host-status">正在检测本地文件助手……</div>
          <div class="native-install-guide">
            <strong id="native-install-title">本地助手安装</strong>
            <p id="native-install-description">正在识别操作系统并生成安装指令……</p>
          </div>
          <div id="native-host-diagnostics" class="native-host-diagnostics">
            <div><span>系统</span><code id="native-platform">检测中…</code></div>
            <div><span>扩展 ID</span><code id="native-extension-id">检测中…</code></div>
            <div><span>Manifest</span><code id="native-manifest-path">检测中…</code></div>
            <div><span>Host</span><code id="native-host-path">检测中…</code></div>
            <div><span>安装命令</span><code id="native-install-command">检测中…</code></div>
            <div class="native-host-actions">
              <button id="copy-native-install-command" class="mini-button" type="button">复制安装命令</button>
              <a id="native-host-help" href="https://github.com/QWE38qwe/xiaoyuzhou-desktop#3-安装-native-host" target="_blank" rel="noreferrer">查看安装说明</a>
            </div>
          </div>
        </section>
        <section class="settings-section settings-panel" data-settings-panel="asr" ${panelHidden("asr")}>
          <div class="settings-section-heading"><div><h3>文字稿与 ASR</h3></div><p>优先导出小宇宙官方文字稿；ASR 可按需启用。</p></div>
          <label>默认文字稿来源<select id="transcript-source"><option value="official">小宇宙官方文字稿（默认）</option><option value="asr">ASR 生成</option></select></label>
          <p id="official-transcript-hint" class="field-hint">有官方文字稿时会直接导出，并按节目 Show Notes 时间戳生成可跳转章节；本集没有官方稿时不会自动调用 ASR。</p>
          <div id="asr-settings-wrap">
          <label>ASR 服务<select id="asr-provider"><option value="local_qwen">本地 Qwen3-ASR</option><option value="qwen">Qwen API</option><option value="doubao">豆包 API</option></select></label>
          <div class="provider-settings" data-asr-provider-settings="local_qwen">
            <label>本地模型<select id="local-qwen-model"><option value="Qwen/Qwen3-ASR-0.6B">Qwen3-ASR 0.6B（推荐，约 1.2GB 内存）</option><option value="Qwen/Qwen3-ASR-1.7B">Qwen3-ASR 1.7B（高精度，约 3.4GB 内存）</option></select></label>
            <div id="local-qwen-status" class="native-host-status">正在检查本地 Qwen ASR……</div>
            <div class="setup-steps">
              <div><strong>1. 连接本地助手</strong><span>先在“文件与助手”完成 Native Host 安装。</span></div>
              <div><strong>2. 安装 0.6B 运行时</strong><span>推荐 Apple Silicon Mac 新用户使用，约需 1.2GB 运行内存。</span></div>
              <div><strong>3. 首次下载模型</strong><span>第一次转写会下载模型；后续直接复用缓存。</span></div>
              <div><strong>4. 按任务释放内存</strong><span>每次转写结束后 Worker 自动退出，不常驻后台。</span></div>
            </div>
            <div class="install-command-row"><code id="local-qwen-install-command">./install_local_asr.sh</code><button id="copy-local-asr-command" class="mini-button" type="button">复制安装命令</button></div>
            <p class="field-hint">Windows 暂不支持 MLX 本地模型，将自动引导使用 Qwen API 或豆包 API。</p>
          </div>
          <div class="provider-settings" data-asr-provider-settings="qwen">
            <label>Qwen API Key<input id="qwen-api-key" type="password" placeholder="已保存则留空；输入新值会覆盖" autocomplete="new-password" /></label>
            <label>API Base URL 或完整地址<input id="qwen-asr-endpoint" type="url" value="${esc(settings.qwenAsrEndpoint || "")}" placeholder="https://dashscope.aliyuncs.com/api/v1" /></label>
            <label>模型<input id="qwen-asr-model" type="text" list="qwen-asr-model-options" value="${esc(settings.qwenAsrModel || "qwen-audio-3.0-asr-flash-filetrans")}" /></label>
            <datalist id="qwen-asr-model-options">
              <option value="qwen-audio-3.0-asr-flash-filetrans"></option>
              <option value="fun-asr"></option>
              <option value="fun-asr-flash-2026-06-15"></option>
              <option value="qwen3-asr-flash-filetrans"></option>
              <option value="qwen3-asr-flash"></option>
            </datalist>
            <p class="field-hint">程序会按模型自动选择异步文件转写、DashScope 同步或 OpenAI-compatible 路径。长播客推荐 <code>qwen-audio-3.0-asr-flash-filetrans</code>；Fun-ASR-Flash 单次最多 5 分钟。</p>
          </div>
          <div class="provider-settings" data-asr-provider-settings="doubao">
            <label>豆包 API Key<input id="doubao-api-key" type="password" placeholder="已保存则留空；输入新值会覆盖" autocomplete="new-password" /></label>
            <label>接口地址<input id="doubao-asr-endpoint" type="url" value="${esc(settings.doubaoAsrEndpoint || "")}" /></label>
            <label>Resource ID<input id="doubao-asr-resource-id" type="text" value="${esc(settings.doubaoAsrResourceId || "volc.bigasr.auc_turbo")}" /></label>
          </div>
          <div id="asr-provider-status" class="native-host-status">正在检查 API 配置……</div>
          <p class="field-hint">转写稿优先保留模型返回的完整标点；模型未返回标点时，会依据语音片段停顿补充基础逗号和句号。</p>
          <p class="field-hint">API Key 由 Native Host 保存在 <span id="credential-storage-label">系统安全凭据存储</span>，扩展不会回显完整密钥。转写会将音频 URL 或音频内容发送至所选服务。</p>
          </div>
        </section>
        <section class="settings-section settings-panel summary-settings-section" data-settings-panel="summary" ${panelHidden("summary")}>
          <div class="settings-section-heading"><div><h3>AI 总结</h3></div><p>配置模型、评论补充和 Prompt。</p></div>
          <label>总结服务<select id="summary-provider">${summaryProviderOptions}</select></label>
          ${summaryProviderPanels}
          <label class="checkbox-row"><input id="summary-include-comments" type="checkbox" ${settings.summaryIncludeComments ? "checked" : ""} /><span>总结时补充评论区中的有效观点</span></label>
          <p class="field-hint">默认关闭。开启后会读取当前单集的公开评论，过滤“沙发、终于更新、等了好久”等低信息内容，再将有效评论发送给当前 AI Provider。</p>
          <div id="summary-provider-status" class="native-host-status">正在检查 AI API 配置……</div>
          <div class="summary-run-row">
            <button id="choose-summary-transcript" class="secondary-button" type="button">选择已有转写稿并总结</button>
            <span id="summary-action-status" class="field-hint">长转写稿会自动分段汇总。</span>
          </div>
          <div class="prompt-manager">
            <div class="prompt-manager-heading">
              <div><div class="route-eyebrow">PROMPT VERSIONS</div><strong>总结 Prompt 版本</strong></div>
              <span id="active-prompt-badge" class="prompt-badge"></span>
            </div>
            <label>选择版本<select id="summary-prompt-select"></select></label>
            <div class="prompt-meta-grid">
              <label>名称<input id="summary-prompt-name" type="text" maxlength="80" /></label>
              <label>版本<input id="summary-prompt-version" type="text" maxlength="32" /></label>
            </div>
            <label>Prompt<textarea id="summary-prompt-content" rows="18" maxlength="20000"></textarea></label>
            <div class="prompt-actions">
              <button id="clone-summary-prompt" class="secondary-button" type="button">复制为新版本</button>
              <button id="activate-summary-prompt" class="mini-button" type="button">设为当前</button>
              <button id="delete-summary-prompt" class="mini-button is-danger" type="button">删除版本</button>
            </div>
            <p class="field-hint">内置版本只读；自定义版本保存在 Chrome 本地存储。支持占位符 <code>{{title}}</code>。</p>
          </div>
        </section>
        <section class="settings-section settings-panel" data-settings-panel="advanced" ${panelHidden("advanced")}>
          <div class="settings-section-heading"><div><h3>高级设置</h3></div><p>请求路由与代理配置。</p></div>
          <label>请求模式<select id="api-mode"><option value="direct">扩展直连（本地开发）</option><option value="proxy">受控代理（生产推荐）</option></select></label>
          <label>代理地址<input id="proxy-url" type="url" value="${esc(settings.proxyBaseUrl || "")}" placeholder="https://your-proxy.example.com" /></label>
          <p class="field-hint">请勿将代理地址指向不可信服务。</p>
        </section>
        <button class="primary-button settings-save" type="submit">保存设置</button>
      </form>
    </section>`;
  $$("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => {
    state.settingsTab = button.dataset.settingsTab;
    $$("[data-settings-tab]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
    });
    $$("[data-settings-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== state.settingsTab;
    });
  }));
  $("#api-mode").value = settings.apiMode || "direct";
  $("#transcript-source").value = settings.transcriptSource || "official";
  $("#asr-provider").value = settings.asrProvider || "qwen";
  $("#local-qwen-model").value = settings.localQwenModel || "Qwen/Qwen3-ASR-0.6B";
  let nativeStatus = null;
  const renderLocalQwenStatus = () => {
    const localNode = $("#local-qwen-status");
    if (!localNode || !nativeStatus) return;
    const model = $("#local-qwen-model").value;
    const cached = Boolean(nativeStatus.localQwen?.cachedModels?.[model]);
    const supported = nativeStatus.localQwen?.supported !== false;
    localNode.classList.toggle("is-ready", nativeStatus.localQwen?.available);
    localNode.textContent = !supported
      ? nativeStatus.localQwen?.reason || "当前系统不支持本地 Qwen3-ASR"
      : nativeStatus.localQwen?.available
      ? `本地运行时已安装 · 当前模型${cached ? "已缓存" : "将在首次使用时下载"}`
      : "本地运行时未安装，请执行 ./install_local_asr.sh";
  };
  $("#local-qwen-model").addEventListener("change", renderLocalQwenStatus);
  const updateAsrProviderSettings = () => {
    $$("[data-asr-provider-settings]").forEach((node) => {
      node.hidden = node.dataset.asrProviderSettings !== $("#asr-provider").value;
    });
  };
  const updateTranscriptSourceSettings = () => {
    const usingAsr = $("#transcript-source").value === "asr";
    $("#asr-settings-wrap").hidden = !usingAsr;
    $("#official-transcript-hint").hidden = usingAsr;
  };
  updateAsrProviderSettings();
  updateTranscriptSourceSettings();
  $("#asr-provider").addEventListener("change", updateAsrProviderSettings);
  $("#transcript-source").addEventListener("change", updateTranscriptSourceSettings);
  $("#summary-provider").value = settings.summaryProvider || "qwen";
  const updateSummaryProviderSettings = () => {
    $$("[data-summary-provider-settings]").forEach((node) => {
      node.hidden = node.dataset.summaryProviderSettings !== $("#summary-provider").value;
    });
  };
  updateSummaryProviderSettings();
  $("#summary-provider").addEventListener("change", updateSummaryProviderSettings);
  initializeSummaryPromptManager(settings.activeSummaryPromptId);
  const updatePreview = () => {
    const audioValue = $("#audio-download-path").value.trim();
    const transcriptValue = $("#transcript-download-path").value.trim();
    const summaryValue = $("#summary-download-path").value.trim();
    $("#audio-path-preview").textContent = audioValue || "浏览器默认下载目录/小宇宙音频";
    $("#transcript-path-preview").textContent = transcriptValue || "浏览器默认下载目录/小宇宙转写稿";
    $("#summary-path-preview").textContent = summaryValue || transcriptValue || "浏览器默认下载目录/小宇宙转写稿";
    $("#download-save-as").disabled = Boolean(audioValue);
  };
  updatePreview();
  $("#audio-download-path").addEventListener("input", updatePreview);
  $("#transcript-download-path").addEventListener("input", updatePreview);
  $("#summary-download-path").addEventListener("input", updatePreview);
  $$("[data-choose-directory]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const prompts = {
        "audio-download-path": "请选择音频保存目录",
        "transcript-download-path": "请选择文字稿保存目录",
        "summary-download-path": "请选择 AI 总结稿保存目录"
      };
      const prompt = prompts[button.dataset.chooseDirectory] || "请选择保存目录";
      const data = await send("choose-native-directory", { prompt });
      $(`#${button.dataset.chooseDirectory}`).value = data.path;
      updatePreview();
    } catch (error) {
      notify(error.message);
    }
  }));
  $("#copy-native-install-command").addEventListener("click", async () => {
    const command = $("#native-install-command").textContent;
    try {
      await navigator.clipboard.writeText(command);
      notify("Native Host 安装命令已复制");
    } catch {
      notify(command);
    }
  });
  $("#copy-local-asr-command").addEventListener("click", async () => {
    const command = $("#local-qwen-install-command").textContent;
    if (!command || command === "当前系统不支持") {
      notify("Windows 暂不支持本地 Qwen3-ASR，请使用 API 模式");
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      notify("本地 Qwen 安装命令已复制");
    } catch {
      notify(command);
    }
  });
  $$("[data-clear-summary-key]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("确认从系统安全凭据存储中删除这个 AI 总结 API Key？")) return;
    try {
      const status = await send("save-summary-credentials", {
        clearKeys: [button.dataset.clearSummaryKey]
      });
      renderSummaryProviderStatus(status.summaryConfigured || {});
      notify("API Key 已从 Keychain 删除");
    } catch (error) {
      notify(error.message);
    }
  }));
  $("#choose-summary-transcript").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      button.disabled = true;
      button.textContent = "选择中…";
      const selected = await send("import-summary-transcript");
      await summarizeTranscriptPath(selected.path, button, $("#summary-action-status"));
    } catch (error) {
      $("#summary-action-status").textContent = error.message;
      notify(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "选择已有转写稿并总结";
    }
  });
  $("#settings-form").addEventListener("submit", saveSettings);
  send("get-native-host-status").then((status) => {
    nativeStatus = status;
    const node = $("#native-host-status");
    if (!node) return;
    node.classList.toggle("is-ready", status.available);
    node.textContent = status.available
      ? `本地文件助手已连接 · ${status.version || "可用"}`
      : `本地文件助手未连接，目录选择、ASR 和 AI 总结不可用。${status.error || ""}`;
    const isWindows = status.platform === "windows";
    $("#native-platform").textContent = isWindows ? "Windows" : "macOS";
    $("#native-install-title").textContent = isWindows
      ? "Windows 安装步骤"
      : "macOS 安装步骤";
    $("#native-install-description").textContent = isWindows
      ? "先安装 Python 3 并勾选 Add Python to PATH；随后在项目目录用 PowerShell 执行下方命令，完成后在 chrome://extensions 重新加载扩展。"
      : "在项目目录用终端执行下方命令；完成后重新加载扩展。";
    $("#native-extension-id").textContent = status.extensionId || "未知";
    $("#native-manifest-path").textContent = status.manifestPath || "未知";
    $("#native-host-path").textContent = status.hostPath || "未知";
    $("#native-install-command").textContent = status.installCommand || "未知";
    $("#native-host-help").href = status.helpUrl;
    $("#credential-storage-label").textContent = status.credentialStorage
      || (isWindows ? "Windows DPAPI" : "macOS Keychain");
    const localOption = $("#asr-provider option[value=local_qwen]");
    const localSupported = status.localQwen?.supported !== false && !isWindows;
    localOption.disabled = !localSupported;
    $("#local-qwen-install-command").textContent = localSupported
      ? status.localAsrInstallCommand || "./install_local_asr.sh"
      : "当前系统不支持";
    $("#copy-local-asr-command").disabled = !localSupported;
    if (!localSupported && $("#asr-provider").value === "local_qwen") {
      $("#asr-provider").value = "qwen";
      updateAsrProviderSettings();
      notify("Windows 暂不支持本地 Qwen3-ASR，已切换到 Qwen API");
    }
    $$("[data-choose-directory]").forEach((button) => {
      button.disabled = !status.available;
      button.title = status.available ? "" : "请先安装并连接 Native Host";
    });
    $("#choose-summary-transcript").disabled = !status.available;
    const providerNode = $("#asr-provider-status");
    if (!providerNode) return;
    providerNode.classList.toggle("is-ready", status.qwenConfigured || status.doubaoConfigured || status.localQwen?.available);
    providerNode.textContent = `本地 Qwen：${status.localQwen?.available ? "已安装" : "未安装"} · Qwen API：${status.qwenConfigured ? "已配置" : "未配置"} · 豆包 API：${status.doubaoConfigured ? "已配置" : "未配置"}`;
    renderLocalQwenStatus();
    renderSummaryProviderStatus(status.summaryConfigured || {});
  });
}

function renderSummaryProviderStatus(configured = {}) {
  const node = $("#summary-provider-status");
  if (!node) return;
  const configuredCount = SUMMARY_PROVIDERS.filter((provider) => configured[provider.id]).length;
  node.classList.toggle("is-ready", configuredCount > 0);
  node.textContent = SUMMARY_PROVIDERS.map(
    (provider) => `${provider.label}：${configured[provider.id] ? "已配置" : "未配置"}`
  ).join(" · ");
}

function incrementPromptVersion(value) {
  const parts = String(value || "1.0.0").split(".");
  const last = Number(parts[parts.length - 1]);
  if (Number.isInteger(last)) {
    parts[parts.length - 1] = String(last + 1);
    return parts.join(".");
  }
  return `${value || "1.0.0"}.1`;
}

function summaryPromptById(id) {
  return state.summaryPromptDrafts.find((prompt) => prompt.id === id);
}

function syncSummaryPromptEditor() {
  const prompt = summaryPromptById(state.summaryPromptEditorId);
  if (!prompt || prompt.builtin || !$("#summary-prompt-content")) return;
  prompt.name = $("#summary-prompt-name").value.trim() || "自定义总结 Prompt";
  prompt.version = $("#summary-prompt-version").value.trim() || "1.0.0";
  prompt.content = $("#summary-prompt-content").value.trim();
}

function refreshSummaryPromptSelect(selectedId) {
  const select = $("#summary-prompt-select");
  select.innerHTML = state.summaryPromptDrafts.map((prompt) =>
    `<option value="${esc(prompt.id)}">${esc(prompt.name)} · v${esc(prompt.version)}${prompt.builtin ? "（内置）" : ""}</option>`
  ).join("");
  select.value = selectedId;
}

function loadSummaryPromptEditor(id) {
  const prompt = summaryPromptById(id) || state.summaryPromptDrafts[0];
  if (!prompt) return;
  state.summaryPromptEditorId = prompt.id;
  $("#summary-prompt-select").value = prompt.id;
  $("#summary-prompt-name").value = prompt.name;
  $("#summary-prompt-version").value = prompt.version;
  $("#summary-prompt-content").value = prompt.content;
  $("#summary-prompt-name").readOnly = Boolean(prompt.builtin);
  $("#summary-prompt-version").readOnly = Boolean(prompt.builtin);
  $("#summary-prompt-content").readOnly = Boolean(prompt.builtin);
  $("#delete-summary-prompt").disabled = Boolean(prompt.builtin);
  $("#activate-summary-prompt").disabled = prompt.id === state.settings.activeSummaryPromptId;
  const active = summaryPromptById(state.settings.activeSummaryPromptId) || state.summaryPromptDrafts[0];
  $("#active-prompt-badge").textContent = active
    ? `当前：${active.name} v${active.version}`
    : "未选择";
}

function initializeSummaryPromptManager(activeId) {
  if (!state.summaryPromptDrafts.length) return;
  state.settings.activeSummaryPromptId = activeId || state.summaryPromptDrafts[0].id;
  refreshSummaryPromptSelect(state.settings.activeSummaryPromptId);
  loadSummaryPromptEditor(state.settings.activeSummaryPromptId);
  $("#summary-prompt-select").addEventListener("change", (event) => {
    syncSummaryPromptEditor();
    loadSummaryPromptEditor(event.target.value);
  });
  $("#clone-summary-prompt").addEventListener("click", () => {
    syncSummaryPromptEditor();
    const source = summaryPromptById(state.summaryPromptEditorId) || state.summaryPromptDrafts[0];
    const copy = {
      id: `custom-${crypto.randomUUID()}`,
      name: `${source.name} 副本`,
      version: incrementPromptVersion(source.version),
      content: source.content,
      builtin: false
    };
    state.summaryPromptDrafts.push(copy);
    refreshSummaryPromptSelect(copy.id);
    loadSummaryPromptEditor(copy.id);
  });
  $("#activate-summary-prompt").addEventListener("click", () => {
    syncSummaryPromptEditor();
    state.settings.activeSummaryPromptId = state.summaryPromptEditorId;
    loadSummaryPromptEditor(state.summaryPromptEditorId);
    notify("已设为当前 Prompt，保存设置后生效");
  });
  $("#delete-summary-prompt").addEventListener("click", () => {
    const prompt = summaryPromptById(state.summaryPromptEditorId);
    if (!prompt || prompt.builtin || !confirm(`确认删除 Prompt 版本“${prompt.name}”？`)) return;
    state.summaryPromptDrafts = state.summaryPromptDrafts.filter((item) => item.id !== prompt.id);
    if (state.settings.activeSummaryPromptId === prompt.id) {
      state.settings.activeSummaryPromptId = state.summaryPromptDrafts[0].id;
    }
    refreshSummaryPromptSelect(state.settings.activeSummaryPromptId);
    loadSummaryPromptEditor(state.settings.activeSummaryPromptId);
  });
}

function podcastLinkOf(item) {
  const pid = podcastIdOf(item);
  return pid ? `https://www.xiaoyuzhoufm.com/podcast/${pid}` : "";
}

function episodeLinkOf(item) {
  const eid = episodeIdOf(item);
  return eid ? `https://www.xiaoyuzhoufm.com/episode/${eid}` : "";
}

function renderPlayerAnchors(item = null) {
  const holder = $("#progress-anchors");
  if (!holder) return;
  const timeline = item ? XYZEpisodeContent.extractTimeline(episodeContentOf(item)) : [];
  const audioDuration = Number($("#audio")?.duration);
  const duration = Number.isFinite(audioDuration) && audioDuration > 0
    ? audioDuration
    : durationOf(item) || (timeline.at(-1)?.seconds || 0);
  holder.innerHTML = duration > 0
    ? timeline.map((entry) => {
      const left = Math.max(0, Math.min(100, entry.seconds / duration * 100));
      const tooltip = `${entry.label} ${entry.text || "继续收听"}`;
      return `<button
        type="button"
        style="--anchor-position:${left}%"
        data-progress-seconds="${entry.seconds}"
        data-tooltip="${esc(tooltip)}"
        title="${esc(tooltip)}"
        aria-label="${esc(`跳转到 ${entry.label} ${entry.text || ""}`)}"
      ></button>`;
    }).join("")
    : "";
  $$("[data-progress-seconds]", holder).forEach((button) => {
    button.addEventListener("click", () => seekToTimestamp(item, button.dataset.progressSeconds, { scroll: true }));
  });
  updateActiveProgressAnchor($("#audio")?.currentTime || 0);
}

function updateActiveProgressAnchor(seconds) {
  const anchors = $$("[data-progress-seconds]");
  let active = null;
  anchors.forEach((anchor) => {
    anchor.classList.remove("is-active");
    if (Number(anchor.dataset.progressSeconds) <= seconds + 0.25) active = anchor;
  });
  active?.classList.add("is-active");
}

async function copyLink(url, label) {
  if (!url) return notify(`当前没有可复制的${label}链接`);
  try { await navigator.clipboard.writeText(url); notify("链接已复制"); } catch { notify(url); }
}

function copyEpisodeLink(item) {
  return copyLink(episodeLinkOf(item), "单集");
}

function copyPodcastLink(item) {
  return copyLink(podcastLinkOf(item), "节目");
}

function updatePlayerLinkButtons(item = null) {
  const hasAudio = Boolean(audioOf(item));
  const canExportOfficialTranscript = Boolean(episodeIdOf(item));
  const canExportTranscript = state.settings?.transcriptSource === "asr"
    ? hasAudio
    : canExportOfficialTranscript;
  const summaryButton = $("#summarize-button");
  const summarized = Boolean(summaryRecordOf(item));
  $("#download-audio-button").disabled = !hasAudio;
  $("#transcribe-audio-button").disabled = !canExportTranscript;
  $("#transcribe-audio-button").textContent = transcriptActionLabel();
  $("#transcribe-audio-button").title = transcriptSourceLabel();
  summaryButton.disabled = !canExportTranscript;
  summaryButton.textContent = summarized ? "已 AI 总结" : "AI 总结";
  summaryButton.classList.toggle("is-complete", summarized);
  summaryButton.title = summarized
    ? "已有总结，再次点击可重新生成"
    : "导出文字稿并总结当前单集";
  $("#view-podcast-button").disabled = !podcastIdOf(item);
  $("#copy-episode-link-button").disabled = !episodeLinkOf(item);
  $("#copy-podcast-link-button").disabled = !podcastLinkOf(item);
}

async function resolveEpisode(item) {
  if (!item) return;
  let eid = episodeIdOf(item);
  let episode = item;
  if (!eid && podcastIdOf(item)) {
    const response = await api("/episode_list", { pid: podcastIdOf(item), order: "desc" });
    const episodes = extractContent(response).filter((candidate) => episodeIdOf(candidate));
    episode = episodes[0] || item;
    eid = episodeIdOf(episode);
  }
  if (eid && state.episodeDetails.has(eid)) {
    return state.episodeDetails.get(eid);
  }
  if (eid) {
    if (!state.episodeRequests.has(eid)) {
      state.episodeRequests.set(eid, api("/episode_detail", { eid }, "GET")
        .then(unwrapDetail).finally(() => state.episodeRequests.delete(eid)));
    }
    try {
      const detail = await state.episodeRequests.get(eid);
      episode = {
        ...episode,
        ...detail,
        podcast: detail?.podcast || episode?.podcast
      };
      state.episodeDetails.set(eid, episode);
    } catch (error) {
      if (!audioOf(episode)) throw error;
      episode = { ...episode, detailLoadError: error.message };
    }
  }
  return episode;
}

async function downloadEpisodeAudio(item) {
  try {
    const episode = await resolveEpisode(item);
    const audio = audioOf(episode);
    if (!audio) return notify("这集暂时没有可下载的音频地址");
    const result = await send("download-audio", { payload: { url: audio, filename: audioFilenameOf(episode) } });
    if (result?.path) notify(`音频已保存：${result.path}`);
    else notify(state.settings?.downloadSaveAs ? "请选择本地保存位置" : "已开始下载音频");
  } catch (error) {
    notify(error.message);
  }
}

function transcriptSourceLabel(source = state.settings?.transcriptSource) {
  return source === "asr" ? asrProviderLabel() : "小宇宙官方文字稿";
}

function transcriptTimelineOf(episode) {
  return XYZEpisodeContent.extractTimeline(episodeContentOf(episode))
    .map((entry) => ({
      seconds: entry.seconds,
      label: entry.label,
      title: entry.text || ""
    }));
}

function rememberTranscriptExport(episode, result) {
  const transcriptPath = result.markdown || result.md || result.txt;
  if (!transcriptPath) throw new Error("文字稿导出完成但未返回文件路径");
  state.currentTranscriptPath = transcriptPath;
  state.currentTranscriptEpisodeId = episodeIdOf(episode);
  state.currentTranscriptSegments = [];
  state.currentSummaryPath = "";
  return transcriptPath;
}

async function exportOfficialEpisodeTranscript(item, button = null, { propagate = false } = {}) {
  const originalText = button?.textContent;
  try {
    const episode = await resolveEpisode(item);
    const eid = episodeIdOf(episode);
    if (!eid) throw new Error("无法识别需要导出文字稿的单集");
    if (button) {
      button.disabled = true;
      button.textContent = "导出中…";
    }
    setTranscriptionStatus("正在导出小宇宙官方文字稿，请保持窗口打开");
    notify("正在导出小宇宙官方文字稿");
    const filename = audioFilenameOf(episode);
    const result = await send("export-official-transcript", {
      payload: {
        episodeId: eid,
        baseName: filename.replace(/\.[^.]+$/, ""),
        episodeUrl: episodeLinkOf(episode),
        timeline: transcriptTimelineOf(episode)
      }
    });
    const transcriptPath = rememberTranscriptExport(episode, result);
    const timestampNote = result.chapterCount
      ? ` · 已按节目时间轴整理为 ${result.chapterCount} 个章节`
      : " · 节目未提供时间轴，已输出连续文稿";
    setTranscriptionStatus(`官方文字稿导出完成${timestampNote}：${transcriptPath}`, "success");
    notify(`官方文字稿已导出：${transcriptPath}`);
    return transcriptPath;
  } catch (error) {
    setTranscriptionStatus(`文字稿导出失败：${error.message}`, "error");
    if (!propagate) notify(error.message);
    if (propagate) throw error;
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function transcribeEpisodeAudio(item, button = null, { propagate = false } = {}) {
  const originalText = button?.textContent;
  try {
    const episode = await resolveEpisode(item);
    const audio = audioOf(episode);
    if (!audio) throw new Error("这集暂时没有可转写的音频地址");
    if (button) {
      button.disabled = true;
      button.textContent = "转写中…";
    }
    const providerLabel = state.settings?.asrProvider === "local_qwen"
      ? "本地 Qwen"
      : state.settings?.asrProvider === "doubao"
        ? "豆包"
        : "Qwen";
    setTranscriptionStatus(`${providerLabel} 长音频转写中，请保持窗口打开`);
    notify(`${providerLabel} ASR 正在转写，请保持窗口打开`);
    const filename = audioFilenameOf(episode);
    const result = await send("transcribe-audio", {
      payload: {
        url: audio,
        filename,
        baseName: filename.replace(/\.[^.]+$/, ""),
        language: "zh",
        episodeId: episodeIdOf(episode),
        episodeUrl: episodeLinkOf(episode),
        timeline: transcriptTimelineOf(episode)
      }
    });
    const transcriptPath = rememberTranscriptExport(episode, result);
    const timestampNote = result.chapterCount
      ? ` · 已按节目时间轴整理为 ${result.chapterCount} 个章节`
      : " · 节目未提供时间轴，已输出连续文稿";
    setTranscriptionStatus(`转写完成${timestampNote}：${transcriptPath}`, "success");
    notify(`转写完成：${transcriptPath}`);
    return transcriptPath;
  } catch (error) {
    setTranscriptionStatus(`转写失败：${error.message}`, "error");
    if (!propagate) notify(error.message);
    if (propagate) throw error;
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function exportEpisodeTranscript(item, button = null, options = {}) {
  return state.settings?.transcriptSource === "asr"
    ? transcribeEpisodeAudio(item, button, options)
    : exportOfficialEpisodeTranscript(item, button, options);
}

function summaryProviderLabel(providerId = state.settings?.summaryProvider) {
  return SUMMARY_PROVIDERS.find((provider) => provider.id === providerId)?.label || providerId || "AI Provider";
}

function asrProviderLabel(providerId = state.settings?.asrProvider) {
  return {
    local_qwen: "本机 Qwen3-ASR（音频不外发）",
    qwen: "Qwen API",
    doubao: "豆包 API"
  }[providerId] || "当前 ASR 服务";
}

function ensureSummaryConsent() {
  if (state.settings?.summaryConsentAccepted) return Promise.resolve(true);
  const dialog = $("#summary-consent-dialog");
  $("#summary-consent-provider").textContent = summaryProviderLabel();
  $("#summary-consent-asr").textContent = transcriptSourceLabel();
  $("#summary-consent-comments").textContent = state.settings?.summaryIncludeComments
    ? "筛选后的公开评论也会一并发送。"
    : "评论不会被读取或发送。";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    dialog.addEventListener("close", () => finish(false), { once: true });
    $("#summary-consent-confirm").onclick = async () => {
      try {
        state.settings = await send("update-settings", {
          settings: { summaryConsentAccepted: true }
        });
        finish(true);
        dialog.close();
      } catch (error) {
        notify(error.message);
      }
    };
    dialog.showModal();
  });
}

function ensureResummarize(episode) {
  const record = summaryRecordOf(episode);
  if (!record) return Promise.resolve(true);
  const dialog = $("#resummarize-dialog");
  const createdAt = record.createdAt
    ? new Date(record.createdAt).toLocaleString("zh-CN")
    : "此前";
  $("#resummarize-detail").textContent = `${createdAt} 已生成过总结。`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    dialog.addEventListener("close", () => finish(false), { once: true });
    $("#resummarize-confirm").onclick = () => {
      finish(true);
      dialog.close();
    };
    dialog.showModal();
  });
}

async function summarizeTranscriptPath(
  transcriptPath,
  button = null,
  statusNode = null,
  { skipConsent = false, episodeId = "" } = {}
) {
  if (!transcriptPath) throw new Error("请先生成或选择 Markdown 转写稿");
  if (!skipConsent && !await ensureSummaryConsent()) return null;
  const originalText = button?.textContent;
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "总结中…";
    }
    if (statusNode) statusNode.textContent = `${summaryProviderLabel()} 正在总结，请保持窗口打开`;
    setTranscriptionStatus(`${summaryProviderLabel()} AI 正在总结，请保持窗口打开`);
    const result = await send("summarize-transcript", {
      payload: { transcriptPath, episodeId }
    });
    const summaryPath = result.markdown;
    if (!summaryPath) throw new Error("AI 总结完成但未返回 Markdown 路径");
    state.currentSummaryPath = summaryPath;
    if (episodeId) {
      state.summaryHistory.set(episodeId, {
        markdown: summaryPath,
        provider: result.provider,
        model: result.model,
        createdAt: new Date().toISOString(),
        commentCount: result.commentCount || 0
      });
      refreshSummaryIndicators(episodeId);
    }
    const commentNote = result.commentWarning
      ? `；评论补充失败：${result.commentWarning}`
      : result.commentCount
        ? `；已补充 ${result.commentCount} 条有效评论`
        : "";
    if (statusNode) statusNode.textContent = `总结完成${commentNote}：${summaryPath}`;
    setTranscriptionStatus(`AI 总结完成${commentNote}：${summaryPath}`, "success");
    notify(`AI 总结完成${commentNote}`);
    return result;
  } catch (error) {
    if (statusNode) statusNode.textContent = `总结失败：${error.message}`;
    setTranscriptionStatus(`AI 总结失败：${error.message}`, "error");
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      const completed = episodeId && state.summaryHistory.has(episodeId);
      button.textContent = completed ? "已 AI 总结" : originalText;
      button.classList.toggle("is-complete", Boolean(completed));
    }
  }
}

async function summarizeEpisode(item, button = null) {
  const episode = await resolveEpisode(item);
  const eid = episodeIdOf(episode);
  if (!eid) throw new Error("无法识别需要总结的单集");
  if (!await ensureResummarize(episode)) return null;
  if (!await ensureSummaryConsent()) return null;
  const hasMatchingTranscript = (
    state.currentTranscriptPath
    && state.currentTranscriptEpisodeId === eid
  );
  const transcriptPath = hasMatchingTranscript
    ? state.currentTranscriptPath
    : await exportEpisodeTranscript(episode, button, { propagate: true });
  return summarizeTranscriptPath(
    transcriptPath,
    button,
    null,
    { skipConsent: true, episodeId: eid }
  );
}

async function browseEpisode(item) {
  const eid = episodeIdOf(item);
  if (!eid) return;
  const cached = state.episodeDetails.get(eid);
  const view = {
    episode: cached || item,
    loading: !cached,
    scrollY: state.episodeView?.scrollY ?? window.scrollY
  };
  state.episodeView = view;
  $("#route-eyebrow").textContent = "EPISODE NOTES";
  $("#route-title").textContent = titleOf(view.episode);
  $("#back-button").hidden = false;
  renderRoute();
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (!view.loading) return;
  try {
    view.episode = await resolveEpisode(item);
    view.error = view.episode.detailLoadError;
  } catch (error) {
    view.error = error.message;
  }
  if (state.episodeView !== view) return;
  view.loading = false;
  $("#route-title").textContent = titleOf(view.episode);
  renderRoute();
}

function isPlaying(episode) {
  return Boolean(episode && episodeIdOf(episode) === episodeIdOf(state.current) && !$("#audio").paused);
}

function renderPlaybackButtons() {
  $("#play-button").textContent = isPlaying(state.current) ? "Ⅱ" : "▶";
  $("[data-toggle-current-play]")?.replaceChildren(isPlaying(state.episodeView?.episode) ? "暂停" : "播放");
}

function togglePlayback(episode) {
  if (!episode) {
    if (state.queue.length) return playNextInQueue();
    return notify("先选择一集播客");
  }
  if (isPlaying(episode)) {
    state.playRequest++;
    state.playPending = false;
    $("#audio").pause();
    return;
  }
  return playEpisode(episode);
}

function readPlaybackValue(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePlaybackValue(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Playback remains available when the browser cannot persist it.
  }
}

function playbackSnapshot(episode) {
  const podcast = podcastOf(episode);
  return {
    type: "EPISODE",
    eid: episodeIdOf(episode),
    title: titleOf(episode),
    duration: durationOf(episode),
    image: { picUrl: imageOf(episode) },
    media: { source: { url: audioOf(episode) } },
    podcast: { pid: podcastIdOf(podcast), title: titleOf(podcast) }
  };
}

function showPlayerEpisode(episode) {
  state.current = episode;
  if (state.currentTranscriptEpisodeId !== episodeIdOf(episode)) {
    state.currentTranscriptPath = "";
    state.currentTranscriptEpisodeId = "";
    state.currentTranscriptSegments = [];
  }
  state.currentSummaryPath = summaryRecordOf(episode)?.markdown || "";
  setTranscriptionStatus();
  updatePlayerLinkButtons(episode);
  $("#player-title").textContent = titleOf(episode);
  $("#player-subtitle").textContent = episode?.podcast?.title || episode?.podcast?.name || "小宇宙单集";
  const image = imageOf(episode);
  $("#player-cover").innerHTML = image ? `<img src="${esc(image)}" alt="" />` : "<span>◌</span>";
}

function savedPosition(episode) {
  const seconds = Number(readPlaybackValue(POSITION_PREFIX + episodeIdOf(episode), 0));
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

function setPlayerPosition(audio, seconds) {
  if (!audio.src) return;
  state.pendingPosition = Math.max(0, seconds);
  applyPendingPosition(audio);
}

function applyPendingPosition(audio) {
  if (state.pendingPosition === null || audio.readyState < 1 || audio.currentSrc !== audio.src) return;
  const seconds = state.pendingPosition;
  audio.currentTime = Number.isFinite(audio.duration) ? Math.min(seconds, audio.duration) : seconds;
  state.pendingPosition = null;
  savePlayerPosition(audio);
}

function savePlayerPosition(audio, { ended = false } = {}) {
  if (!state.current || !audio.src || audio.currentSrc !== audio.src || state.pendingPosition !== null) return;
  const seconds = ended || audio.ended ? 0 : audio.currentTime;
  if (!Number.isFinite(seconds)) return;
  writePlaybackValue(POSITION_PREFIX + episodeIdOf(state.current), seconds);
  state.lastProgressWrite = Date.now();
}

async function playEpisode(item, { startAt = null, fromQueue = false } = {}) {
  const request = ++state.playRequest;
  state.playPending = true;
  const audio = $("#audio");
  try {
    const alreadyLoaded = audio.src && state.current && episodeIdOf(item) === episodeIdOf(state.current);
    const episode = alreadyLoaded ? state.current : await resolveEpisode(item);
    if (request !== state.playRequest) return;
    const eid = episodeIdOf(episode);
    if (!eid || !audioOf(episode)) return notify("这集暂时没有可播放的音频地址");
    if (!alreadyLoaded || fromQueue) {
      const removed = await updateQueue((queue) => {
        if (request !== state.playRequest) return false;
        return deleteQueuedEpisode(queue, eid);
      });
      if (request !== state.playRequest || (fromQueue && !removed)) return;
    }
    if (!alreadyLoaded) {
      audio.pause();
      savePlayerPosition(audio);
      showPlayerEpisode(episode);
      state.pendingPosition = startAt ?? savedPosition(episode);
      audio.src = audioOf(episode);
      writePlaybackValue(LAST_EPISODE_KEY, playbackSnapshot(episode));
      $("#current-time").textContent = formatTime(state.pendingPosition);
      $("#duration").textContent = formatTime(durationOf(episode));
      $("#progress").value = 0;
      renderPlayerAnchors(episode);
    } else if (startAt !== null || fromQueue || audio.ended) {
      setPlayerPosition(audio, startAt ?? 0);
    }
    renderPlaybackButtons();
    await audio.play();
  } catch (error) {
    if (request === state.playRequest) notify(error.name === "NotAllowedError" ? "请点击底部播放按钮继续" : error.message);
  } finally {
    if (request === state.playRequest) state.playPending = false;
  }
}

function renderQueue() {
  $("#next-episode-button").disabled = state.queue.length === 0 || state.advancingQueue;
  $("#queue-button").textContent = state.queue.length ? `队列 (${state.queue.length})` : "队列";
  const list = $("#queue-list");
  list.innerHTML = state.queue.map((entry, index) => {
    const title = esc(titleOf(entry));
    return `<li class="queue-row" data-queue-eid="${esc(episodeIdOf(entry))}">
      <span title="${title}">${title}</span>
      <button type="button" data-queue-move="-1" aria-label="上移 ${title}" ${index === 0 ? "disabled" : ""}>↑</button>
      <button type="button" data-queue-move="1" aria-label="下移 ${title}" ${index === state.queue.length - 1 ? "disabled" : ""}>↓</button>
      <button type="button" data-queue-remove aria-label="移除 ${title}">删除</button>
    </li>`;
  }).join("");
  $("#queue-empty").hidden = state.queue.length !== 0;
}

function readQueue() {
  const queue = readPlaybackValue(QUEUE_KEY, []);
  return Array.isArray(queue) ? queue.filter((entry) => episodeIdOf(entry)) : [];
}

function updateQueue(update) {
  return navigator.locks.request(QUEUE_KEY, () => {
    const queue = readQueue();
    const changed = update(queue);
    if (changed) writePlaybackValue(QUEUE_KEY, queue);
    state.queue = queue;
    renderQueue();
    return changed;
  });
}

async function addToQueue(episode, playNext = false) {
  const eid = episodeIdOf(episode);
  if (!eid) return;
  const changed = await updateQueue((queue) => {
    const index = queue.findIndex((entry) => episodeIdOf(entry) === eid);
    if (index >= 0 && !playNext) return false;
    const entry = index >= 0 ? queue.splice(index, 1)[0] : playbackSnapshot(episode);
    if (playNext) queue.unshift(entry);
    else queue.push(entry);
    return true;
  });
  if (!changed) return notify("这集已在播放队列");
  notify(playNext ? "已设为下一首" : "已加入播放队列");
}

function deleteQueuedEpisode(queue, eid) {
  const index = queue.findIndex((entry) => episodeIdOf(entry) === eid);
  if (index < 0) return false;
  queue.splice(index, 1);
  return true;
}

async function moveQueueEntry(eid, offset) {
  const moved = await updateQueue((queue) => {
    const index = queue.findIndex((entry) => episodeIdOf(entry) === eid);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= queue.length) return false;
    const [entry] = queue.splice(index, 1);
    queue.splice(target, 0, entry);
    return true;
  });
  if (!moved) return;
  const row = $$("[data-queue-eid]", $("#queue-list")).find((entry) => entry.dataset.queueEid === eid);
  if (!row) return;
  const button = $(`[data-queue-move="${offset}"]`, row);
  (button.disabled ? $("[data-queue-remove]", row) : button).focus();
}

async function playNextInQueue() {
  const entry = readQueue()[0];
  if (!entry || state.advancingQueue) return;
  state.advancingQueue = true;
  renderQueue();
  try {
    await playEpisode(entry, { fromQueue: true });
  } finally {
    state.advancingQueue = false;
    renderQueue();
  }
}

function initQueue() {
  state.queue = readQueue();
  state.autoAdvance = readPlaybackValue(AUTO_ADVANCE_KEY, true) === true;
  $("#queue-autoplay").checked = state.autoAdvance;
  $("#queue-autoplay").addEventListener("change", (event) => {
    state.autoAdvance = event.currentTarget.checked;
    writePlaybackValue(AUTO_ADVANCE_KEY, state.autoAdvance);
  });
  $("#queue-button").addEventListener("click", () => $("#queue-dialog").showModal());
  $("#next-episode-button").addEventListener("click", playNextInQueue);
  $("#queue-list").addEventListener("click", (event) => {
    const row = event.target.closest("[data-queue-eid]");
    if (!row) return;
    const eid = row.dataset.queueEid;
    if (event.target.closest("[data-queue-remove]")) return updateQueue((queue) => deleteQueuedEpisode(queue, eid));
    const move = event.target.closest("[data-queue-move]");
    if (move) return moveQueueEntry(eid, Number(move.dataset.queueMove));
  });
  window.addEventListener("storage", (event) => {
    if (event.key === QUEUE_KEY) {
      state.queue = readQueue();
      renderQueue();
    }
    if (event.key === AUTO_ADVANCE_KEY) {
      state.autoAdvance = readPlaybackValue(AUTO_ADVANCE_KEY, true) === true;
      $("#queue-autoplay").checked = state.autoAdvance;
    }
  });
  renderQueue();
}

async function toggleSubscription(item, button = null) {
  const pid = podcastIdOf(item);
  if (!pid) return notify("无法识别这个节目");
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "订阅中…";
  }
  try {
    await api("/subscription_update", { pid, mode: "ON" });
    state.subscribedPids.add(pid);
    if (button) button.textContent = "已订阅";
    notify("已加入订阅");
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
    notify(error.message);
  }
}

const QR_POLL_MS = 1500;
const QR_WAIT_MS = 180000;
let qrLogin = null;

function stopQrLogin() {
  if (qrLogin?.timer) clearInterval(qrLogin.timer);
  qrLogin = null;
}

function setQrStatus(kind, text) {
  const node = $("#qr-status");
  node.className = kind ? `code-status is-${kind}` : "code-status";
  node.textContent = text;
}

function drawQrCanvas(url) {
  const canvas = $("#qr-canvas");
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4;
  const cell = Math.floor(Math.min(canvas.width, canvas.height) / (count + quiet * 2));
  const size = cell * (count + quiet * 2);
  const ox = Math.floor((canvas.width - size) / 2);
  const oy = Math.floor((canvas.height - size) / 2);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#111827";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) ctx.fillRect(ox + (col + quiet) * cell, oy + (row + quiet) * cell, cell, cell);
    }
  }
}

async function startQrLogin() {
  const button = $("#qr-login-button");
  button.disabled = true;
  button.textContent = "生成中…";
  setQrStatus("pending", "正在生成登录二维码…");
  try {
    const info = await send("qr-create");
    drawQrCanvas(info.url);
    $("#qr-canvas").hidden = false;
    stopQrLogin();
    qrLogin = { id: info.id, deadline: Date.now() + QR_WAIT_MS, timer: setInterval(pollQrLogin, QR_POLL_MS) };
    setQrStatus("", "请用小宇宙 App：发现页 → 点搜索栏 → 扫一扫");
    button.textContent = "刷新二维码";
    button.disabled = false;
    pollQrLogin();
  } catch (error) {
    setQrStatus("error", `二维码生成失败：${error.message}`);
    button.textContent = "生成扫码二维码";
    button.disabled = false;
  }
}

async function pollQrLogin() {
  if (!qrLogin) return;
  if (Date.now() >= qrLogin.deadline) {
    stopQrLogin();
    setQrStatus("error", "二维码已过期，请点击「刷新二维码」");
    return;
  }
  try {
    const result = await send("qr-poll", { payload: { id: qrLogin.id } });
    if (!qrLogin) return;
    if (result.status === "EXPIRED") {
      stopQrLogin();
      setQrStatus("error", "二维码已失效，请点击「刷新二维码」");
    } else if (result.status === "SCANNED") {
      setQrStatus("pending", "已扫码，请在手机上确认登录");
    } else if (result.status === "CONFIRMED" || result.status === "USED") {
      state.auth = result.auth;
      stopQrLogin();
      $("#login-dialog").close();
      markConnection();
      notify("登录成功");
      renderRoute();
    }
  } catch { /* 网络抖动忽略，等待下一轮轮询 */ }
}

function openLogin() {
  $("#login-error").textContent = "";
  $("#qr-canvas").hidden = true;
  startQrLogin();
  $("#login-dialog").showModal();
}

function openLogoutConfirmation() {
  $("#logout-dialog").showModal();
}

async function confirmLogout() {
  const button = $("#logout-confirm");
  button.disabled = true;
  button.textContent = "正在退出…";
  try {
    await send("logout");
    state.auth = null;
    $("#logout-dialog").close();
    markConnection();
    renderRoute();
    notify("已退出登录");
  } catch (error) {
    notify(`退出失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "确认退出登录";
  }
}

async function submitLogin(event) {
  event.preventDefault();
  const errorNode = $("#login-error");
  errorNode.textContent = "";
  const phone = $("#phone-input").value.trim();
  const code = $("#code-input").value.trim();
  if (!phone || !code) return;
  try {
    state.auth = await send("login", { payload: { mobilePhoneNumber: phone, verifyCode: code, areaCode: "+86" } });
    markConnection(); $("#login-dialog").close(); notify("登录成功"); renderRoute();
  } catch (error) { errorNode.textContent = error.message; }
}

async function sendCode() {
  const phone = $("#phone-input").value.trim();
  const errorNode = $("#login-error");
  const statusNode = $("#code-status");
  const button = $("#send-code-button");
  errorNode.textContent = "";
  if (!/^1\d{10}$/.test(phone)) {
    errorNode.textContent = "请输入有效的 11 位中国大陆手机号";
    $("#phone-input").focus();
    return;
  }
  button.disabled = true;
  button.textContent = "发送中…";
  statusNode.className = "code-status is-pending";
  statusNode.textContent = "正在向小宇宙认证服务请求验证码…";
  try {
    await send("send-code", {
      payload: { mobilePhoneNumber: phone, areaCode: "+86" }
    });
    const maskedPhone = `${phone.slice(0, 3)}****${phone.slice(-4)}`;
    let remaining = 60;
    statusNode.className = "code-status is-success";
    statusNode.textContent = `验证码已发送至 ${maskedPhone}，请查收短信。`;
    button.textContent = `${remaining} 秒后重发`;
    notify("验证码已发送，请查看短信");
    clearInterval(sendCode.timer);
    sendCode.timer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        button.textContent = `${remaining} 秒后重发`;
        return;
      }
      clearInterval(sendCode.timer);
      sendCode.timer = null;
      button.disabled = false;
      button.textContent = "重新发送";
      statusNode.className = "code-status";
      statusNode.textContent = "未收到短信？请检查手机号或重新发送验证码。";
    }, 1000);
  } catch (error) {
    button.disabled = false;
    button.textContent = "重新发送";
    statusNode.className = "code-status is-error";
    statusNode.textContent = "验证码发送失败，请检查网络后重试。";
    errorNode.textContent = error.message;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    syncSummaryPromptEditor();
    if (state.summaryPromptDrafts.some((prompt) => !String(prompt.content || "").trim())) {
      throw new Error("AI 总结 Prompt 内容不能为空");
    }
    const asrCredentialStatus = await send("save-asr-credentials", {
      credentials: {
        qwenApiKey: $("#qwen-api-key").value.trim(),
        doubaoApiKey: $("#doubao-api-key").value.trim()
      }
    });
    const summaryCredentials = Object.fromEntries(SUMMARY_PROVIDERS.map((provider) => [
      provider.keyField,
      $(`#summary-${provider.id}-api-key`).value.trim()
    ]));
    const summaryCredentialStatus = await send("save-summary-credentials", {
      credentials: summaryCredentials
    });
    const summaryProviders = Object.fromEntries(SUMMARY_PROVIDERS.map((provider) => [
      provider.id,
      {
        endpoint: $(`#summary-${provider.id}-endpoint`).value.trim(),
        model: $(`#summary-${provider.id}-model`).value.trim()
      }
    ]));
    const includeComments = $("#summary-include-comments").checked;
    const keepConsent = Boolean(
      state.settings.summaryConsentAccepted
      && (!includeComments || state.settings.summaryIncludeComments)
    );
    state.settings = await send("update-settings", {
      settings: {
        apiMode: $("#api-mode").value,
        proxyBaseUrl: $("#proxy-url").value.trim(),
        downloadFolder: "小宇宙音频",
        transcriptFolder: "小宇宙转写稿",
        audioDownloadPath: $("#audio-download-path").value.trim(),
        transcriptDownloadPath: $("#transcript-download-path").value.trim(),
        summaryDownloadPath: $("#summary-download-path").value.trim(),
        downloadSaveAs: $("#download-save-as").checked,
        transcriptSource: $("#transcript-source").value,
        asrProvider: $("#asr-provider").value,
        localQwenModel: $("#local-qwen-model").value,
        qwenAsrEndpoint: $("#qwen-asr-endpoint").value.trim(),
        qwenAsrModel: $("#qwen-asr-model").value.trim(),
        doubaoAsrEndpoint: $("#doubao-asr-endpoint").value.trim(),
        doubaoAsrResourceId: $("#doubao-asr-resource-id").value.trim(),
        summaryProvider: $("#summary-provider").value,
        summaryProviders,
        summaryPromptVersions: state.summaryPromptDrafts.map((prompt) => ({ ...prompt })),
        activeSummaryPromptId: state.settings.activeSummaryPromptId,
        summaryConsentAccepted: keepConsent,
        summaryIncludeComments: includeComments
      }
    });
    $("#qwen-api-key").value = "";
    $("#doubao-api-key").value = "";
    SUMMARY_PROVIDERS.forEach((provider) => {
      $(`#summary-${provider.id}-api-key`).value = "";
    });
    const providerNode = $("#asr-provider-status");
    if (providerNode) {
      providerNode.classList.toggle("is-ready", asrCredentialStatus.qwenConfigured || asrCredentialStatus.doubaoConfigured || asrCredentialStatus.localQwen?.available);
      providerNode.textContent = `本地 Qwen：${asrCredentialStatus.localQwen?.available ? "已安装" : "未安装"} · Qwen API：${asrCredentialStatus.qwenConfigured ? "已配置" : "未配置"} · 豆包 API：${asrCredentialStatus.doubaoConfigured ? "已配置" : "未配置"}`;
    }
    renderSummaryProviderStatus(summaryCredentialStatus.summaryConfigured || {});
    $("#audio-download-path").value = state.settings.audioDownloadPath;
    $("#transcript-download-path").value = state.settings.transcriptDownloadPath;
    $("#summary-download-path").value = state.settings.summaryDownloadPath;
    $("#audio-path-preview").textContent = state.settings.audioDownloadPath || "浏览器默认下载目录/小宇宙音频";
    $("#transcript-path-preview").textContent = state.settings.transcriptDownloadPath || "浏览器默认下载目录/小宇宙转写稿";
    $("#summary-path-preview").textContent = state.settings.summaryDownloadPath
      || state.settings.transcriptDownloadPath
      || "浏览器默认下载目录/小宇宙转写稿";
    updatePlayerLinkButtons(state.current);
    notify("设置已保存");
  } catch (error) {
    notify(error.message);
  }
}

function initPlayer() {
  const audio = $("#audio");
  const closePlayerMenu = () => $("#player-more-menu").removeAttribute("open");
  $("#play-button").addEventListener("click", () => togglePlayback(state.current));
  $("#skip-back").addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  $("#skip-forward").addEventListener("click", () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 30); });
  $("#speed-button").addEventListener("click", (event) => {
    const next = audio.playbackRate >= 2 ? 1 : audio.playbackRate + .5;
    audio.playbackRate = next;
    event.currentTarget.textContent = `播放速度 · ${next}×`;
    closePlayerMenu();
  });
  $("#view-podcast-button").addEventListener("click", () => state.current ? openPodcast(state.current) : notify("当前没有正在播放的节目"));
  $("#download-audio-button").addEventListener("click", () => {
    closePlayerMenu();
    return state.current ? downloadEpisodeAudio(state.current) : notify("当前没有正在播放的单集");
  });
  $("#transcribe-audio-button").addEventListener("click", (event) => {
    closePlayerMenu();
    return state.current ? exportEpisodeTranscript(state.current, event.currentTarget) : notify("当前没有正在播放的单集");
  });
  $("#summarize-button").addEventListener("click", (event) => {
    if (!state.current) return notify("当前没有正在播放的单集");
    summarizeEpisode(state.current, event.currentTarget).catch((error) => notify(error.message));
  });
  $("#copy-episode-link-button").addEventListener("click", () => {
    closePlayerMenu();
    return state.current ? copyEpisodeLink(state.current) : notify("当前没有正在播放的单集");
  });
  $("#copy-podcast-link-button").addEventListener("click", () => {
    closePlayerMenu();
    return state.current ? copyPodcastLink(state.current) : notify("当前没有正在播放的节目");
  });
  audio.addEventListener("play", renderPlaybackButtons);
  audio.addEventListener("pause", () => {
    renderPlaybackButtons();
    savePlayerPosition(audio);
  });
  audio.addEventListener("loadedmetadata", () => {
    applyPendingPosition(audio);
    $("#duration").textContent = formatTime(audio.duration);
    renderPlayerAnchors(state.current);
  });
  audio.addEventListener("timeupdate", () => {
    if (state.pendingPosition !== null || audio.currentSrc !== audio.src) return;
    $("#current-time").textContent = formatTime(audio.currentTime);
    $("#progress").value = audio.duration
      ? (audio.currentTime / audio.duration) * 100
      : 0;
    updateActiveProgressAnchor(audio.currentTime);
    if (Date.now() - state.lastProgressWrite >= 5000) savePlayerPosition(audio);
  });
  audio.addEventListener("ended", () => {
    renderPlaybackButtons();
    savePlayerPosition(audio, { ended: true });
    if (state.autoAdvance && !state.playPending) playNextInQueue();
  });
  window.addEventListener("pagehide", () => savePlayerPosition(audio));
  $("#progress").addEventListener("input", (event) => {
    if (Number.isFinite(audio.duration)) setPlayerPosition(audio, (event.target.value / 100) * audio.duration);
  });

  const volumeSlider = $("#volume");
  const volumeButton = $("#volume-button");
  const volumePopover = $("#volume-popover");
  const volumeIcons = {
    high: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>',
    low: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>',
    mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>'
  };
  const savedVolume = Number(state.settings?.volume);
  if (Number.isFinite(savedVolume)) audio.volume = Math.min(1, Math.max(0, savedVolume));
  const renderVolume = () => {
    const effective = audio.muted ? 0 : audio.volume;
    volumeButton.innerHTML = volumeIcons[effective === 0 ? "mute" : effective <= .5 ? "low" : "high"];
    volumeSlider.value = Math.round(effective * 100);
  };
  const persistVolume = () => {
    const next = audio.muted ? 0 : audio.volume;
    state.settings = { ...state.settings, volume: next };
    send("set-audio-volume", { volume: next }).catch(() => {});
  };
  volumeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = volumePopover.hidden;
    volumePopover.hidden = !willOpen;
    volumeButton.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) renderVolume();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".volume-wrap")) {
      volumePopover.hidden = true;
      volumeButton.setAttribute("aria-expanded", "false");
    }
  });
  volumeSlider.addEventListener("input", (event) => {
    const value = Number(event.target.value) / 100;
    audio.volume = value;
    if (value > 0) audio.muted = false;
    renderVolume();
  });
  volumeSlider.addEventListener("change", persistVolume);
  renderVolume();

  const lastEpisode = readPlaybackValue(LAST_EPISODE_KEY, null);
  if (episodeIdOf(lastEpisode)) {
    showPlayerEpisode(lastEpisode);
    $("#current-time").textContent = formatTime(savedPosition(lastEpisode));
    $("#duration").textContent = formatTime(durationOf(lastEpisode));
  }
}

async function init() {
  const [auth, settings, history] = await Promise.all([
    send("get-auth"),
    send("get-settings"),
    send("get-summary-history")
  ]);
  state.auth = auth;
  state.settings = settings;
  state.summaryHistory = new Map(Object.entries(history || {}));
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  $("#back-button").hidden = true;
  markConnection(); initPlayer(); initQueue(); renderRoute();
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => setRoute(item.dataset.route)));
  $("#back-button").addEventListener("click", () => {
    if (state.episodeView) closeEpisode();
    else closePodcast();
  });
  $("#sidebar-toggle").addEventListener("click", () => setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed")));
  $("#account-button").addEventListener("click", () => {
    if (state.auth) openLogoutConfirmation();
    else openLogin();
  });
  $("#logout-confirm").addEventListener("click", confirmLogout);
  $("#login-form").addEventListener("submit", submitLogin);
  $("#qr-login-button").addEventListener("click", startQrLogin);
  $("#login-dialog").addEventListener("close", stopQrLogin);
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  document.addEventListener("click", (event) => {
    const activeMenu = event.target.closest(".action-menu");
    $$(".action-menu[open]").forEach((menu) => {
      if (menu !== activeMenu) menu.removeAttribute("open");
    });
  });
}

init().catch((error) => notify(error.message));

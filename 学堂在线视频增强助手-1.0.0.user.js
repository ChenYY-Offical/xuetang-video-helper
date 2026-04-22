// ==UserScript==
// @name         学堂在线视频增强助手
// @namespace    https://tampermonkey.net/
// @version      1.0.0
// @description  静音、倍速、续播、复制全部题目，并自动拼接逐题解析提示词（这部分没用）。
// @author       ChenYY-Official
// @match        https://www.xuetangx.com/*
// @grant        GM_setClipboard
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const GLOBAL_KEY = '__XTX_VIDEO_HELPER_PRO__';
  const MEDIA_PATCH_KEY = '__xtx_media_patch_v3__';

  if (window[GLOBAL_KEY] && window[GLOBAL_KEY].destroy) {
    try { window[GLOBAL_KEY].destroy(); } catch (e) {}
  }


  if (!window[MEDIA_PATCH_KEY]) {
    window[MEDIA_PATCH_KEY] = true;
    window.__xtxForceMuteGlobal__ = true;

    const rawPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      try {
        if (window.__xtxForceMuteGlobal__) {
          this.defaultMuted = true;
          this.muted = true;
          this.volume = 0;
        }
      } catch (e) {}
      return rawPlay.apply(this, args);
    };

    const volumeDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
    const mutedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');

    if (volumeDesc && volumeDesc.configurable) {
      Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
        get() {
          return volumeDesc.get.call(this);
        },
        set(v) {
          if (window.__xtxForceMuteGlobal__) {
            return volumeDesc.set.call(this, 0);
          }
          return volumeDesc.set.call(this, v);
        },
        configurable: true
      });
    }

    if (mutedDesc && mutedDesc.configurable) {
      Object.defineProperty(HTMLMediaElement.prototype, 'muted', {
        get() {
          return mutedDesc.get.call(this);
        },
        set(v) {
          if (window.__xtxForceMuteGlobal__) {
            return mutedDesc.set.call(this, true);
          }
          return mutedDesc.set.call(this, v);
        },
        configurable: true
      });
    }
  }

  const app = {
    panel: null,
    styleEl: null,
    observer: null,
    currentVideo: null,
    videoBindMark: new WeakSet(),
    keepAliveTimer: null,
    routeTimer: null,
    lastUrl: location.href,
    wakeLock: null,
    destroyed: false
  };

  window[GLOBAL_KEY] = app;

  const STORAGE_KEY = 'xtx_video_helper_pro_config_v33';
  const defaultConfig = {
    rate: 2.0,
    volume: 0,
    muted: true,
    autoMute: true,
    autoPlay: true,
    autoResume: true,
    autoHandleDialogs: true,
    keepAwake: false,
    seekStep: 10,
    panelPos: {
      right: 18,
      bottom: 18
    }
  };

  let config = loadConfig();
  syncGlobalMuteFlag();

  function loadConfig() {
    try {
      return { ...defaultConfig, ...(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}) };
    } catch (e) {
      return { ...defaultConfig };
    }
  }

  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  function syncGlobalMuteFlag() {
    window.__xtxForceMuteGlobal__ = !!config.autoMute;
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0';
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function debounce(fn, delay = 250) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function findBestVideo() {
    const videos = qsa('video').filter(isVisible);
    if (!videos.length) return null;

    let best = null;
    let maxArea = -1;
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > maxArea) {
        maxArea = area;
        best = v;
      }
    }
    return best;
  }

  function safePlay(video) {
    if (!video) return;
    video.play().catch(() => {
      tryClickPlay();
    });
  }

  function tryClickPlay() {
    const selectors = [
      '.vjs-big-play-button',
      '.vjs-play-control',
      '.prism-play-btn',
      '.xt_video_bit_play_btn',
      '.xt_video_player_big_play_layer .xt_video_bit_play_btn',
      'button[aria-label*="播放"]',
      'button[title*="播放"]',
      '.play-btn',
      '.playButton'
    ];

    for (const sel of selectors) {
      for (const el of qsa(sel)) {
        if (!isVisible(el)) continue;
        el.click();
        return true;
      }
    }

    const candidates = qsa('button, span, div');
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const txt = textOf(el);
      if (/^(播放|开始|继续播放|继续学习|重播)$/.test(txt)) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function tryClickNext() {
    const candidates = qsa('button, a, li, div, span');
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const txt = textOf(el);
      if (/下一节|下一讲|下一个|继续学习|继续/.test(txt)) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function tryHandleDialogs() {
    if (!config.autoHandleDialogs) return false;

    const texts = ['继续学习', '继续播放', '我知道了', '知道了', '确定', '继续', '关闭'];
    const nodes = qsa('button, .ant-btn, span, div');

    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const txt = textOf(el);
      if (texts.includes(txt)) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function forceMute(video) {
    if (!video || !config.autoMute) return;

    try { video.defaultMuted = true; } catch (e) {}
    try { if (!video.muted) video.muted = true; } catch (e) {}
    try { if (video.volume !== 0) video.volume = 0; } catch (e) {}

    config.muted = true;
    config.volume = 0;
  }

  function applyVideoPrefs(video) {
    if (!video) return;

    try { video.playbackRate = config.rate; } catch (e) {}

    if (config.autoMute) {
      forceMute(video);
    } else {
      try { video.muted = !!config.muted; } catch (e) {}
      try { video.volume = clamp(config.volume, 0, 1); } catch (e) {}
    }
  }

  function setVideoRate(rate) {
    const video = app.currentVideo || findBestVideo();
    config.rate = clamp(Math.round(rate * 10) / 10, 0.5, 4);
    saveConfig();
    if (video) {
      try { video.playbackRate = config.rate; } catch (e) {}
    }
    updatePanel();
  }

  function stepRate(delta) {
    const now = app.currentVideo?.playbackRate || config.rate || 1;
    setVideoRate(now + delta);
  }

  function seek(delta) {
    const video = app.currentVideo || findBestVideo();
    if (!video) return;
    try {
      video.currentTime = clamp(video.currentTime + delta, 0, isFinite(video.duration) ? video.duration : Infinity);
    } catch (e) {}
  }

  function togglePlay() {
    const video = app.currentVideo || findBestVideo();
    if (!video) return;
    if (video.paused) safePlay(video);
    else video.pause();
  }

  function toggleMute(force) {
    const video = app.currentVideo || findBestVideo();
    const nextMuted = typeof force === 'boolean' ? force : !config.autoMute;

    if (nextMuted) {
      config.autoMute = true;
      config.muted = true;
      config.volume = 0;
      saveConfig();
      syncGlobalMuteFlag();
      if (video) forceMute(video);
    } else {
      config.autoMute = false;
      config.muted = false;
      config.volume = Math.max(config.volume || 0.5, 0.5);
      saveConfig();
      syncGlobalMuteFlag();

      if (video) {
        try { video.muted = false; } catch (e) {}
        try { video.volume = clamp(config.volume, 0, 1); } catch (e) {}
      }
    }

    updatePanel();
  }

  function bindVideo(video) {
    if (!video) return;
    app.currentVideo = video;

    try { video.defaultMuted = true; } catch (e) {}
    applyVideoPrefs(video);

    if (config.autoPlay && video.paused) {
      safePlay(video);
    }

    if (app.videoBindMark.has(video)) {
      updatePanel();
      return;
    }

    app.videoBindMark.add(video);

    video.addEventListener('loadedmetadata', () => {
      if (app.destroyed) return;
      applyVideoPrefs(video);
      if (config.autoMute) {
        setTimeout(() => forceMute(video), 0);
        setTimeout(() => forceMute(video), 80);
        setTimeout(() => forceMute(video), 250);
      }
      updatePanel();
    });

    video.addEventListener('canplay', () => {
      if (app.destroyed) return;
      applyVideoPrefs(video);
      if (config.autoPlay && video.paused) safePlay(video);
      if (config.autoMute) {
        setTimeout(() => forceMute(video), 0);
        setTimeout(() => forceMute(video), 100);
        setTimeout(() => forceMute(video), 300);
      }
      updatePanel();
    });

    video.addEventListener('play', () => {
      if (app.destroyed) return;
      applyVideoPrefs(video);
      if (config.autoMute) {
        setTimeout(() => forceMute(video), 0);
        setTimeout(() => forceMute(video), 120);
        setTimeout(() => forceMute(video), 500);
      }
      updatePanel();
    });

    video.addEventListener('ratechange', () => {
      if (app.destroyed) return;
      if (video === app.currentVideo) {
        config.rate = video.playbackRate;
        saveConfig();
        updatePanel();
      }
    });

    video.addEventListener('volumechange', () => {
      if (app.destroyed) return;
      if (video !== app.currentVideo) return;

      if (config.autoMute) {
        setTimeout(() => {
          if (app.destroyed) return;
          if (video === app.currentVideo) {
            forceMute(video);
            updatePanel();
          }
        }, 0);
        return;
      }

      config.volume = video.volume;
      config.muted = video.muted;
      saveConfig();
      updatePanel();
    });

    video.addEventListener('pause', () => {
      if (app.destroyed) return;
      if (!config.autoResume) return;
      if (video !== app.currentVideo) return;
      if (video.ended) return;

      setTimeout(() => {
        if (app.destroyed) return;
        if (video === app.currentVideo && video.paused && !video.ended) {
          safePlay(video);
        }
      }, 1000);
    });

    video.addEventListener('ended', () => {
      if (app.destroyed) return;
      if (video !== app.currentVideo) return;
      setTimeout(() => {
        if (app.destroyed) return;
        tryClickNext();
      }, 1200);
    });

    updatePanel();
  }

  function removePanel() {
    if (app.panel) {
      try { app.panel.remove(); } catch (e) {}
      app.panel = null;
    }
    if (app.styleEl) {
      try { app.styleEl.remove(); } catch (e) {}
      app.styleEl = null;
    }
  }

  function applyPanelPosition() {
    if (!app.panel) return;
    app.panel.style.right = `${config.panelPos.right}px`;
    app.panel.style.bottom = `${config.panelPos.bottom}px`;
    app.panel.style.left = 'auto';
    app.panel.style.top = 'auto';
  }

  function makePanelDraggable(panel, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startRight = 0;
    let startBottom = 0;

    function onMouseDown(e) {
      if (e.target.closest('button') || e.target.closest('input')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startRight = parseFloat(panel.style.right) || 18;
      startBottom = parseFloat(panel.style.bottom) || 18;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    }

    function onMouseMove(e) {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const nextRight = clamp(startRight - dx, 0, window.innerWidth - 80);
      const nextBottom = clamp(startBottom - dy, 0, window.innerHeight - 40);

      panel.style.right = `${nextRight}px`;
      panel.style.bottom = `${nextBottom}px`;
      panel.style.left = 'auto';
      panel.style.top = 'auto';
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      config.panelPos = {
        right: parseFloat(panel.style.right) || 18,
        bottom: parseFloat(panel.style.bottom) || 18
      };
      saveConfig();
    }

    handle.addEventListener('mousedown', onMouseDown);
  }

  function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text);
        return true;
      }
    } catch (e) {}

    try {
      navigator.clipboard.writeText(text);
      return true;
    } catch (e) {}

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e) {}

    return false;
  }


  function normalizeText(s) {
    return (s || '').replace(/\n+/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function getQuestionTypeFromBlock(block) {
    const titleEl = qs('.title', block);
    const t = textOf(titleEl) || '';
    return t || '未知题型';
  }

  function collectOptionsFromBlock(block) {
    const rows = qsa('.leftradio.showUntil, .leftradio', block).filter(isVisible);
    return rows.map((row, idx) => {
      const label = textOf(qs('.radio_xtb', row)) || String.fromCharCode(65 + idx);
      let content = textOf(row).trim();
      if (content.startsWith(label)) {
        content = content.slice(label.length).trim();
      }
      return { label, content };
    });
  }

  function collectQuestionTextFromBlock(block, index) {
    const type = getQuestionTypeFromBlock(block);
    const questionText =
      textOf(qs('.leftQuestion .fuwenben', block)) ||
      textOf(qs('.fuwenben', block)) ||
      '未识别到题干';

    const options = collectOptionsFromBlock(block);

    let out = `【第${index}题】\n`;
    out += `题型：${type}\n`;
    out += `题目：${questionText}\n`;

    if (options.length) {
      out += `选项：\n`;
      for (const opt of options) {
        out += `${opt.label}. ${opt.content}\n`;
      }
    }

    return normalizeText(out);
  }

  function collectAllQuestionsText() {
    const paperTitle =
      textOf(qs('.unit-title')) ||
      textOf(qs('.control-left .unit-title')) ||
      textOf(qs('.classNameTitle')) ||
      '未命名测试';

    const blocks = qsa('.question').filter(isVisible);

    let parts = [];
    if (blocks.length > 0) {
      parts = blocks.map((block, idx) => collectQuestionTextFromBlock(block, idx + 1));
    } else {
      // 当前页面只有一题的兜底
      const questionRoot = qs('.question');
      if (questionRoot) {
        parts.push(collectQuestionTextFromBlock(questionRoot, 1));
      }
    }

    const questionsText = parts.join('\n\n').trim();
    return {
      paperTitle,
      questionsText
    };
  }

  // ===== 改提示词，就改这个函数（目前很多题目没法使用，由于大部分题干是gif，png得图片形式，所以暂时不可用，敬请大神优化 =====
  function buildAnalysisPrompt(questionsText, paperTitle) {
    const prompt = `
请按题目顺序逐题给出下面这份测试题得答案，不要跳题。

要求：
1，按题目顺序逐题作答，绝不跳题
2，完全套用你给的模板格式
3，只给答案、不加解析、不加废话

测试名称：${paperTitle}

题目如下：
${questionsText}
`;
    return normalizeText(prompt);
  }

  function copyAllQuestionsWithAnalysisPrompt() {
    const { paperTitle, questionsText } = collectAllQuestionsText();

    if (!questionsText) {
      alert('当前没有识别到可复制的题目内容。');
      return;
    }

    const finalText = buildAnalysisPrompt(questionsText, paperTitle);
    const ok = copyText(finalText);

    if (ok) {
      alert('已复制全部题目和解析提示词。');
    } else {
      alert('复制失败，请检查浏览器剪贴板权限。');
    }
  }

  function isExercisePage() {
    return !!qs('.courseActionExamineLearnSpace') || !!qs('.question') || !!qs('.answerCon');
  }

function ensureExerciseCopyButton() {
  ensureExerciseButtonStyle();

  if (qs('#xtx-copy-all-questions-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'xtx-copy-all-questions-btn';
  btn.textContent = '复制题目无法正常使用，不要点击';
  btn.addEventListener('click', copyAllQuestionsWithAnalysisPrompt);
  document.body.appendChild(btn);
}

  function removeExerciseCopyButton() {
    const btn = qs('#xtx-copy-all-questions-btn');
    if (btn) btn.remove();
  }

    function ensureExerciseButtonStyle() {
  if (document.getElementById('xtx-copy-all-questions-style')) return;

  const style = document.createElement('style');
  style.id = 'xtx-copy-all-questions-style';
  style.textContent = `
    #xtx-copy-all-questions-btn{
      position: fixed;
      right: 18px;
      top: 120px;
      z-index: 999999;
      border: none;
      border-radius: 12px;
      padding: 10px 14px;
      background: rgba(28,28,28,.92);
      color: #fff;
      box-shadow: 0 10px 26px rgba(0,0,0,.24);
      cursor: pointer;
    }
    #xtx-copy-all-questions-btn:hover{
      opacity: .95;
    }
  `;
  document.documentElement.appendChild(style);
}
  function createPanel() {
    removePanel();

    const style = document.createElement('style');
    style.textContent = `
      #xtx-helper-panel-pro{
        position: fixed;
        z-index: 999999;
        width: 280px;
        padding: 14px;
        border-radius: 18px;
        background: rgba(18,18,18,.92);
        color: #fff;
        box-shadow: 0 12px 32px rgba(0,0,0,.35);
        backdrop-filter: blur(12px);
        font-size: 13px;
        user-select: none;
      }
      #xtx-helper-panel-pro *{ box-sizing: border-box; }
      #xtx-helper-panel-pro .xtx-head{
        display:flex; align-items:center; justify-content:space-between;
        margin-bottom:10px; cursor:move;
      }
      #xtx-helper-panel-pro .xtx-title{ font-size:14px; font-weight:700; }
      #xtx-helper-panel-pro .xtx-mini-btn{
        border:none; background:rgba(255,255,255,.12); color:#fff;
        border-radius:8px; padding:4px 8px; cursor:pointer;
      }
      #xtx-helper-panel-pro .xtx-row{
        display:flex; gap:8px; flex-wrap:wrap; margin:8px 0; align-items:center; justify-content:center;
      }
      #xtx-helper-panel-pro .xtx-btn{
        border:none; background:#3478f6; color:#fff;
        border-radius:10px; padding:8px 12px; cursor:pointer; min-width:58px;
      }
      #xtx-helper-panel-pro .xtx-rate{
        min-width:50px; text-align:center; font-weight:700; font-size:15px;
      }
      #xtx-helper-panel-pro .xtx-check{
        display:flex; align-items:center; margin:7px 0; font-size:13px;
      }
      #xtx-helper-panel-pro .xtx-check input{ margin-right:8px; }
      #xtx-helper-panel-pro .xtx-foot{
        margin-top:10px; opacity:.82; line-height:1.45;
      }
      #xtx-helper-panel-pro.xtx-collapsed .xtx-body{ display:none; }


    `;
    document.documentElement.appendChild(style);
    app.styleEl = style;

    const panel = document.createElement('div');
    panel.id = 'xtx-helper-panel-pro';
    panel.innerHTML = `
      <div class="xtx-head">
        <div class="xtx-title">视频增强</div>
        <button class="xtx-mini-btn" id="xtx-collapse-btn">收起</button>
      </div>
      <div class="xtx-body">
        <div class="xtx-row">
          <button class="xtx-btn" data-act="slower">-0.1</button>
          <div class="xtx-rate" id="xtx-rate-label">1x</div>
          <button class="xtx-btn" data-act="faster">+0.1</button>
        </div>

        <div class="xtx-row">
          <button class="xtx-btn" data-rate="1.25">1.25x</button>
          <button class="xtx-btn" data-rate="1.5">1.5x</button>
          <button class="xtx-btn" data-rate="2">2x</button>
          <button class="xtx-btn" data-rate="2.5">2.5x</button>
        </div>

        <div class="xtx-row">
          <button class="xtx-btn" data-act="back">-10s</button>
          <button class="xtx-btn" data-act="toggle">播放/暂停</button>
          <button class="xtx-btn" data-act="forward">+10s</button>
        </div>

        <div class="xtx-row">
          <button class="xtx-btn" data-act="mute" id="xtx-mute-btn">静音</button>
        </div>

        <label class="xtx-check"><input id="xtx-autoMute" type="checkbox">超强自动静音</label>
        <label class="xtx-check"><input id="xtx-autoPlay" type="checkbox">自动播放</label>
        <label class="xtx-check"><input id="xtx-autoResume" type="checkbox">自动续播</label>
        <label class="xtx-check"><input id="xtx-autoDialogs" type="checkbox">自动处理常见提示</label>
        <label class="xtx-check"><input id="xtx-keepAwake" type="checkbox">防休眠</label>

        <div class="xtx-foot">Z/X 调速，←/→ 快退快进，空格 播放/暂停，M 静音</div>
      </div>
    `;
    document.body.appendChild(panel);
    app.panel = panel;

    applyPanelPosition();

    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;

      if (btn.id === 'xtx-collapse-btn') {
        panel.classList.toggle('xtx-collapsed');
        btn.textContent = panel.classList.contains('xtx-collapsed') ? '展开' : '收起';
        return;
      }

      const rate = btn.dataset.rate;
      const act = btn.dataset.act;

      if (rate) {
        setVideoRate(Number(rate));
        return;
      }

      if (act === 'slower') stepRate(-0.1);
      if (act === 'faster') stepRate(0.1);
      if (act === 'back') seek(-config.seekStep);
      if (act === 'forward') seek(config.seekStep);
      if (act === 'toggle') togglePlay();
      if (act === 'mute') toggleMute();
    });

    qs('#xtx-autoMute', panel).checked = config.autoMute;
    qs('#xtx-autoPlay', panel).checked = config.autoPlay;
    qs('#xtx-autoResume', panel).checked = config.autoResume;
    qs('#xtx-autoDialogs', panel).checked = config.autoHandleDialogs;
    qs('#xtx-keepAwake', panel).checked = config.keepAwake;

    qs('#xtx-autoMute', panel).addEventListener('change', e => {
      config.autoMute = e.target.checked;
      if (config.autoMute) {
        config.muted = true;
        config.volume = 0;
      }
      saveConfig();
      syncGlobalMuteFlag();
      if (config.autoMute && app.currentVideo) forceMute(app.currentVideo);
      updatePanel();
    });

    qs('#xtx-autoPlay', panel).addEventListener('change', e => {
      config.autoPlay = e.target.checked;
      saveConfig();
    });

    qs('#xtx-autoResume', panel).addEventListener('change', e => {
      config.autoResume = e.target.checked;
      saveConfig();
    });

    qs('#xtx-autoDialogs', panel).addEventListener('change', e => {
      config.autoHandleDialogs = e.target.checked;
      saveConfig();
    });

    qs('#xtx-keepAwake', panel).addEventListener('change', async e => {
      config.keepAwake = e.target.checked;
      saveConfig();
      if (config.keepAwake) await requestWakeLock();
      else if (app.wakeLock) {
        try { await app.wakeLock.release(); } catch (err) {}
        app.wakeLock = null;
      }
    });

    makePanelDraggable(panel, qs('.xtx-head', panel));
    updatePanel();
  }

  function updatePanel() {
    if (app.panel) {
      const rateLabel = qs('#xtx-rate-label', app.panel);
      const muteBtn = qs('#xtx-mute-btn', app.panel);
      const r = app.currentVideo?.playbackRate || config.rate || 1;
      if (rateLabel) rateLabel.textContent = `${Number(r).toFixed(2).replace(/\.00$/, '').replace(/0$/, '')}x`;
      if (muteBtn) muteBtn.textContent = config.autoMute ? '已锁静音' : '开启静音';
    }

    if (isExercisePage()) ensureExerciseCopyButton();
    else removeExerciseCopyButton();
  }

  async function requestWakeLock() {
    if (!config.keepAwake) return;
    try {
      if ('wakeLock' in navigator && !app.wakeLock) {
        app.wakeLock = await navigator.wakeLock.request('screen');
        app.wakeLock.addEventListener('release', () => {
          app.wakeLock = null;
        });
      }
    } catch (e) {}
  }

function scan() {
  if (app.destroyed) return;

  tryHandleDialogs();
  updatePanel();

  // 先处理测试页按钮，不能被“没有视频”提前截断
  if (isExercisePage()) {
    ensureExerciseCopyButton();
  } else {
    removeExerciseCopyButton();
  }

  const video = findBestVideo();

  // 没有视频时，不再直接中断整个页面增强逻辑
  if (!video) {
    removePanel();
    app.currentVideo = null;
    return;
  }

  if (!app.panel) createPanel();

  if (video !== app.currentVideo) {
    bindVideo(video);
  } else {
    applyVideoPrefs(video);
    updatePanel();
  }
}

  function setupObserver() {
    if (app.observer) {
      try { app.observer.disconnect(); } catch (e) {}
    }

    app.observer = new MutationObserver(() => {
      scheduleScan();
    });

    app.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function setupRouteHooks() {
    const rawPushState = history.pushState;
    const rawReplaceState = history.replaceState;

    function routeChanged() {
      if (app.destroyed) return;
      if (location.href === app.lastUrl) return;
      app.lastUrl = location.href;
      clearTimeout(app.routeTimer);
      app.routeTimer = setTimeout(() => scan(), 250);
    }

    history.pushState = function (...args) {
      const ret = rawPushState.apply(this, args);
      routeChanged();
      return ret;
    };

    history.replaceState = function (...args) {
      const ret = rawReplaceState.apply(this, args);
      routeChanged();
      return ret;
    };

    window.addEventListener('popstate', routeChanged, { passive: true });
    window.addEventListener('hashchange', routeChanged, { passive: true });
  }

  function startKeepAlive() {
    if (app.keepAliveTimer) clearInterval(app.keepAliveTimer);

    app.keepAliveTimer = setInterval(() => {
      if (app.destroyed) return;

      updatePanel();
      tryHandleDialogs();

      const video = findBestVideo();
      if (!video) {
        removePanel();
        app.currentVideo = null;
        return;
      }

      if (!app.panel) createPanel();

      if (video !== app.currentVideo) {
        bindVideo(video);
        return;
      }

      applyVideoPrefs(video);
      if (config.autoMute) forceMute(video);
      updatePanel();
    }, 200);
  }

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (app.destroyed) return;

      const ae = document.activeElement;
      const tag = (ae?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || ae?.isContentEditable) return;

      if (e.code === 'Space') {
        if (findBestVideo()) {
          e.preventDefault();
          togglePlay();
        }
      } else if (e.key === 'ArrowLeft') {
        if (findBestVideo()) {
          e.preventDefault();
          seek(-config.seekStep);
        }
      } else if (e.key === 'ArrowRight') {
        if (findBestVideo()) {
          e.preventDefault();
          seek(config.seekStep);
        }
      } else if (e.key.toLowerCase() === 'z') {
        if (findBestVideo()) {
          e.preventDefault();
          stepRate(-0.1);
        }
      } else if (e.key.toLowerCase() === 'x') {
        if (findBestVideo()) {
          e.preventDefault();
          stepRate(0.1);
        }
      } else if (e.key.toLowerCase() === 'm') {
        if (findBestVideo()) {
          e.preventDefault();
          toggleMute();
        }
      }
    }, true);
  }

  app.destroy = function destroy() {
    app.destroyed = true;

    try { if (app.observer) app.observer.disconnect(); } catch (e) {}
    removePanel();
    removeExerciseCopyButton();
    clearInterval(app.keepAliveTimer);
    clearTimeout(app.routeTimer);

    if (window[GLOBAL_KEY] === app) {
      delete window[GLOBAL_KEY];
    }
  };

  function init() {
    bindKeys();
    setupObserver();
    setupRouteHooks();
    scan();
    startKeepAlive();

    window.addEventListener('focus', () => {
      scan();
      requestWakeLock();
    }, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        scan();
        requestWakeLock();
      }
    }, { passive: true });

    requestWakeLock();
  }

  init();
})();
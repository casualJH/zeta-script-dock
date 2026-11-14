// ==UserScript==
// @name         제타 스크립트 Dock
// @namespace    zeta-script-dock
// @version      0.4.0
// @description  제타의 플로팅 버튼을 선택적으로 모으는 자동 감지 Dock. 사용자가 고른 버튼만 모으며 Shadow DOM 아이콘 버튼 탐색을 지원합니다.
// @author       제타 스크립트 Dock
// @match        https://zeta-ai.io/*
// @match        https://*.zeta-ai.io/*
// @run-at       document-start
// @noframes
// @grant        none
// @updateURL    https://raw.githubusercontent.com/casualJH/zeta-script-dock/main/zeta-script-dock.user.js
// @downloadURL  https://raw.githubusercontent.com/casualJH/zeta-script-dock/main/zeta-script-dock.user.js
// @homepageURL  https://github.com/casualJH/zeta-script-dock
// ==/UserScript==

(function () {
  'use strict';
  // 독립적인 Dock: 다른 스크립트의 실행 코드를 수정하지 않습니다.
  if (window.__zetaScriptDock010) return;
  window.__zetaScriptDock010 = true;

  const VERSION = '0.4.0';
  const STORAGE_KEY = 'zeta-script-dock-v1';
  const HOST_ID = 'zsd-dock-host';
  const HIDDEN_CLASS = 'zsd-dock-parked';
  const KNOWN_LAUNCHERS = {
    'zcp-launch': '프로필',
    'zce-launch': '대화 저장'
  };
  const SKIP_ANCESTORS = 'dialog,[role="dialog"],[aria-modal="true"],nav,[role="navigation"],header,[role="banner"],footer,[role="contentinfo"],[role="menu"],[role="listbox"],form';
  const CLICKABLE_SELECTOR = 'button,[role="button"],input[type="button"],input[type="submit"],a[href],[onclick],[tabindex],[style*="cursor"],[class*="cursor-pointer"]';
  // 텍스트가 없는 FAB도 찾기: 아이콘, CSS로 배치된 원형 버튼, 아이콘을 감싼 div.
  const FLOATING_SEED_SELECTOR = '[id],[style*="position"],[class*="fixed"],[class*="floating"],[class*="Floating"],[class*="launcher"],[class*="Launcher"]';
  const ICON_SELECTOR = 'svg,img,[class*="rounded-full"],[class*="rounded-2xl"]';
  const EMOJI_RE = /\p{Extended_Pictographic}/u;
  const now = () => Date.now();
  const clip = (x, lo, hi) => Math.min(Math.max(x, lo), Math.max(lo, hi));
  const nodes = new Map();
  const manualNodes = new Map();
  const parked = new Map();
  const EXECUTION_MODES = new Map([
    ['click', '클릭'],
    ['pointer', '포인터'],
    ['native', '원본 직접 실행']
  ]);
  const activeKeys = new Set();
  const activeElements = new WeakSet();
  const parkedStyles = new WeakMap();
  let config = loadConfig();
  let host, shadow, launch, panel, dock, dockItems, sizeSelect, iconOnlyInput, listDock, listFound, listIgnored, titleCounter, emptyDock, pickNotice;
  let opened = false, editing = false, picking = false, pickedClick = null, pickedUntil = 0;
  let pickHighlighted = null, scanning = false, scanTimer = 0, renderTimer = 0;
  let observer = null, position = null;

  function loadConfig() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) { saved = {}; }
    const entries = {};
    if (saved && saved.entries && typeof saved.entries === 'object' && !Array.isArray(saved.entries)) {
      for (const [key, item] of Object.entries(saved.entries).slice(0, 400)) {
        if (!/^.{1,240}$/.test(key) || !item || !['dock', 'ignore'].includes(item.mode)) continue;
        entries[key] = {
          mode: item.mode,
          label: typeof item.label === 'string' ? item.label.slice(0, 70) : '',
          order: Number.isFinite(item.order) ? item.order : 0,
          icon: typeof item.icon === 'string' ? normalizeIcon(item.icon) : '',
          execution: EXECUTION_MODES.has(item.execution) ? item.execution : 'click'
        };
      }
    }
    return {entries, iconOnly: saved?.iconOnly === true, launchSize: Number.isInteger(saved?.launchSize) && saved.launchSize >= 28 && saved.launchSize <= 96 ? saved.launchSize : 40, position: saved && saved.position && Number.isFinite(saved.position.x) && Number.isFinite(saved.position.y)
      ? {x: saved.position.x, y: saved.position.y} : null};
  }

  function saveConfig() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); return true; }
    catch (_) { toast('설정을 저장할 수 없어요. Safari 저장소 설정을 확인해 주세요.'); return false; }
  }
  function hash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  function tidy(s, len = 60) { return String(s || '').replace(/[\s\u200b-\u200d]+/g, ' ').trim().slice(0, len); }
  function hintName(el) {
    if (KNOWN_LAUNCHERS[el.id]) return KNOWN_LAUNCHERS[el.id];
    // icon-only 버튼은 텍스트가 없을 수 있어 img의 alt나 aria-label도 확인.
    return tidy(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-title') ||
      el.querySelector('img[alt]')?.getAttribute('alt') || el.innerText || el.textContent || '', 42);
  }
  function closestFloating(el) {
    let p = el;
    for (let i = 0; p && i < 14; i++, p = p.parentElement || (p.getRootNode()?.host || null)) {
      const st = getComputedStyle(p);
      if (st.position === 'fixed') return p;
    }
    return null;
  }
  // 열린 Shadow DOM도 탐색합니다. 닫힌(closed) shadowRoot는 외부 접근이 제한됩니다.
  function roots() {
    const out = [document];
    for (let i = 0; i < out.length && i < 100; i++) {
      const root = out[i];
      const all = root.querySelectorAll('*');
      for (let j = 0; j < all.length; j++) {
        const el = all[j];
        if (el.id === HOST_ID) continue;
        if (el.shadowRoot && out.length < 100) out.push(el.shadowRoot);
      }
    }
    return out;
  }
  function queryAll(selector, scopes) {
    const found = [];
    for (const root of scopes) found.push(...root.querySelectorAll(selector));
    return found;
  }
  function isOwn(el) {
    return el.id === HOST_ID || !!el.closest('#' + HOST_ID) || el.getRootNode() === shadow;
  }
  function nearestHostRoot(el) {
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }
  function hasIconFace(el) {
    if (!(el instanceof HTMLElement)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20 || r.width > 160 || r.height > 160) return false;
    if (el.querySelector('button,[role="button"],a[href],input[type="button"]')) return false;
    const name = hintName(el);
    if (name.length > 28) return false;
    const st = getComputedStyle(el);
    const icon = !!el.querySelector('svg,img') || EMOJI_RE.test(name) || EMOJI_RE.test(tidy(el.textContent, 30));
    const pseudoBefore = getComputedStyle(el, '::before').content;
    const pseudoAfter = getComputedStyle(el, '::after').content;
    const pseudoIcon = [pseudoBefore, pseudoAfter].some(x => x && x !== 'none' && x !== 'normal' && x !== '""' && x !== "''");
    const bgIcon = st.backgroundImage && st.backgroundImage !== 'none';
    const radius = parseFloat(st.borderTopLeftRadius) || 0;
    const round = st.borderRadius.includes('%') || radius >= Math.min(r.width, r.height) * .25;
    const visuallyRaised = st.boxShadow !== 'none' || st.borderStyle !== 'none' && st.borderWidth !== '0px';
    return icon || pseudoIcon || bgIcon || (round && visuallyRaised && name.length <= 14);
  }
  function isClickableShape(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.matches('button,[role="button"],input[type="button"],input[type="submit"],a[href],[onclick]')) return true;
    if (getComputedStyle(el).cursor === 'pointer') return true;
    return hasIconFace(el);
  }
  function resolveIconTarget(node) {
    let p = node instanceof HTMLElement ? node : node.parentElement;
    let fallback = null;
    for (let i = 0; p && i < 12; i++, p = p.parentElement || nearestHostRoot(p)) {
      if (!(p instanceof HTMLElement)) continue;
      if (!isLauncher(p, true)) continue;
      if (p.matches('button,[role="button"],a[href],[onclick]') || getComputedStyle(p).cursor === 'pointer') return p;
      if (!isClickableShape(p)) continue;
      const st = getComputedStyle(p);
      // SVG를 담은 작은 span보다 실제 원형 배경을 가진 부모를 선택해서
      // 아이콘만 사라지고 동그란 버튼이 남는 문제를 방지.
      const hasSurface = (st.backgroundColor !== 'rgba(0, 0, 0, 0)' && st.backgroundColor !== 'transparent') ||
        st.boxShadow !== 'none' || (parseFloat(st.borderTopWidth) || 0) > 0;
      if (hasSurface || !fallback) fallback = p;
    }
    return fallback;
  }
  function addFloatingCandidates(set, scopes) {
    // CSS 클래스/인라인 스타일로 fixed를 지정한 아이콘-only wrapper를 수집.
    // 문서 전체의 버튼이나 카운터를 Dock에 자동 등록하지는 않음.
    const seeds = queryAll(FLOATING_SEED_SELECTOR, scopes);
    const seedLimit = Math.min(seeds.length, 4500);
    for (let i = 0; i < seedLimit; i++) {
      const root = seeds[i];
      if (!(root instanceof HTMLElement) || isOwn(root)) continue;
      if (getComputedStyle(root).position !== 'fixed') continue;
      const r = root.getBoundingClientRect();
      if (r.width < 20 || r.height < 20 || r.width > 320 || r.height > 320) continue;
      if (isLauncher(root, true) && isClickableShape(root)) set.add(root);
      // fixed wrapper 안에 cursor:pointer가 없는 SVG, IMG, emoji div가 있을 수 있음.
      const descendants = root.querySelectorAll('button,[role="button"],[onclick],[tabindex],svg,img,div,span');
      for (let j = 0; j < Math.min(descendants.length, 85); j++) {
        const child = descendants[j];
        if (!(child instanceof HTMLElement)) {
          if (child.matches('svg,img')) {
            const target = resolveIconTarget(child);
            if (target) set.add(target);
          }
          continue;
        }
        if (child.childElementCount > 6) continue;
        if (isLauncher(child, true) && isClickableShape(child)) set.add(child);
      }
    }
    // fixed 위치를 JS 스타일 시트에서 지정하는 버튼도 SVG/IMG 경유로 탐색.
    const graphics = queryAll(ICON_SELECTOR, scopes);
    for (let i = 0; i < Math.min(graphics.length, 2400); i++) {
      const target = resolveIconTarget(graphics[i]);
      if (target) set.add(target);
    }
    // CSS가 별도 스타일시트에만 있고 id도 없는 이모지 버튼 처리.
    const compact = queryAll('div,span', scopes);
    for (let i = 0; i < Math.min(compact.length, 12000); i++) {
      const el = compact[i];
      if (el.childElementCount > 2 || isOwn(el)) continue;
      const directText = Array.from(el.childNodes).filter(n => n.nodeType === 3)
        .map(n => n.nodeValue.trim()).join('').slice(0, 12);
      if (directText && EMOJI_RE.test(directText)) {
        const target = resolveIconTarget(el);
        if (target) set.add(target);
      }
    }
  }
  function isLauncher(el, allowLoose = false) {
    if (!(el instanceof HTMLElement) || isOwn(el)) return false;
    if (el.closest(SKIP_ANCESTORS) || el.closest('[contenteditable="true"],[hidden],[aria-hidden="true"]')) return false;
    if (el.disabled) return false;
    const label = hintName(el);
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    const w = window.innerWidth, h = window.innerHeight;
    if (r.width < 20 || r.height < 20 || r.width > Math.min(270, w * .8) || r.height > 125) return false;
    if (r.bottom < 0 || r.top > h || r.right < 0 || r.left > w) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' && !el.classList.contains(HIDDEN_CLASS)) return false;
    const fixed = closestFloating(el);
    if (!fixed) return false;
    const fr = fixed.getBoundingClientRect();
    if (fr.width > w * .92 && fr.height > 80) return false;
    if (fr.width > 275 && fr.height > 225) return false; // 원본 설정 패널 내부의 버튼은 탐색하지 않음.
    // 여러 조작 버튼을 담고 있는 가로 도구막대는 단독 실행 버튼이 아닙니다.
    // 커뮤 반응 패널의 '5개/10개/완료/취소/설정' 등을 후보로 수집하지 않도록 합니다.
    if (fixed !== el && fr.width > 275) {
      const buttons = fixed.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]');
      if (buttons.length >= 2) return false;
    }
    if (fr.height > h * .48 && fr.width > w * .4) return false;
    if (!allowLoose && !el.matches('button,[role="button"],input[type="button"],input[type="submit"],a[href],[onclick]') && st.cursor !== 'pointer' && !hasIconFace(el)) return false;
    if (!allowLoose && el.querySelector('button,[role="button"],a[href]')) return false;
    if (st.pointerEvents === 'none' && !el.classList.contains(HIDDEN_CLASS)) return false;
    return true;
  }
  function idSignature(el) {
    if (el.id && !/^(:|[\d\-]{8,}|radix-|headlessui-|react-)/i.test(el.id)) return 'id:' + el.id.slice(0, 100);
    const labeled = hintName(el);
    const attrNames = ['data-testid', 'data-zeta-hub-id', 'aria-label', 'title'];
    const stableAttrs = attrNames.map(k => tidy(el.getAttribute(k), 90)).filter(Boolean).join('|');
    const group = el.closest('[id]:not(#' + HOST_ID + ')') || nearestHostRoot(el);
    const parentId = group && group !== el ? tidy(group.id, 50) : '';
    // Tailwind 유틸리티 클래스는 자주 변경되므로, 식별력 있는 이름만 사용합니다.
    const classes = typeof el.className === 'string' ? el.className.split(/\s+/)
      .filter(s => s !== HIDDEN_CLASS && s !== 'zsd-pick-mark' && /^[a-z][a-z0-9_-]{3,}$/i.test(s) && (/^(z[a-z]{1,5}[-_]|zeta|tm[-_])/.test(s) || /(?:launch|floating|toggle|dock|button|widget|quick|menu)/i.test(s)))
      .slice(0, 4).sort().join('.') : '';
    const icon = el.querySelector('svg use')?.getAttribute('href') ||
      el.querySelector('svg path')?.getAttribute('d')?.slice(0, 100) ||
      el.querySelector('img')?.getAttribute('src')?.split('?')[0]?.slice(-100) || '';
    const bgImage = getComputedStyle(el).backgroundImage;
    const background = bgImage && bgImage !== 'none' ? hash(bgImage.slice(0, 4000)) : '';
    if (![stableAttrs, labeled, classes, parentId, icon, background].some(Boolean)) {
      const st = getComputedStyle(el);
      const childShape = (el.querySelector('svg,img')?.outerHTML || '').slice(0, 180);
      const fallback = [el.tagName, st.backgroundColor, st.borderRadius, childShape, tidy(el.textContent, 30)].join('|');
      if (!fallback.replace(/[| ]/g, '')) return null;
      return 'auto:' + hash(fallback);
    }
    const raw = [el.tagName.toLowerCase(), stableAttrs, labeled, classes, parentId, icon, background].join('|');
    return 'auto:' + hash(raw);
  }
  function buttonName(el, key) {
    const own = config.entries[key]?.label;
    if (own) return own;
    const name = hintName(el);
    if (name === '🎨') return '컬러 커스터마이저';
    if (name === '📚') return '책 아이콘 기능';
    return name || ('아이콘 버튼 · ' + key.slice(-4));
  }

  function restore(key) {
    const el = parked.get(key);
    if (el) {
      if (el.classList.contains(HIDDEN_CLASS)) el.classList.remove(HIDDEN_CLASS);
      const old = parkedStyles.get(el);
      if (old) {
        for (const prop of ['visibility','pointer-events']) {
          if (old[prop].value) el.style.setProperty(prop, old[prop].value, old[prop].priority);
          else el.style.removeProperty(prop);
        }
        parkedStyles.delete(el);
      }
    }
    parked.delete(key);
  }
  function park(key, el) {
    const old = parked.get(key);
    if (old && old !== el) restore(key);
    if (!el || !el.isConnected) { restore(key); return; }
    if (!parkedStyles.has(el)) {
      const style = {};
      for (const prop of ['visibility','pointer-events'])
        style[prop] = {value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop)};
      parkedStyles.set(el, style);
    }
    if (!el.classList.contains(HIDDEN_CLASS)) el.classList.add(HIDDEN_CLASS);
    // Shadow DOM에는 문서 스타일이 적용되지 않아 인라인 중요 규칙도 지정합니다.
    if (el.style.getPropertyValue('visibility') !== 'hidden' || el.style.getPropertyPriority('visibility') !== 'important')
      el.style.setProperty('visibility', 'hidden', 'important');
    if (el.style.getPropertyValue('pointer-events') !== 'none' || el.style.getPropertyPriority('pointer-events') !== 'important')
      el.style.setProperty('pointer-events', 'none', 'important');
    parked.set(key, el);
  }
  function restoreAll() { for (const key of Array.from(parked.keys())) restore(key); }

  function scan() {
    if (scanning || !document.body) return;
    scanning = true;
    try {
      const found = new Map();
      const candidates = new Set();
      const scopes = roots();
      const direct = queryAll(CLICKABLE_SELECTOR, scopes);
      for (let i = 0; i < Math.min(direct.length, 5000); i++) candidates.add(direct[i]);
      addFloatingCandidates(candidates, scopes);
      // 부모 wrapper와 자식 실행 버튼이 모두 포착되면 더 구체적인 버튼을 우선.
      const resolved = Array.from(candidates).filter(el => isLauncher(el) && isClickableShape(el));
      resolved.sort((a, b) => {
        if (a.contains(b)) return 1;
        if (b.contains(a)) return -1;
        return 0;
      });
      for (const el of resolved) {
        // 상위 wrapper는 실제 클릭 가능한 아이콘/버튼이 안에 있으면 별도 등록하지 않음.
        if (Array.from(found.values()).some(r => el.contains(r.el))) continue;
        const key = idSignature(el);
        if (!key || found.has(key)) continue;
        found.set(key, {el, key});
      }
      // 직접 선택한 특수 버튼도 페이지가 바뀌기 전까지 계속 추적합니다.
      for (const [key, el] of manualNodes) {
        if (el.isConnected && isLauncher(el, true)) found.set(key, {el, key});
        else manualNodes.delete(key);
      }
      // 선택된 원본이 화면에서 없어지면 반드시 이전 숨김 처리를 해제합니다.
      for (const [key, el] of parked) {
        if (!found.has(key) || found.get(key).el !== el || config.entries[key]?.mode !== 'dock') restore(key);
      }
      for (const [key, record] of found) {
        if (config.entries[key]?.mode === 'dock' && !activeKeys.has(key) && !activeElements.has(record.el)) park(key, record.el);
        else if (record.el.classList.contains(HIDDEN_CLASS)) restore(key);
      }
      const before = Array.from(nodes.values()).map(r => r.key + '=' + hintName(r.el)).sort().join('\n');
      const after = Array.from(found.values()).map(r => r.key + '=' + hintName(r.el)).sort().join('\n');
      nodes.clear(); for (const [key, value] of found) nodes.set(key, value);
      if (before !== after) scheduleRender();
      else updateCounter();
    } catch (err) { console.warn('[제타 스크립트 Dock] 버튼 탐색 오류', err); }
    finally { scanning = false; }
  }
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, 350);
  }
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = 0; render(); }, 80);
  }
  function setMode(key, mode) {
    if (!nodes.has(key) && !config.entries[key]) return;
    if (config.entries[key] && config.entries[key].mode === 'dock') restore(key);
    if (mode === 'dock' || mode === 'ignore') {
      const item = config.entries[key] || {label: '', order: nextOrder()};
      item.mode = mode;
      config.entries[key] = item;
    } else delete config.entries[key];
    saveConfig();
    scan();
    scheduleRender();
  }
  function nextOrder() { return Math.max(0, ...Object.values(config.entries).map(x => x.order || 0)) + 1; }
  // 특정 스크립트는 원형 외부 래퍼가 후보로 탐색됩니다.
  // 실제 clickable 자식이 하나뿐이면 가장 안쪽의 실행 요소를 우선 선택합니다.
  function activationTarget(el) {
    if (el.matches('button,[role="button"],a[href],input[type="button"],[onclick]')) return el;
    const inner = [...el.querySelectorAll('button,[role="button"],a[href],input[type="button"],[onclick]')]
      .filter(child => child.getBoundingClientRect().width >= 18 && child.getBoundingClientRect().height >= 18);
    return inner.length === 1 ? inner[0] : el;
  }
  function trigger(key, execution = config.entries[key]?.execution || 'click') {
    const el = nodes.get(key)?.el;
    if (!el?.isConnected || config.entries[key]?.mode !== 'dock') {
      toast('이 버튼이 현재 화면에 없습니다. 편집 모드에서 연결 상태를 확인해 주세요.');
      return;
    }
    if (activeKeys.has(key) || activeElements.has(el)) return;
    activeKeys.add(key);
    activeElements.add(el);

    let timer;
    let finishScheduled = false;
    function finish() {
      clearTimeout(timer);
      el.removeEventListener('click', onNativeClick, true);
      activeElements.delete(el);
      activeKeys.delete(key);
      if (el.isConnected && nodes.get(key)?.el === el && config.entries[key]?.mode === 'dock') park(key, el);
      scheduleScan();
    }
    function onNativeClick(event) {
      if (!event.isTrusted || finishScheduled) return;
      finishScheduled = true;
      clearTimeout(timer);
      timer = setTimeout(finish, 350);
    }

    try {
      restore(key);
      opened = false;
      editing = false;
      updatePanel();

      if (execution === 'native') {
        el.addEventListener('click', onNativeClick, true);
        timer = setTimeout(finish, 20000);
        toast('원래 위치의 버튼을 직접 눌러 주세요. 20초 뒤 다시 Dock에 숨겨집니다.');
        return;
      }

      const target = activationTarget(el);
      if (execution === 'pointer') {
        if (typeof window.PointerEvent !== 'function') {
          toast('이 브라우저에서는 포인터 실행을 지원하지 않아요. 원본 버튼을 사용해 주세요.');
          return;
        }
        const rect = target.getBoundingClientRect();
        const opts = {bubbles:true,cancelable:true,composed:true,pointerId:1,
          pointerType:'touch',isPrimary:true,button:0,buttons:1,
          clientX:rect.left + rect.width / 2,clientY:rect.top + rect.height / 2};
        target.dispatchEvent(new window.PointerEvent('pointerdown', opts));
        if (target.isConnected) target.dispatchEvent(new window.PointerEvent('pointerup', {...opts,buttons:0}));
      } else if (typeof target.click === 'function') {
        target.click();
      } else {
        target.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,composed:true,view:window}));
      }
    } catch (error) {
      console.warn('[제타 스크립트 Dock] 원본 버튼 실행 실패', error);
      toast('실행 중 오류가 발생했어요. 원본 버튼을 사용해 주세요.');
    } finally {
      if (timer === undefined) timer = setTimeout(finish, 350);
    }
  }
  function makeExecutionSelect(key, label) {
    const select = document.createElement('select');
    select.className = 'zsd-small';
    select.setAttribute('aria-label', label + ' 실행 방식');
    for (const [value, text] of EXECUTION_MODES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = config.entries[key].execution || 'click';
    select.addEventListener('change', () => {
      const item = config.entries[key];
      if (item?.mode !== 'dock' || !EXECUTION_MODES.has(select.value)) return;
      item.execution = select.value;
      saveConfig();
    });
    return select;
  }
  function toast(message) {
    if (!shadow) { console.warn('[제타 스크립트 Dock]', message); return; }
    const target = shadow.getElementById('zsd-toast');
    target.textContent = message;
    target.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { target.hidden = true; }, 4200);
  }

  function makeButton(text, className, fn, aria) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = className;
    btn.textContent = text; if (aria) btn.setAttribute('aria-label', aria);
    btn.addEventListener('click', fn);
    return btn;
  }
  function makeRow(label, meta, actions, mainAction) {
    const row = document.createElement('div'); row.className = 'zsd-item';
    const info = document.createElement('div'); info.className = 'zsd-item-info';
    const main = makeButton(label, 'zsd-name', mainAction || (() => {}));
    if (!mainAction) main.disabled = true;
    const sub = document.createElement('span'); sub.className = 'zsd-meta'; sub.textContent = meta;
    info.append(main, sub);
    const controls = document.createElement('div'); controls.className = 'zsd-item-actions';
    for (const item of actions) controls.append(makeButton(item.text, item.kind || 'zsd-small', item.fn, item.aria));
    row.append(info, controls);
    return row;
  }
  function updateCounter() {
    if (!titleCounter) return;
    const selected = Object.keys(config.entries).filter(key => config.entries[key].mode === 'dock');
    const active = selected.filter(key => nodes.has(key));
    titleCounter.textContent = `${active.length}/${selected.length} 연결`;
    const newCount = Array.from(nodes.keys()).filter(key => !config.entries[key]).length;
    launch.setAttribute('aria-label', `제타 스크립트 Dock 열기 · 새 버튼 후보 ${newCount}개`);
    const marker = shadow.getElementById('zsd-dot');
    marker.hidden = newCount === 0;
  }
  function render() {
    if (!panel) return;
    listDock.replaceChildren(); listFound.replaceChildren(); listIgnored.replaceChildren();
    const keys = Object.keys(config.entries);
    const chosen = keys.filter(k => config.entries[k].mode === 'dock')
      .sort((a,b) => config.entries[a].order - config.entries[b].order);
    renderDock(chosen);
    emptyDock.hidden = chosen.length > 0;
    for (const key of chosen) {
      const record = nodes.get(key);
      const label = record ? buttonName(record.el, key) : (config.entries[key].label || (key.startsWith('id:') ? key.slice(3) : '연결 대기 중'));
      const row = makeRow(label, record ? '연결됨 · 순서를 드래그하여 변경' : '현재 페이지에서 찾지 못함', [
        {text: '아이콘', fn: () => editIcon(key, label)},
        {text: '이름', fn: () => rename(key, label)},
        {text: '빼기', fn: () => setMode(key, null)}
      ]);
      row.querySelector('.zsd-item-actions').prepend(makeExecutionSelect(key, label));
      const handle = makeButton('⠿', 'zsd-handle', () => {}, '순서 변경: ' + label);
      handle.title = '이동하려면 드래그하세요';
      row.insertBefore(handle, row.firstChild);
      row.dataset.dockKey = key;
      listDock.append(row);
    }
    const waiting = Array.from(nodes.values()).filter(r => !config.entries[r.key])
      .sort((a,b) => buttonName(a.el,a.key).localeCompare(buttonName(b.el,b.key), 'ko'));
    for (const record of waiting) {
      const label = buttonName(record.el, record.key);
      listFound.append(makeRow(label, '자동 감지됨 · 원본 버튼 유지 중', [
        {text: '추가', kind: 'zsd-small zsd-primary', fn: () => setMode(record.key, 'dock')},
        {text: '제외', fn: () => setMode(record.key, 'ignore')}
      ]));
    }
    shadow.getElementById('zsd-found-count').textContent = `${waiting.length}개`;
    shadow.getElementById('zsd-empty-found').hidden = waiting.length > 0;
    const ignored = keys.filter(k => config.entries[k].mode === 'ignore');
    for (const key of ignored) {
      const item = config.entries[key];
      const label = nodes.has(key) ? buttonName(nodes.get(key).el, key) : (item.label || (key.startsWith('id:') ? key.slice(3) : '제외된 버튼'));
      listIgnored.append(makeRow(label, nodes.has(key) ? '원본 위치에서 사용 중' : '현재 페이지에 없음', [
        {text: '해제', fn: () => setMode(key, null)}
      ]));
    }
    shadow.getElementById('zsd-ignored-count').textContent = `${ignored.length}개`;
    shadow.getElementById('zsd-empty-ignored').hidden = ignored.length > 0;
    shadow.getElementById('zsd-editor').hidden = !editing;
    shadow.getElementById('zsd-done').hidden = !editing;
    shadow.getElementById('zsd-mode-note').textContent = editing ? '손잡이를 드래그해 순서를 변경하세요' : '선택한 기능을 눌러 실행하세요';
    updateCounter();
  }

  // Pointer Events 기반으로 iOS Safari의 터치와 데스크톱 마우스 모두 지원합니다.
  // 정렬은 기존 저장 키와 order 값만 사용합니다.
  function attachListSorting() {
    let moving = null;
    listDock.addEventListener('pointerdown', e => {
      if (!editing || !e.target.closest('.zsd-handle')) return;
      const handle = e.target.closest('.zsd-handle');
      const row = handle.closest('[data-dock-key]');
      if (!row || (e.button !== 0 && e.pointerType !== 'touch')) return;
      moving = {id:e.pointerId, handle, row, start:e.clientY, changed:false};
      row.classList.add('zsd-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    listDock.addEventListener('pointermove', e => {
      if (!moving || moving.id !== e.pointerId) return;
      e.preventDefault();
      const {row} = moving;
      const others = Array.from(listDock.querySelectorAll('[data-dock-key]')).filter(el => el !== row);
      for (const other of others) {
        const bounds = other.getBoundingClientRect();
        if (e.clientY < bounds.top + bounds.height / 2) {
          if (row.nextElementSibling !== other) {listDock.insertBefore(row, other); moving.changed=true;}
          return;
        }
      }
      if (listDock.lastElementChild !== row) {listDock.append(row); moving.changed=true;}
      // 이동 중 목록 위/아래로 살짝 벗어나면 패널 스크롤
      const box = panel.getBoundingClientRect();
      if (e.clientY < box.top+65) panel.scrollTop -= 12;
      else if (e.clientY > box.bottom-45) panel.scrollTop += 12;
    });
    function finish(e) {
      if (!moving || (e && e.pointerId !== moving.id)) return;
      const state = moving; moving = null;
      state.row.classList.remove('zsd-dragging');
      if (!state.changed) return;
      const ordered = Array.from(listDock.querySelectorAll('[data-dock-key]')).map(el => el.dataset.dockKey);
      // 항목이 화면에서 일시적으로 사라져도 설정 항목 자체는 유지
      ordered.forEach((key,i) => {if(config.entries[key]) config.entries[key].order = i+1;});
      saveConfig();
      render();
    }
    listDock.addEventListener('pointerup', finish);
    listDock.addEventListener('pointercancel', finish);
    window.addEventListener('pointerup', finish);
  }
  function rename(key, oldName) {
    const value = window.prompt('Dock에 표시할 이름을 입력하세요.', oldName);
    if (value == null) return;
    const clean = tidy(value, 40);
    if (!clean) return;
    config.entries[key].label = clean;
    saveConfig(); render();
  }
  function normalizeIcon(value) {
    return Array.from(value.trim()).slice(0, 32).join('');
  }
  const DEFAULT_DOCK_ICONS = new Map([
    ['프로필', '👤'], ['대화 저장', '💾'], ['제타 텍스트 보관함 열기', '🗂'],
    ['제타 컬러 커스터마이저', '🎨'], ['커뮤 반응', '💬']
  ]);
  function defaultIcon(label, record) {
    return DEFAULT_DOCK_ICONS.get(label) ||
      (record && DEFAULT_DOCK_ICONS.get(hintName(record.el))) ||
      firstCharacter(label) || '·';
  }
  function editIcon(key, label) {
    const item = config.entries[key];
    const value = window.prompt(label + ' 아이콘을 입력하세요. 비우면 기본 아이콘을 사용해요.', item.icon || '');
    if (value === null) return;
    item.icon = normalizeIcon(value);
    saveConfig();
    render();
  }
  function firstCharacter(label) {
    if (typeof Intl.Segmenter === 'function') {
      return new Intl.Segmenter().segment(label)[Symbol.iterator]().next().value?.segment || '';
    }
    return Array.from(label)[0] || '';
  }
  function renderDock(chosen) {
    const focused = shadow.activeElement?.dataset.dockKey;
    dockItems.replaceChildren();
    for (const key of chosen) {
      const record = nodes.get(key);
      if (!record?.el.isConnected) continue;
      const item = config.entries[key];
      const label = buttonName(record.el, key);
      const native = item.execution === 'native';
      const name = native ? label + ' · 원본 직접 실행' : label;
      const button = makeButton(item.icon || defaultIcon(label, record),
        'zsd-dock-icon', () => trigger(key), name);
      const icon = document.createElement('span');
      icon.className = 'zsd-icon-glyph';
      icon.textContent = button.textContent;
      icon.setAttribute('aria-hidden', 'true');
      const caption = document.createElement('span');
      caption.className = 'zsd-dock-label';
      caption.textContent = label;
      button.replaceChildren(icon, caption);
      button.dataset.dockKey = key;
      button.title = name;
      if (native) {
        const badge = document.createElement('span');
        badge.className = 'zsd-native-badge';
        badge.setAttribute('aria-hidden', 'true');
        badge.textContent = '↗';
        button.append(badge);
      }
      dockItems.append(button);
      if (focused === key) button.focus();
    }
    if (opened && !editing) placePanel();
  }
  function updatePanel() {
    panel.hidden = !opened || !editing;
    dock.hidden = !opened || editing;
    launch.setAttribute('aria-expanded', String(opened));
    if (opened) { render(); requestAnimationFrame(placePanel); }
  }
  function updateSizeValue() {
    shadow.getElementById('zsd-size-value').textContent = sizeSelect.value + ' px';
  }
  function showPanel() {
    sizeSelect.value = String(config.launchSize);
    iconOnlyInput.checked = config.iconOnly;
    updateSizeValue();
    opened = true;
    editing = true;
    updatePanel();
  }
  function clampPos(x, y) {
    const sw = window.innerWidth, sh = window.innerHeight;
    return {x: clip(x, 6, Math.max(6, sw - config.launchSize - 6)), y: clip(y, 8, Math.max(8, sh - config.launchSize - 12))};
  }
  function setLaunchPos(x, y, persist) {
    position = clampPos(x, y);
    launch.style.left = position.x + 'px'; launch.style.top = position.y + 'px';
    if (persist) { config.position = {...position}; saveConfig(); }
    if (opened) placePanel();
  }
  function placePanel() {
    if (!opened || !panel) return;
    const size = config.launchSize;
    const above = position.y - 8;
    const below = window.innerHeight - position.y - size - 8;
    if (!editing) {
      const gap = 8;
      const useAbove = above >= below;
      dock.style.maxHeight = Math.max(0, (useAbove ? above : below) - gap) + 'px';
      const center = position.x + size / 2;
      dock.toggleAttribute('data-icon-only', config.iconOnly);
      if (config.iconOnly) {
        const width = 58;
        const left = clip(center - width / 2, 0, window.innerWidth - width);
        dock.removeAttribute('data-icons-right');
        dock.style.width = width + 'px';
        dock.style.left = left + 'px';
        dock.style.setProperty('--zsd-icon-offset', (center - left - width / 2) + 'px');
        dock.style.top = (useAbove ? position.y - gap - dock.offsetHeight : position.y + size + gap) + 'px';
        return;
      }
      const iconsRight = center > window.innerWidth / 2;
      const edgeRoom = iconsRight ? window.innerWidth - center : center;
      const inset = Math.min(29, edgeRoom - 6);
      const labelRoom = iconsRight ? center : window.innerWidth - center;
      const width = Math.min(214, labelRoom + inset - 8);
      dock.toggleAttribute('data-icons-right', iconsRight);
      dock.style.setProperty('--zsd-icon-padding', (inset - 20) + 'px');
      dock.style.width = width + 'px';
      dock.style.left = (iconsRight ? center + inset - width : center - inset) + 'px';
      dock.style.top = (useAbove ? position.y - gap - dock.offsetHeight : position.y + size + gap) + 'px';
      return;
    }
    const w = panel.offsetWidth || Math.min(390, window.innerWidth - 20);
    const h = panel.offsetHeight || Math.min(500, window.innerHeight - 20);
    const x = clip(position.x + size - w, 10, Math.max(10, window.innerWidth - w - 10));
    const y = position.y > window.innerHeight / 2
      ? clip(position.y - h - 12, 10, Math.max(10, window.innerHeight - h - 10))
      : clip(position.y + size + 11, 10, Math.max(10, window.innerHeight - h - 10));
    panel.style.left = x + 'px'; panel.style.top = y + 'px';
  }
  function attachDrag() {
    let state = null;
    launch.addEventListener('pointerdown', e => {
      if (e.button !== 0 && e.pointerType !== 'touch') return;
      state = {id: e.pointerId, sx: e.clientX, sy: e.clientY, x: position.x, y: position.y, moved: false};
      try { launch.setPointerCapture(e.pointerId); } catch (_) {}
    });
    launch.addEventListener('pointermove', e => {
      if (!state || e.pointerId !== state.id) return;
      const dx = e.clientX - state.sx, dy = e.clientY - state.sy;
      if (Math.hypot(dx,dy) > 6) state.moved = true;
      if (state.moved) { e.preventDefault(); setLaunchPos(state.x + dx, state.y + dy, false); }
    });
    launch.addEventListener('pointerup', e => {
      if (!state || e.pointerId !== state.id) return;
      if (state.moved) { setLaunchPos(position.x, position.y, true); launch.dataset.justDragged = 'yes'; }
      state = null;
    });
    launch.addEventListener('pointercancel', () => { state = null; });
    launch.addEventListener('click', e => {
      if (launch.dataset.justDragged) { delete launch.dataset.justDragged; e.preventDefault(); return; }
      opened = !opened || editing; editing = false; updatePanel();
    });
  }
  function choosePickTarget(target) {
    if (!(target instanceof Element) || isOwn(target)) return null;
    const found = resolveIconTarget(target);
    if (found) return found;
    // closed Shadow DOM은 내부를 볼 수 없으므로 바깥의 호스트 버튼을 직접 선택 가능하게 합니다.
    for (let p = target, i = 0; p && i < 9; i++, p = p.parentElement || nearestHostRoot(p)) {
      if (!(p instanceof HTMLElement) || isOwn(p)) continue;
      const r = p.getBoundingClientRect();
      const st = getComputedStyle(p);
      if (r.width < 20 || r.height < 20 || r.width > 180 || r.height > 160) continue;
      if (st.position === 'fixed' || st.cursor === 'pointer' || p.matches('button,[role=button],[onclick]')) return p;
    }
    return null;
  }
  function markPick(el) {
    if (pickHighlighted === el) return;
    if (pickHighlighted) pickHighlighted.classList.remove('zsd-pick-mark');
    pickHighlighted = el;
    if (el) el.classList.add('zsd-pick-mark');
  }
  function stopPicking(reopen = true) {
    picking = false; markPick(null);
    if (pickNotice) pickNotice.hidden = true;
    if (reopen) showPanel();
  }
  function beginPicking() {
    opened = false; updatePanel(); picking = true;
    pickNotice.hidden = false;
    toast('추가할 플로팅 버튼을 화면에서 터치하세요.');
  }
  function pickMovement(e) {
    if (!picking) return;
    markPick(choosePickTarget(e.target));
  }
  function preventPickEvent(e) {
    if (now() < pickedUntil && pickedClick && (pickedClick === e.target || pickedClick.contains(e.target))) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (!picking || e.type !== 'pointerdown' && e.type !== 'click') return;
    const target = choosePickTarget(e.target);
    if (!target) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const key = idSignature(target);
    if (!key) { toast('버튼을 구별할 수 없습니다. 다른 위치를 선택해 주세요.'); return; }
    nodes.set(key, {key, el: target});
    manualNodes.set(key, target);
    pickedClick = target; pickedUntil = now() + 850;
    stopPicking(false);
    setMode(key, 'dock');
    showPanel();
    toast('Dock에 등록했어요. 원본 버튼은 화면에서 숨겨집니다.');
  }

  function mount() {
    if (!document.body || document.getElementById(HOST_ID)) return;
    const hiddenStyle = document.createElement('style');
    hiddenStyle.id = 'zsd-dock-hide-style';
    hiddenStyle.textContent = `.${HIDDEN_CLASS}{visibility:hidden!important;pointer-events:none!important}.zsd-pick-mark{outline:3px solid #a68cff!important;outline-offset:3px!important}`;
    (document.head || document.documentElement).append(hiddenStyle);
    host = document.createElement('div'); host.id = HOST_ID;
    host.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483646!important;pointer-events:none!important;';
    shadow = host.attachShadow({mode:'open'});
    shadow.innerHTML = `
      <style>
        :host{all:initial;color-scheme:dark;font-family:system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif}
        *{box-sizing:border-box}button{font-family:inherit}button:focus-visible{outline:2px solid #c7b8ff;outline-offset:2px}
        #zsd-launch{position:fixed;left:0;top:0;width:var(--zsd-launch-size,40px);height:var(--zsd-launch-size,40px);display:grid;place-items:center;cursor:grab;touch-action:none;-webkit-user-select:none;user-select:none;border:1px solid #ffffff40;border-radius:50%;background:#242424ad;-webkit-backdrop-filter:blur(20px) saturate(125%);backdrop-filter:blur(20px) saturate(125%);color:#fff;box-shadow:0 7px 26px #0007;pointer-events:auto;z-index:2147483646;padding:0}
        #zsd-launch:active{cursor:grabbing}#zsd-launch svg{width:47%;height:47%;pointer-events:none}
        #zsd-dot{position:absolute;right:1px;top:1px;width:9px;height:9px;background:#dfdfdf;border:1px solid #333333;border-radius:50%}
        #zsd-dock{position:fixed;display:flex;flex-direction:column;align-items:center;gap:5px;width:min(214px,calc(100vw - 16px));padding:6px;border:1px solid #ffffff36;border-radius:21px;background:rgba(34,34,34,.20);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);box-shadow:0 4px 14px #0003;pointer-events:auto;overflow:hidden}
        #zsd-dock-items{width:100%;display:grid;gap:3px;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:none}
        #zsd-dock-items:empty{display:none}
        .zsd-dock-icon{position:relative;flex:none;display:grid;place-items:center;width:44px;height:44px;padding:0;border:0;border-radius:13px;background:transparent;color:#fff;font-size:21px;cursor:pointer}
        #zsd-dock-items .zsd-dock-icon{display:flex;align-items:center;gap:8px;width:100%;height:auto;min-height:44px;padding:6px 20px 6px var(--zsd-icon-padding,9px);text-align:left}
        #zsd-dock[data-icons-right] #zsd-dock-items .zsd-dock-icon,
        #zsd-dock[data-icons-right] #zsd-dock-settings{flex-direction:row-reverse;padding:6px var(--zsd-icon-padding,9px) 6px 20px;text-align:right}
        #zsd-dock[data-icons-right] .zsd-native-badge{right:auto;left:1px}
        .zsd-icon-glyph{display:block;flex:0 0 26px;width:26px;text-align:center;line-height:1.2;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
        #zsd-dock[data-icon-only] .zsd-dock-label{display:none}
        #zsd-dock[data-icon-only] #zsd-dock-items .zsd-dock-icon,
        #zsd-dock[data-icon-only] #zsd-dock-settings{justify-content:center;padding:0}
        #zsd-dock[data-icon-only] .zsd-icon-glyph{transform:translateX(var(--zsd-icon-offset,0px))}
        .zsd-dock-label{min-width:0;font-size:12px;line-height:1.3;overflow-wrap:anywhere}
        .zsd-size-setting input{min-width:0;flex:1;accent-color:#bd9bff}
        .zsd-size-setting output{min-width:42px;text-align:right;font-variant-numeric:tabular-nums}
        .zsd-dock-icon:hover,.zsd-dock-icon:focus-visible{background:#383838;outline-offset:-2px}
        .zsd-dock-icon:disabled{opacity:.38;cursor:default}
        #zsd-dock-settings{display:flex;align-items:center;width:100%;padding:6px 20px 6px var(--zsd-icon-padding,9px);border-top:1px solid #ffffff26;border-radius:0}
        #zsd-dock-items:empty + #zsd-dock-settings{width:100%;border-top:0}
        .zsd-native-badge{position:absolute;right:1px;top:1px;background:#505050;color:#fff;border-radius:50%;width:14px;height:14px;font-size:10px;line-height:14px}
        .zsd-size-setting{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 13px;border-bottom:1px solid #303034}
        #zsd-panel{position:fixed;left:10px;top:10px;width:min(390px,calc(100vw - 20px));max-height:min(560px,calc(100dvh - 35px));overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;background:#1b1b1e;color:#f4f3f6;border:1px solid #434049;border-radius:19px;box-shadow:0 15px 48px #000a;pointer-events:auto;z-index:2147483646;font:14px/1.45 system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif}
        [hidden]{display:none!important}.zsd-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:15px 16px;border-bottom:1px solid #303034;position:sticky;top:0;background:#1b1b1e;z-index:2}
        .zsd-title{font-size:17px;font-weight:750;letter-spacing:-.4px}.zsd-muted{color:#aaa8b0;font-size:11px}
        .zsd-head-actions{display:flex;align-items:center;gap:7px}.zsd-head-actions button{border:0;background:#34333a;color:#fff;border-radius:10px;min-width:36px;height:34px;font-size:19px;cursor:pointer}.zsd-head-actions #zsd-done{font-size:12px;font-weight:700;padding:0 10px;background:#524568}
        .zsd-section{padding:14px 13px 12px}.zsd-section+.zsd-section{border-top:1px solid #303034}
        .zsd-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px}.zsd-section-head strong{font-size:14px}
        .zsd-execution-tip{margin:0 2px 8px;color:#a7a4ae;font-size:12px;line-height:1.5}
        .zsd-list{background:#141416;border-radius:13px;overflow:hidden}.zsd-item{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:10px 10px;min-height:58px}
        .zsd-item+.zsd-item{border-top:1px solid #2c2b30}.zsd-item-info{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
        .zsd-name{color:#f7f6fa;background:none;border:0;text-align:left;font-size:14px;font-weight:650;padding:4px 0;white-space:normal;overflow-wrap:anywhere;cursor:pointer}
        .zsd-name:disabled{color:#b4b1ba;cursor:default}.zsd-meta{font-size:11px;color:#a3a0aa}
        .zsd-item-actions{display:flex;gap:5px;flex:none}.zsd-small{font-size:11px;font-weight:650;border:1px solid #514d59;background:#343139;color:#f1ecf5;padding:7px 9px;border-radius:9px;cursor:pointer}
        .zsd-handle{flex:none;width:30px;height:38px;border:0;background:transparent;color:#bbb1cd;font-size:24px;cursor:grab;touch-action:none;-webkit-user-select:none;user-select:none;padding:0}.zsd-handle:active{cursor:grabbing}.zsd-dragging{background:#332d3f;outline:1px solid #8571a5;position:relative;z-index:1}.zsd-run-row{cursor:pointer}.zsd-run-row:active{background:#292532}.zsd-primary{background:#524568;border-color:#8571a5}.zsd-empty{font-size:12px;color:#a7a4ae;padding:13px 8px}
        .zsd-toolbar{display:flex;gap:7px;flex-wrap:wrap;padding:0 13px 13px}.zsd-tool{flex:1;background:#2e2a35;border:1px solid #514a5e;border-radius:10px;color:white;padding:10px;font-size:12px;font-weight:650;cursor:pointer}
        details{border-top:1px solid #303034;padding:0 13px}summary{cursor:pointer;list-style:none;font-weight:650;font-size:12px;padding:13px 0;color:#bbb8c1}summary::-webkit-details-marker{display:none}
        #zsd-pick-notice{position:fixed;top:calc(14px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);width:min(350px,calc(100vw - 28px));padding:12px 12px;border-radius:13px;color:#fff;border:1px solid #8872ae;background:#282335;box-shadow:0 8px 30px #0008;pointer-events:auto;text-align:center;font:13px/1.5 system-ui;z-index:2147483647}
        #zsd-pick-notice button{margin-left:10px;background:#4a405c;border:1px solid #807093;border-radius:9px;color:#fff;padding:6px 9px}
        #zsd-toast{position:fixed;bottom:calc(24px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);max-width:calc(100vw - 25px);min-width:200px;padding:10px 14px;color:#fff;background:#3a304a;border:1px solid #786a89;border-radius:11px;font:12px/1.45 system-ui;box-shadow:0 8px 28px #0009;text-align:center;pointer-events:none;z-index:2147483647}
        @media(max-width:420px){.zsd-item{flex-wrap:wrap}.zsd-item-actions{width:100%;flex-wrap:wrap;justify-content:flex-end}}
      </style>
      <button id="zsd-launch" type="button" aria-label="제타 스크립트 Dock 열기" aria-expanded="false" aria-controls="zsd-dock zsd-panel">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>
        <span id="zsd-dot" hidden></span>
      </button>
      <nav id="zsd-dock" aria-label="내 Dock" hidden>
        <div id="zsd-dock-items"></div>
        <button id="zsd-dock-settings" class="zsd-dock-icon" type="button" aria-label="Dock 설정" title="Dock 설정"><span class="zsd-icon-glyph" aria-hidden="true">⚙</span></button>
      </nav>
      <section id="zsd-panel" role="dialog" aria-label="제타 스크립트 Dock" hidden>
        <div class="zsd-head"><div><div class="zsd-title">제타 스크립트 Dock</div><div class="zsd-muted" id="zsd-counter">0/0 연결</div></div><div class="zsd-head-actions"><button id="zsd-done" type="button" hidden>완료</button><button id="zsd-close" type="button" aria-label="Dock 닫기">×</button></div></div>
        <label class="zsd-size-setting">열기 버튼 크기<input id="zsd-launch-size" type="range" min="28" max="96" step="1" value="40"><output id="zsd-size-value" for="zsd-launch-size">40 px</output></label>
        <label class="zsd-size-setting">아이콘만 보기<input id="zsd-icon-only" type="checkbox"></label>
        <div class="zsd-section"><div class="zsd-section-head"><strong>내 Dock</strong><span class="zsd-muted" id="zsd-mode-note">선택한 기능을 눌러 실행하세요</span></div><p class="zsd-execution-tip">눌러도 실행되지 않으면 ⚙ 설정에서 해당 항목의 실행 방식을 클릭 → 포인터로 바꿔 보세요.</p><div class="zsd-list" id="zsd-list-dock"></div><div class="zsd-empty" id="zsd-empty-dock">아직 추가된 버튼이 없어요. 편집에서 필요한 버튼을 추가해 주세요.</div></div>
        <div id="zsd-editor" hidden><div class="zsd-section"><div class="zsd-section-head"><strong>발견된 새 버튼</strong><span class="zsd-muted" id="zsd-found-count">0개</span></div><div class="zsd-list" id="zsd-list-found"></div><div class="zsd-empty" id="zsd-empty-found">현재 발견된 새 플로팅 버튼이 없어요.</div></div>
        <div class="zsd-toolbar"><button id="zsd-pick" class="zsd-tool" type="button">화면에서 직접 선택</button><button id="zsd-refresh" class="zsd-tool" type="button">다시 찾기</button></div>
        <div class="zsd-section"><div class="zsd-section-head"><strong>제외한 버튼</strong><span class="zsd-muted" id="zsd-ignored-count">0개</span></div><div class="zsd-list" id="zsd-list-ignored"></div><div class="zsd-empty" id="zsd-empty-ignored">제외한 버튼이 없어요.</div></div>
        </div>
      </section>
      <div id="zsd-pick-notice" hidden>추가할 플로팅 버튼을 터치하세요.<button id="zsd-cancel-pick" type="button">취소</button></div>
      <div id="zsd-toast" role="status" hidden></div>`;
    document.body.appendChild(host);
    launch = shadow.getElementById('zsd-launch'); panel = shadow.getElementById('zsd-panel');
    listDock = shadow.getElementById('zsd-list-dock'); listFound = shadow.getElementById('zsd-list-found');
    listIgnored = shadow.getElementById('zsd-list-ignored'); titleCounter = shadow.getElementById('zsd-counter');
    emptyDock = shadow.getElementById('zsd-empty-dock'); pickNotice = shadow.getElementById('zsd-pick-notice');
    dock = shadow.getElementById('zsd-dock');
    dockItems = shadow.getElementById('zsd-dock-items');
    sizeSelect = shadow.getElementById('zsd-launch-size');
    iconOnlyInput = shadow.getElementById('zsd-icon-only');
    sizeSelect.addEventListener('input', updateSizeValue);
    launch.style.setProperty('--zsd-launch-size', config.launchSize + 'px');
    shadow.getElementById('zsd-dock-settings').addEventListener('click', showPanel);
    shadow.getElementById('zsd-done').addEventListener('click', () => {
      config.launchSize = Number(sizeSelect.value);
      config.iconOnly = iconOnlyInput.checked;
      launch.style.setProperty('--zsd-launch-size', config.launchSize + 'px');
      editing = false;
      setLaunchPos(position.x, position.y, true);
      updatePanel();
      launch.focus();
    });
    attachListSorting();
    shadow.getElementById('zsd-close').addEventListener('click', () => { opened = false; updatePanel(); });
    shadow.getElementById('zsd-pick').addEventListener('click', beginPicking);
    shadow.getElementById('zsd-refresh').addEventListener('click', () => { scan(); render(); toast('현재 화면의 플로팅 버튼을 다시 확인했어요.'); });
    shadow.getElementById('zsd-cancel-pick').addEventListener('click', () => stopPicking(true));
    attachDrag();
    const initPos = config.position || {x: window.innerWidth - 70, y: window.innerHeight - 110};
    setLaunchPos(initPos.x, initPos.y, false);
    window.addEventListener('resize', () => { setLaunchPos(position.x, position.y, true); scheduleScan(); });
    window.addEventListener('orientationchange', () => { setTimeout(() => { setLaunchPos(position.x, position.y, true); scheduleScan(); }, 300); });
    document.addEventListener('pointermove', pickMovement, true);
    document.addEventListener('pointerdown', preventPickEvent, true);
    document.addEventListener('click', preventPickEvent, true);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (picking) stopPicking(true); else if (opened) { opened = false; updatePanel(); } } });
    document.addEventListener('pointerdown', e => {
      if (opened && host && !e.composedPath().includes(host)) { opened = false; updatePanel(); }
    }, true);
    window.addEventListener('pagehide', restoreAll);
    window.addEventListener('pageshow', scheduleScan);
    observer = new MutationObserver(muts => {
      if (muts.some(m => m.type === 'childList' || m.type === 'attributes' && !m.target.closest?.('#' + HOST_ID))) scheduleScan();
    });
    observer.observe(document.body, {subtree:true, childList:true, attributes:true, attributeFilter:['style','class','hidden','aria-label','title','src']});
    setInterval(scheduleScan, 2500);
    scan(); render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})();

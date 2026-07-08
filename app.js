/* ==========================================================================
   Daily Tracker — App Logic
   Pure vanilla JS. All state lives in localStorage under STORAGE_KEY.
   Data shape: { startedOn: "YYYY-MM-DD", relapses: ["YYYY-MM-DD", ...] }
   ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'dailyTrackerData_v1';
  var RING_CIRCUMFERENCE = 2 * Math.PI * 86; // matches r=86 in SVG

  // ---- module state -------------------------------------------------------
  var lastRenderedStreak = 0;
  var today = new Date();
  var currentViewYear = today.getFullYear();
  var currentViewMonth = today.getMonth(); // 0-indexed
  var confirmCallback = null;
  var toastTimer = null;

  // ==========================================================================
  // Date helpers — everything operates on local calendar days as "YYYY-MM-DD"
  // strings to avoid timezone drift.
  // ==========================================================================
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function toDateStr(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function todayStr() { return toDateStr(new Date()); }

  function parseDateStr(s) {
    var parts = s.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function daysBetween(aStr, bStr) {
    var a = parseDateStr(aStr), b = parseDateStr(bStr);
    return Math.round((b - a) / 86400000);
  }

  function addDaysStr(s, n) {
    var d = parseDateStr(s);
    d.setDate(d.getDate() + n);
    return toDateStr(d);
  }

  function getMondayOf(dateStr) {
    var d = parseDateStr(dateStr);
    var day = d.getDay(); // 0 Sun .. 6 Sat
    var diff = (day === 0) ? -6 : (1 - day);
    d.setDate(d.getDate() + diff);
    return toDateStr(d);
  }

  function formatDisplayDate(s) {
    var d = parseDateStr(s);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ==========================================================================
  // Persistence
  // ==========================================================================
  function isValidData(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.startedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.startedOn)) return false;
    if (!Array.isArray(obj.relapses)) return false;
    for (var i = 0; i < obj.relapses.length; i++) {
      if (typeof obj.relapses[i] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.relapses[i])) return false;
    }
    return true;
  }

  function loadData() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!isValidData(parsed)) return null;
      parsed.relapses = uniqSort(parsed.relapses);
      return parsed;
    } catch (e) { return null; }
  }

  function saveData(data) {
    data.relapses = uniqSort(data.relapses);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function uniqSort(arr) {
    var set = {};
    var out = [];
    for (var i = 0; i < arr.length; i++) { set[arr[i]] = true; }
    for (var k in set) { out.push(k); }
    out.sort();
    return out;
  }

  // ==========================================================================
  // Stats computation
  // ==========================================================================
  function computeStats(data) {
    var t = todayStr();
    var relapses = data.relapses.slice().sort();
    var prevBoundary = data.startedOn;
    var longest = 0;

    for (var i = 0; i < relapses.length; i++) {
      var r = relapses[i];
      var len = daysBetween(prevBoundary, r); // exclusive of relapse day itself
      if (len > longest) longest = len;
      prevBoundary = addDaysStr(r, 1);
    }

    var ongoingLen = daysBetween(prevBoundary, t) + 1;
    if (ongoingLen < 0) ongoingLen = 0;
    if (ongoingLen > longest) longest = ongoingLen;

    var streakSince = relapses.length ? relapses[relapses.length - 1] : data.startedOn;
    var totalDays = daysBetween(data.startedOn, t) + 1;
    var totalRelapses = relapses.length;
    var cleanDays = Math.max(0, totalDays - totalRelapses);
    var successRate = totalDays > 0 ? (cleanDays / totalDays) * 100 : 100;

    return {
      streakSince: streakSince,
      currentStreak: ongoingLen,
      longestStreak: longest,
      totalRelapses: totalRelapses,
      successRate: successRate,
      totalDays: totalDays
    };
  }

  // ==========================================================================
  // DOM helpers
  // ==========================================================================
  function $(id) { return document.getElementById(id); }

  function showToast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function shakeRing() {
    var svg = document.querySelector('.ring-svg');
    if (!svg) return;
    svg.classList.remove('shake');
    void svg.offsetWidth; // force reflow to restart animation
    svg.classList.add('shake');
    setTimeout(function () { svg.classList.remove('shake'); }, 450);
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function animateStreakNumber(target) {
    var el = $('streakNumber');
    var start = lastRenderedStreak;
    if (prefersReducedMotion() || start === target) {
      el.textContent = target;
      lastRenderedStreak = target;
      return;
    }
    var duration = 700;
    var startTime = null;
    function tick(now) {
      if (startTime === null) startTime = now;
      var p = Math.min(1, (now - startTime) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      var val = Math.round(start + (target - start) * eased);
      el.textContent = val;
      if (p < 1) {
        requestAnimationFrame(tick);
      } else {
        el.textContent = target;
        lastRenderedStreak = target;
      }
    }
    requestAnimationFrame(tick);
  }

  function updateRing(current, longest) {
    var fraction;
    if (longest > 0) fraction = Math.min(1, current / longest);
    else fraction = current > 0 ? 1 : 0;
    var offset = RING_CIRCUMFERENCE * (1 - fraction);
    var ring = $('ringProgress');
    ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    ring.style.strokeDashoffset = String(offset);
  }

  // ==========================================================================
  // Rendering
  // ==========================================================================
  function showOnboarding() {
    $('onboarding').classList.remove('hidden');
    $('dashboard').classList.add('hidden');
    $('actionBar').classList.add('hidden');
  }

  function showDashboardView() {
    $('onboarding').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    $('actionBar').classList.remove('hidden');
  }

  function renderWeek(data) {
    var container = $('weekGrid');
    container.innerHTML = '';
    var t = todayStr();
    var monday = getMondayOf(t);
    var relapseSet = {};
    data.relapses.forEach(function (r) { relapseSet[r] = true; });
    var letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

    for (var i = 0; i < 7; i++) {
      var dateStr = addDaysStr(monday, i);
      var box = document.createElement('div');
      box.className = 'day-box';
      box.style.animationDelay = (i * 0.04) + 's';

      var emoji = '';
      if (dateStr < data.startedOn) {
        // before the journey started — blank
      } else if (dateStr > t) {
        // future day — blank
      } else if (relapseSet[dateStr]) {
        emoji = '❌';
        box.classList.add('relapse');
      } else {
        emoji = '🔥';
        box.classList.add('clean');
      }
      if (dateStr === t) box.classList.add('is-today');

      var letterSpan = document.createElement('span');
      letterSpan.className = 'day-letter';
      letterSpan.textContent = letters[i];
      var emojiSpan = document.createElement('span');
      emojiSpan.className = 'day-emoji';
      emojiSpan.textContent = emoji;

      box.appendChild(letterSpan);
      box.appendChild(emojiSpan);
      container.appendChild(box);
    }
  }

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

  function renderMonth(data) {
    var label = new Date(currentViewYear, currentViewMonth, 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    $('monthLabel').textContent = label;

    var grid = $('monthGrid');
    grid.innerHTML = '';

    var firstDow = new Date(currentViewYear, currentViewMonth, 1).getDay(); // 0 Sun..6 Sat
    var offset = (firstDow === 0) ? 6 : (firstDow - 1);
    var total = daysInMonth(currentViewYear, currentViewMonth);
    var t = todayStr();
    var relapseSet = {};
    data.relapses.forEach(function (r) { relapseSet[r] = true; });

    for (var i = 0; i < offset; i++) {
      var empty = document.createElement('div');
      empty.className = 'month-cell';
      grid.appendChild(empty);
    }

    for (var day = 1; day <= total; day++) {
      var dateStr = currentViewYear + '-' + pad(currentViewMonth + 1) + '-' + pad(day);
      var cell = document.createElement('div');
      cell.className = 'month-cell in-month';
      cell.style.animationDelay = (day * 0.008) + 's';

      var emoji = '';
      if (dateStr < data.startedOn || dateStr > t) {
        // before journey started or in the future — blank
      } else if (relapseSet[dateStr]) {
        emoji = '❌';
        cell.classList.add('relapse');
      } else {
        emoji = '🔥';
        cell.classList.add('clean');
      }
      if (dateStr === t) cell.classList.add('is-today');

      var dateSpan = document.createElement('span');
      dateSpan.className = 'cell-date';
      dateSpan.textContent = String(day);
      var emojiSpan = document.createElement('span');
      emojiSpan.className = 'cell-emoji';
      emojiSpan.textContent = emoji;

      cell.appendChild(dateSpan);
      cell.appendChild(emojiSpan);
      grid.appendChild(cell);
    }

    updateMonthNavButtons(data);
  }

  function updateMonthNavButtons(data) {
    var start = parseDateStr(data.startedOn);
    var startY = start.getFullYear(), startM = start.getMonth();
    var now = new Date();
    var atStart = (currentViewYear < startY) || (currentViewYear === startY && currentViewMonth <= startM);
    var atEnd = (currentViewYear > now.getFullYear()) || (currentViewYear === now.getFullYear() && currentViewMonth >= now.getMonth());

    var prevBtn = $('prevMonthBtn'), nextBtn = $('nextMonthBtn');
    prevBtn.disabled = atStart;
    nextBtn.disabled = atEnd;
    prevBtn.style.opacity = atStart ? '0.3' : '1';
    nextBtn.style.opacity = atEnd ? '0.3' : '1';
  }

  function renderDashboard() {
    var data = loadData();
    if (!data) {
      showOnboarding();
      return;
    }
    showDashboardView();

    var stats = computeStats(data);

    $('startedOnValue').textContent = formatDisplayDate(data.startedOn);
    $('streakSinceDate').textContent = formatDisplayDate(stats.streakSince);
    $('longestStreakValue').textContent = stats.longestStreak + (stats.longestStreak === 1 ? ' day' : ' days');
    $('totalRelapsesValue').textContent = String(stats.totalRelapses);
    $('successRateValue').textContent = stats.successRate.toFixed(1) + '%';

    animateStreakNumber(stats.currentStreak);
    updateRing(stats.currentStreak, stats.longestStreak);

    renderWeek(data);
    renderMonth(data);
  }

  // ==========================================================================
  // Actions
  // ==========================================================================
  function startJourney() {
    var data = { startedOn: todayStr(), relapses: [] };
    saveData(data);
    renderDashboard();
    showToast('Journey started 🔥');
  }

  function recordRelapse() {
    var data = loadData();
    if (!data) return;
    var t = todayStr();
    var set = {};
    data.relapses.forEach(function (r) { set[r] = true; });
    set[t] = true;
    data.relapses = Object.keys(set).sort();
    saveData(data);
    renderDashboard();
    shakeRing();
    showToast('Logged. Tomorrow is a new day.');
  }

  function exportData() {
    var data = loadData();
    if (!data) return;
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'daily-tracker-backup-' + todayStr() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showToast('Backup exported');
  }

  function handleImportFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        showToast('That file is not valid JSON');
        return;
      }
      if (!isValidData(parsed)) {
        showToast('That backup file looks invalid');
        return;
      }
      openConfirm(
        'Import this backup?',
        'This will overwrite your current start date and relapse history with the contents of this file.',
        function () {
          saveData({ startedOn: parsed.startedOn, relapses: parsed.relapses });
          renderDashboard();
          showToast('Data imported');
        }
      );
    };
    reader.onerror = function () {
      showToast('Could not read that file');
    };
    reader.readAsText(file);
  }

  function fullReset() {
    localStorage.removeItem(STORAGE_KEY);
    lastRenderedStreak = 0;
    var now = new Date();
    currentViewYear = now.getFullYear();
    currentViewMonth = now.getMonth();
    renderDashboard();
    showToast('All data cleared');
  }

  // ==========================================================================
  // Sheet / Modal control
  // ==========================================================================
  function openSheet() { $('sheetOverlay').classList.remove('hidden'); }
  function closeSheet() { $('sheetOverlay').classList.add('hidden'); }

  function openConfirm(title, body, onConfirm) {
    $('confirmTitle').textContent = title;
    $('confirmBody').textContent = body;
    confirmCallback = onConfirm;
    $('confirmOverlay').classList.remove('hidden');
  }
  function closeConfirm() {
    $('confirmOverlay').classList.add('hidden');
    confirmCallback = null;
  }

  // ==========================================================================
  // Wiring
  // ==========================================================================
  function wireEvents() {
    $('startJourneyBtn').addEventListener('click', startJourney);

    $('goonedBtn').addEventListener('click', function () {
      openConfirm(
        'Record a relapse?',
        'This counts today as a relapse and resets your current streak. Your history is kept either way.',
        recordRelapse
      );
    });

    $('menuBtn').addEventListener('click', openSheet);
    $('closeSheetBtn').addEventListener('click', closeSheet);
    $('sheetOverlay').addEventListener('click', function (e) {
      if (e.target === $('sheetOverlay')) closeSheet();
    });

    $('exportBtn').addEventListener('click', function () {
      closeSheet();
      exportData();
    });

    $('importBtn').addEventListener('click', function () {
      closeSheet();
      $('importFileInput').click();
    });
    $('importFileInput').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) handleImportFile(file);
      e.target.value = '';
    });

    $('resetBtn').addEventListener('click', function () {
      closeSheet();
      openConfirm(
        'Full reset?',
        'This permanently deletes your start date and all relapse history from this device. This cannot be undone.',
        fullReset
      );
    });

    $('confirmCancelBtn').addEventListener('click', closeConfirm);
    $('confirmOkBtn').addEventListener('click', function () {
      var cb = confirmCallback;
      closeConfirm();
      if (cb) cb();
    });
    $('confirmOverlay').addEventListener('click', function (e) {
      if (e.target === $('confirmOverlay')) closeConfirm();
    });

    $('prevMonthBtn').addEventListener('click', function () {
      if ($('prevMonthBtn').disabled) return;
      currentViewMonth--;
      if (currentViewMonth < 0) { currentViewMonth = 11; currentViewYear--; }
      var data = loadData();
      if (data) renderMonth(data);
    });
    $('nextMonthBtn').addEventListener('click', function () {
      if ($('nextMonthBtn').disabled) return;
      currentViewMonth++;
      if (currentViewMonth > 11) { currentViewMonth = 0; currentViewYear++; }
      var data = loadData();
      if (data) renderMonth(data);
    });
  }

  // ==========================================================================
  // Service worker
  // ==========================================================================
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('service-worker.js').catch(function () { /* offline-first, ignore */ });
      });
    }
  }

  // ==========================================================================
  // Init
  // ==========================================================================
  function init() {
    wireEvents();
    renderDashboard();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

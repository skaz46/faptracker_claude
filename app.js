/* ==========================================================================
   Daily Tracker — App Logic
   Pure vanilla JS. All state lives in localStorage under STORAGE_KEY.
   Data shape (v2): { startedOn: "YYYY-MM-DD", counts: { "YYYY-MM-DD": n } }
   Legacy shape { startedOn, relapses: [dates] } is migrated automatically.
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
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // Accepts v2 ({counts}) or legacy ({relapses:[...]}); returns clean v2 or null.
  function normalize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.startedOn !== 'string' || !DATE_RE.test(obj.startedOn)) return null;
    var counts = {};
    if (Array.isArray(obj.relapses)) {
      for (var i = 0; i < obj.relapses.length; i++) {
        var r = obj.relapses[i];
        if (typeof r !== 'string' || !DATE_RE.test(r)) return null;
        counts[r] = (counts[r] || 0) + 1;
      }
    } else if (obj.counts && typeof obj.counts === 'object') {
      for (var k in obj.counts) {
        var n = Number(obj.counts[k]);
        if (!DATE_RE.test(k) || !isFinite(n) || n < 0) return null;
        n = Math.floor(n);
        if (n > 0) counts[k] = n;
      }
    } else return null;
    return { startedOn: obj.startedOn, counts: counts };
  }
  function isValidData(obj) { return normalize(obj) !== null; }

  function loadData() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try { return normalize(JSON.parse(raw)); } catch (e) { return null; }
  }

  function saveData(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ startedOn: data.startedOn, counts: data.counts }));
  }

  function relapseDays(data) { return Object.keys(data.counts).sort(); }
  function countOn(data, d) { return data.counts[d] || 0; }

  // ==========================================================================
  // Stats computation
  // ==========================================================================
  function computeStats(data) {
    var t = todayStr();
    var relapses = relapseDays(data);
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
    var totalRelapses = 0, worstDate = null, worstN = 0;
    relapses.forEach(function (d) {
      var n = data.counts[d];
      totalRelapses += n;
      if (n > worstN) { worstN = n; worstDate = d; }
    });
    var relapseDayCount = relapses.length;
    var cleanDays = Math.max(0, totalDays - relapseDayCount);
    var weekStart = addDaysStr(t, -6), prevStart = addDaysStr(t, -13), prevEnd = addDaysStr(t, -7);
    var last7 = 0, prev7 = 0;
    relapses.forEach(function (d) {
      if (d >= weekStart && d <= t) last7 += data.counts[d];
      else if (d >= prevStart && d <= prevEnd) prev7 += data.counts[d];
    });
    var successRate = totalDays > 0 ? (cleanDays / totalDays) * 100 : 100;

    return {
      streakSince: streakSince,
      currentStreak: ongoingLen,
      longestStreak: longest,
      totalRelapses: totalRelapses,
      successRate: successRate,
      totalDays: totalDays,
      relapseDayCount: relapseDayCount,
      avgPerRelapseDay: relapseDayCount ? totalRelapses / relapseDayCount : 0,
      worstDate: worstDate, worstN: worstN,
      last7: last7, prev7: prev7
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

  function heatClass(n) { return n >= 3 ? 'heat-3' : (n === 2 ? 'heat-2' : 'heat-1'); }

  // Fills one calendar cell (week box or month cell) based on the day's state.
  function paintDay(el, emojiSpan, data, dateStr, t) {
    var n = countOn(data, dateStr);
    if (dateStr < data.startedOn || dateStr > t) return;
    if (n > 0) {
      emojiSpan.textContent = '\u274C';
      el.classList.add('relapse', heatClass(n));
      if (n > 1) {
        var b = document.createElement('span');
        b.className = 'count-badge';
        b.textContent = '\u00D7' + n;
        el.appendChild(b);
      }
    } else {
      emojiSpan.textContent = '\uD83D\uDD25';
      el.classList.add('clean');
    }
  }

  function renderWeek(data) {
    var container = $('weekGrid');
    container.innerHTML = '';
    var t = todayStr();
    var monday = getMondayOf(t);
    var letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    for (var i = 0; i < 7; i++) {
      var dateStr = addDaysStr(monday, i);
      var box = document.createElement('div');
      box.className = 'day-box';
      box.style.animationDelay = (i * 0.04) + 's';
      var letterSpan = document.createElement('span');
      letterSpan.className = 'day-letter';
      letterSpan.textContent = letters[i];
      var emojiSpan = document.createElement('span');
      emojiSpan.className = 'day-emoji';
      box.appendChild(letterSpan);
      box.appendChild(emojiSpan);
      paintDay(box, emojiSpan, data, dateStr, t);
      if (dateStr === t) box.classList.add('is-today');
      container.appendChild(box);
    }
  }

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

  function renderMonth(data) {
    $('monthLabel').textContent = new Date(currentViewYear, currentViewMonth, 1)
      .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    var grid = $('monthGrid');
    grid.innerHTML = '';
    var firstDow = new Date(currentViewYear, currentViewMonth, 1).getDay();
    var offset = (firstDow === 0) ? 6 : (firstDow - 1);
    var total = daysInMonth(currentViewYear, currentViewMonth);
    var t = todayStr();
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
      var dateSpan = document.createElement('span');
      dateSpan.className = 'cell-date';
      dateSpan.textContent = String(day);
      var emojiSpan = document.createElement('span');
      emojiSpan.className = 'cell-emoji';
      cell.appendChild(dateSpan);
      cell.appendChild(emojiSpan);
      paintDay(cell, emojiSpan, data, dateStr, t);
      if (dateStr === t) cell.classList.add('is-today');
      if (dateStr >= data.startedOn && dateStr <= t) {
        cell.classList.add('tappable');
        cell.setAttribute('data-date', dateStr);
      }
      grid.appendChild(cell);
    }
    updateMonthNavButtons(data);
  }

  // ---- Insights: charts + numbers -----------------------------------------
  function barChart(vals, labels, w, h) {
    var max = Math.max.apply(null, vals.concat([1]));
    var gap = 3, bw = (w - gap * (vals.length - 1)) / vals.length, base = h - 16, s = '';
    s += '<svg viewBox="0 0 ' + w + ' ' + h + '" class="chart-svg" role="img">';
    s += '<defs><linearGradient id="barGrad" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#FF453A"/><stop offset="100%" stop-color="#FF9500"/></linearGradient></defs>';
    vals.forEach(function (v, i) {
      var x = i * (bw + gap), bh = v ? Math.max(4, (v / max) * (base - 12)) : 0;
      if (v) {
        s += '<rect x="' + x.toFixed(1) + '" y="' + (base - bh).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="3" fill="url(#barGrad)"/>';
        if (vals.length <= 12) s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (base - bh - 3).toFixed(1) + '" class="chart-val" text-anchor="middle">' + v + '</text>';
      } else {
        s += '<rect x="' + x.toFixed(1) + '" y="' + (base - 2) + '" width="' + bw.toFixed(1) + '" height="2" rx="1" fill="rgba(48,209,88,0.55)"/>';
      }
      if (labels[i]) s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - 3) + '" class="chart-lbl" text-anchor="middle">' + labels[i] + '</text>';
    });
    return s + '</svg>';
  }

  function renderInsights(data, stats) {
    var t = todayStr();
    // last 30 days (clamped to journey start)
    var vals = [], labels = [], i, d;
    for (i = 29; i >= 0; i--) {
      d = addDaysStr(t, -i);
      vals.push(d < data.startedOn ? 0 : countOn(data, d));
      labels.push(i === 29 || i === 0 || i === 15 ? String(parseDateStr(d).getDate()) : '');
    }
    $('trendChart').innerHTML = barChart(vals, labels, 300, 100);

    // weekday pattern (Mon..Sun), all-time
    var wd = [0, 0, 0, 0, 0, 0, 0];
    relapseDays(data).forEach(function (r) { wd[(parseDateStr(r).getDay() + 6) % 7] += data.counts[r]; });
    $('weekdayChart').innerHTML = barChart(wd, ['M', 'T', 'W', 'T', 'F', 'S', 'S'], 300, 90);

    $('insDays').textContent = stats.relapseDayCount + (stats.relapseDayCount === 1 ? ' day' : ' days');
    $('insAvg').textContent = stats.relapseDayCount ? stats.avgPerRelapseDay.toFixed(1) + ' / day' : '\u2014';
    $('insWorst').textContent = stats.worstN ? stats.worstN + '\u00D7 \u00B7 ' + formatDisplayDate(stats.worstDate).replace(/, \d{4}$/, '') : '\u2014';
    var delta = stats.last7 - stats.prev7, el = $('insWeek');
    el.textContent = stats.last7 + ' vs ' + stats.prev7 + (delta < 0 ? ' \u2193' : (delta > 0 ? ' \u2191' : ' ='));
    el.className = 'ins-value ' + (delta < 0 ? 'good' : (delta > 0 ? 'bad' : ''));
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
    renderInsights(data, stats);

    var tc = countOn(data, todayStr());
    $('goonedBtn').textContent = 'Gooned \uD83E\uDD40' + (tc ? '  \u00B7  ' + tc + ' today' : '');
  }

  // ==========================================================================
  // Actions
  // ==========================================================================
  function startJourney() {
    var data = { startedOn: todayStr(), counts: {} };
    saveData(data);
    renderDashboard();
    showToast('Journey started 🔥');
  }

  function recordRelapse() {
    var data = loadData();
    if (!data) return;
    var t = todayStr();
    data.counts[t] = (data.counts[t] || 0) + 1;
    saveData(data);
    renderDashboard();
    shakeRing();
    showToast(data.counts[t] > 1 ? 'Logged \u00B7 ' + data.counts[t] + ' today. Tomorrow is a new day.' : 'Logged. Tomorrow is a new day.');
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
          saveData(normalize(parsed));
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
  // Day editor (tap a calendar day to fix / backfill its count)
  // ==========================================================================
  var editingDate = null;
  function openDayEditor(dateStr) {
    editingDate = dateStr;
    refreshDayEditor();
    $('dayOverlay').classList.remove('hidden');
  }
  function refreshDayEditor() {
    var data = loadData();
    if (!data || !editingDate) return;
    $('dayTitle').textContent = formatDisplayDate(editingDate);
    $('dayCount').textContent = String(countOn(data, editingDate));
  }
  function adjustDay(delta) {
    var data = loadData();
    if (!data || !editingDate) return;
    var n = Math.max(0, Math.min(99, countOn(data, editingDate) + delta));
    if (n) data.counts[editingDate] = n; else delete data.counts[editingDate];
    saveData(data);
    refreshDayEditor();
    renderDashboard();
  }
  function closeDayEditor() { $('dayOverlay').classList.add('hidden'); editingDate = null; }

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
        'This adds one relapse to today and resets your current streak. Your history is kept either way.',
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

    $('monthGrid').addEventListener('click', function (e) {
      var cell = e.target.closest ? e.target.closest('.month-cell[data-date]') : null;
      if (cell) openDayEditor(cell.getAttribute('data-date'));
    });
    $('dayMinus').addEventListener('click', function () { adjustDay(-1); });
    $('dayPlus').addEventListener('click', function () { adjustDay(1); });
    $('dayDoneBtn').addEventListener('click', closeDayEditor);
    $('dayOverlay').addEventListener('click', function (e) { if (e.target === $('dayOverlay')) closeDayEditor(); });

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

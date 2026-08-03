/* Jukugo - offline Japanese vocabulary game (see SPEC.md).
 * One linear path per word: r_learning -> r_learned -> r_mastered ->
 * w_learning -> w_learned -> w_mastered. A single shared state map is the source
 * of truth; two "Ball" views (reading/writing) derive per-phase sets and kanji
 * connectivity. Rounds = 2 retention + 1 acquisition; localStorage persistence.
 * Vanilla JS, classic script (works from file:// on Android Chrome). */
(function () {
  "use strict";

  var VERSION = "2026-08-03.6";   // bump on each change; shown in UI + console
  var D = window.__BALL_DATA__;
  if (!D) { document.body.innerHTML = "<p style='padding:2rem'>data.js failed to load.</p>"; return; }

  var WORDS = D.words;                 // [{s,r,e,f,k,c,l}]
  var KORDER = D.kanjiOrder;           // {kanji: app_order}
  var SEED = D.seed;                   // index of 一/いち
  var N = WORDS.length;
  var NON_JOYO = 100000;
  var INF = Infinity;
  // Learning-pool cap per phase (settings.poolTargetRead / *Write): how many
  // words you can be actively learning at once before they reach the learned
  // level. New words are introduced only while the pool is below this cap.
  var POOL_TARGET_DEFAULT = 8;
  var POOL_MIN = 4, POOL_MAX = 200;
  function poolTarget(reading) {
    var n = (reading ? settings.poolTargetRead : settings.poolTargetWrite) | 0;
    if (!n) n = POOL_TARGET_DEFAULT;
    return Math.max(POOL_MIN, Math.min(POOL_MAX, n));
  }
  // Minimum spacing before a learning word is shown again: a word not seen for
  // this long is "due" and reviewed before any new word. User-configurable
  // (Settings), default 3h.
  var ACQUIRE_GAP_DEFAULT_H = 3, ACQUIRE_GAP_MIN_H = 1, ACQUIRE_GAP_MAX_H = 48;
  function acquireGapHours() {
    var hh = settings.acquireGapHours;
    if (hh == null) hh = ACQUIRE_GAP_DEFAULT_H;
    return Math.max(ACQUIRE_GAP_MIN_H, Math.min(ACQUIRE_GAP_MAX_H, hh | 0));
  }
  var MAX_LEVEL = 8;   // recomputed from data below
  var RETENTION_COOLDOWN_MS = 24 * 60 * 60 * 1000; // don't re-review a word within 24h
  // Words with BCCWJ rank worse than this (or unranked) are "rare": they are
  // deferred in selection (§8 Phase C) until all common words of the currently
  // unlocked kanji are done, so rare idioms don't appear early. [decision]
  var RARE_RANK = 30000;

  // --- per-word derived fields + level histogram ---------------------------
  var levelCount = {};                 // level -> count
  for (var i = 0; i < N; i++) {
    var w = WORDS[i];
    w._k = Array.from(w.s ? w.k : "");           // kanji as array (cache)
    w._rank = (w.c == null) ? INF : w.c;         // unranked -> Infinity
    w._klen = w.s.length;
    levelCount[w.l] = (levelCount[w.l] || 0) + 1;
    if (w.l > MAX_LEVEL) MAX_LEVEL = w.l;
  }
  function appKey(kc) { return KORDER.hasOwnProperty(kc) ? KORDER[kc] : NON_JOYO; }

  // ------------------------------------------------------------------ engine
  // Every word follows ONE linear path (kanji_ball_game.md §7):
  //   r_learning -> r_learned -> r_mastered -> w_learning -> w_learned -> w_mastered
  // (reading acquisition/review/mastery, then the same for writing). There is a
  // single shared `states` map (the source of truth) plus a shared `lastQuiz`
  // map. A Ball is just a phase VIEW over that state: the "reading" view drives
  // recognition, the "writing" view drives production. This keeps storage to one
  // state per word and means writing needs no kanji-introduction machinery of
  // its own — its candidates are simply the words already mastered in reading.
  var R_LEARNING = "r_learning", R_LEARNED = "r_learned", R_MASTERED = "r_mastered";
  var W_LEARNING = "w_learning", W_LEARNED = "w_learned", W_MASTERED = "w_mastered";
  var states = new Map();   // idx -> one of the six states above (source of truth)
  var lastQuiz = new Map(); // idx -> lastQuizzedAt ms (a word is active in one phase)

  // A Ball holds the derived, per-phase view (sets + kanji connectivity + size).
  function Ball(phase) {
    this.reading = (phase === "reading");
    this.S = this.reading
      ? { LEARNING: R_LEARNING, LEARNED: R_LEARNED, MASTERED: R_MASTERED }
      : { LEARNING: W_LEARNING, LEARNED: W_LEARNED, MASTERED: W_MASTERED };
    this.learning = new Set();
    this.learned = new Set();
    this.mastered = new Set();
    this.count = new Map();            // kanji -> # ball words containing it
    this.last = lastQuiz;              // shared last-quizzed map
    this.unlocked = 1;                 // reading only; writing inherits the curriculum
    this.ballSize = 0;                 // internal only (drives reading unlock); not shown
  }
  // A word counts as "in the reading ball" (mastered for reading purposes) once
  // it reaches r_mastered, and it STAYS in the ball through every writing state.
  function isReadingBall(st) {
    return st === R_LEARNED || st === R_MASTERED ||
           st === W_LEARNING || st === W_LEARNED || st === W_MASTERED;
  }
  Ball.prototype.incKanji = function (w, d) {
    for (var i = 0; i < w._k.length; i++) {
      var kc = w._k[i]; this.count.set(kc, (this.count.get(kc) || 0) + d);
    }
  };
  // grade transitions (idx currently in this phase's learning pool or ball)
  Ball.prototype.enterBall = function (idx, target) { // target: 'learned'|'mastered'
    var w = WORDS[idx], cur = states.get(idx);
    if (cur === this.S.LEARNING) this.learning.delete(idx);
    if (cur !== this.S.LEARNED && cur !== this.S.MASTERED) { this.incKanji(w, +1); this.ballSize++; }
    this.learned.delete(idx); this.mastered.delete(idx);
    var val = (target === "mastered") ? this.S.MASTERED : this.S.LEARNED;
    states.set(idx, val);
    (target === "mastered" ? this.mastered : this.learned).add(idx);
  };
  Ball.prototype.toLearning = function (idx) {
    var w = WORDS[idx], cur = states.get(idx);
    var wasInBall = (cur === this.S.LEARNED || cur === this.S.MASTERED);
    if (wasInBall) { this.incKanji(w, -1); this.ballSize--; }
    this.learned.delete(idx); this.mastered.delete(idx);
    states.set(idx, this.S.LEARNING); this.learning.add(idx);
  };
  Ball.prototype.addLearning = function (idx) { // enter this phase's learning pool
    states.set(idx, this.S.LEARNING); this.learning.add(idx); lastQuiz.set(idx, 0);
  };
  // Shrink the learning pool to `target` by returning surplus words to the pool
  // they came from: reading -> `none` (re-pickable by priority), writing ->
  // `r_mastered` (re-pickable as a writing candidate). Evict the HARDEST words
  // first — highest difficulty level, then rarest — so easier, more common words
  // keep flowing and sticky hard cards don't clog the pool. Ball size / kanji
  // counts are unaffected (only learning-pool words are touched).
  Ball.prototype.trimLearning = function (target) {
    if (this.learning.size <= target) return 0;
    var order = 0, arr = [];
    this.learning.forEach(function (idx) { arr.push({ idx: idx, order: order++ }); });
    arr.sort(function (a, b) {
      // evict not-yet-quizzed "filler" first (it's just unused capacity under the
      // cap); only quizzed words are dropped if the pool is STILL over target.
      var aq = ((lastQuiz.get(a.idx) || 0) !== 0) ? 1 : 0;
      var bq = ((lastQuiz.get(b.idx) || 0) !== 0) ? 1 : 0;
      if (aq !== bq) return aq - bq;                     // unquizzed first
      var wa = WORDS[a.idx], wb = WORDS[b.idx];
      if (wa.l !== wb.l) return wb.l - wa.l;            // then hardest level first
      if (wa._rank !== wb._rank) return wb._rank - wa._rank; // then rarest first
      return b.order - a.order;                          // then newest-added first
    });
    var remove = this.learning.size - target;
    for (var j = 0; j < remove; j++) {
      var idx = arr[j].idx;
      this.learning.delete(idx);
      if (this.reading) { states.delete(idx); lastQuiz.delete(idx); }
      else { states.set(idx, R_MASTERED); lastQuiz.set(idx, 0); }  // back to candidate
    }
    return remove;
  };

  // Priority pick over the `none` pool within unlocked levels (§8).
  //   Phase A = consolidate a COMMON word (no new kanji, rank <= RARE_RANK)
  //   Phase B = introduce a new kanji
  //   Phase C = consolidate a RARE word (no new kanji, rank > RARE_RANK)
  // Preference A > B > C, so rare words (Phase C) are deferred until all common
  // consolidation and all new-kanji introductions in the unlocked set are done.
  Ball.prototype.pickNextWord = function () {
    var A = null, Akey = null, B = null, Bkey = null, C = null, Ckey = null;
    // kanji already in-flight (in the learning pool) count as "not new", so we
    // don't treat rare repeated-kanji words (e.g. 一一) as fresh introductions.
    var poolKanji = new Set();
    this.learning.forEach(function (li) {
      var kk = WORDS[li]._k; for (var m = 0; m < kk.length; m++) poolKanji.add(kk[m]);
    });
    for (var idx = 0; idx < N; idx++) {
      if (states.has(idx)) continue;          // already started somewhere on the path
      var w = WORDS[idx];
      if (w.l > this.unlocked) continue;
      var conn = 0, newk = 0, minIntro = NON_JOYO * 10;
      for (var j = 0; j < w._k.length; j++) {
        var kc = w._k[j], c = this.count.get(kc) || 0;
        if (c >= 2) conn++;
        if (c === 0 && !poolKanji.has(kc)) { newk++; var ak = appKey(kc); if (ak < minIntro) minIntro = ak; }
      }
      if (newk === 0) {
        var consKey = [w._k.length, w._rank, w._klen, -conn, idx];
        if (w._rank <= RARE_RANK) {           // Phase A (common consolidate)
          if (Akey === null || less(consKey, Akey)) { Akey = consKey; A = idx; }
        } else {                              // Phase C (rare consolidate)
          if (Ckey === null || less(consKey, Ckey)) { Ckey = consKey; C = idx; }
        }
      } else {                               // Phase B (introduce new kanji)
        var kb = [newk, w._k.length, minIntro, -conn, w._rank, idx];
        if (Bkey === null || less(kb, Bkey)) { Bkey = kb; B = idx; }
      }
    }
    return A !== null ? A : (B !== null ? B : C);
  };

  Ball.prototype.maybeUnlock = function () {
    while (this.unlocked < MAX_LEVEL) {
      var lvl = this.unlocked, inBall = 0;
      // count ball words at this level
      var self = this;
      var countBall = function (set) { set.forEach(function (i) { if (WORDS[i].l === lvl) inBall++; }); };
      countBall(this.learned); countBall(this.mastered);
      var covered = inBall >= 0.8 * (levelCount[lvl] || 0);
      // "common pool empty" = no un-started word in unlocked levels that is
      // either introducing a new kanji or is a common (non-rare) consolidation.
      // Rare (Phase C) words are ignored here so they don't block progression.
      var commonLeft = false;
      for (var idx = 0; idx < N; idx++) {
        if (states.has(idx)) continue;
        var w = WORDS[idx];
        if (w.l > this.unlocked) continue;
        if (w._rank <= RARE_RANK) { commonLeft = true; break; }
        for (var j = 0; j < w._k.length; j++) { if ((this.count.get(w._k[j]) || 0) === 0) { commonLeft = true; break; } }
        if (commonLeft) break;
      }
      if (covered) this.unlocked++;
      else if (!commonLeft && this.ballSize > 0) this.unlocked++;
      else break;
    }
  };

  // Writing candidates = words mastered in reading (state r_mastered) that have
  // not yet entered the writing path. Ordered oldest-mastered first (lastQuiz was
  // set to the mastery time when the word reached r_mastered and is untouched
  // until it enters writing).
  Ball.prototype.writingCandidates = function () {
    var cands = [];
    states.forEach(function (st, idx) { if (st === R_MASTERED) cands.push(idx); });
    cands.sort(function (a, b) { return (lastQuiz.get(a) || 0) - (lastQuiz.get(b) || 0); });
    return cands;
  };

  Ball.prototype.nextWritingCandidate = function () {
    var c = this.writingCandidates();
    return c.length ? c[0] : null;
  };

  // Choose the acquisition-slot word. The learning pool holds ONLY words that
  // have actually been quizzed (no pre-filled buffer). A learning word is "due"
  // once it hasn't been seen for at least the spacing gap (acquireGapHours).
  // Priority:
  //   1) re-drill the most-overdue DUE learning word (before any new word);
  //   2) else, if below the cap, introduce a brand-new word;
  //   3) else (pool full, nothing due), review the oldest learning word.
  Ball.prototype.chooseAcquire = function () {
    if (this.reading) this.maybeUnlock();
    var target = poolTarget(this.reading), self = this;
    var oldest = null, oldestT = INF, size = 0;
    this.learning.forEach(function (idx) {
      size++;
      var t = self.last.get(idx) || 0;
      if (t < oldestT) { oldestT = t; oldest = idx; }
    });
    // 1) a learning word overdue by >= the spacing gap: review it first
    if (oldest != null && (Date.now() - oldestT) >= acquireGapHours() * 3600000) return oldest;
    // 2) nothing due and room under the cap: introduce a new word
    if (size < target) {
      var nw = this.reading ? this.pickNextWord() : this.nextWritingCandidate();
      if (nw != null) { this.addLearning(nw); return nw; }
    }
    // 3) pool full (or no new word available): review the oldest learning word
    if (oldest != null) return oldest;
    // 4) empty pool, nothing to review: introduce whatever is next, if any
    var nw2 = this.reading ? this.pickNextWord() : this.nextWritingCandidate();
    if (nw2 != null) { this.addLearning(nw2); return nw2; }
    return null;
  };

  Ball.prototype.rebuildDerived = function () {
    this.learning.clear(); this.learned.clear(); this.mastered.clear();
    this.count.clear(); this.ballSize = 0;
    var self = this;
    states.forEach(function (st, idx) {
      if (self.reading) {
        if (st === R_LEARNING) self.learning.add(idx);
        else if (st === R_LEARNED) { self.learned.add(idx); self.ballSize++; self.incKanji(WORDS[idx], +1); }
        else if (isReadingBall(st) && st !== R_LEARNED) {   // r_mastered or any w_*
          self.mastered.add(idx); self.ballSize++; self.incKanji(WORDS[idx], +1);
        }
      } else {
        if (st === W_LEARNING) self.learning.add(idx);
        else if (st === W_LEARNED) { self.learned.add(idx); self.ballSize++; self.incKanji(WORDS[idx], +1); }
        else if (st === W_MASTERED) { self.mastered.add(idx); self.ballSize++; self.incKanji(WORDS[idx], +1); }
        // r_mastered = writing candidate, not yet in the writing ball
      }
    });
  };

  Ball.prototype.initIfEmpty = function () {
    if (this.reading && this.ballSize === 0 && this.learning.size === 0) {
      this.addLearning(SEED);          // seed 一 first (\u00a78 bootstrap)
      lastQuiz.set(SEED, -1);          // present before all others (as a new word)
    }
    // writing needs no seeding: chooseAcquire pulls read-mastered candidates.
  };

  // 2 distinct random learned (not mastered) words, excluding a set.
  // Skip any word quizzed within the last 24h (§10 cooldown) so the early game
  // doesn't keep re-asking the same freshly-learned words.
  Ball.prototype.pickRetention = function (exclude) {
    var pool = [], now = Date.now(), self = this;
    this.learned.forEach(function (i) {
      if (exclude.has(i)) return;
      var t = self.last.has(i) ? self.last.get(i) : 0;
      if (now - t >= RETENTION_COOLDOWN_MS) pool.push(i);
    });
    if (!pool.length) return null;
    return pool[(Math.random() * pool.length) | 0];
  };

  function less(a, b) { for (var i = 0; i < a.length; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; } return false; }
  function ymdOf(t) { var d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  // ----------------------------------------------------------- persistence
  var KEY = "ballGame.v1";
  var settings = { showFinnish: true, poolTargetRead: POOL_TARGET_DEFAULT, poolTargetWrite: POOL_TARGET_DEFAULT, acquireGapHours: ACQUIRE_GAP_DEFAULT_H };
  // Single progress structure: end-of-day snapshot of each stage's count.
  var progress = { dailyStages: {} };   // { 'YYYY-MM-DD': {rl,rd,rm,wl,wd,wm} }
  var unlockedLevel = 1;                 // reading curriculum level (writing has none)
  var balls = { recognition: new Ball("reading"), production: new Ball("writing") };
  var activeMode = "recognition";

  function migrateSettings() {
    if (settings.poolTargetRead == null)
      settings.poolTargetRead = settings.poolTarget || POOL_TARGET_DEFAULT;
    if (settings.poolTargetWrite == null)
      settings.poolTargetWrite = settings.poolTarget || POOL_TARGET_DEFAULT;
    if (settings.acquireGapHours == null)
      settings.acquireGapHours = ACQUIRE_GAP_DEFAULT_H;
    delete settings.poolTarget;
  }
  function rebuildAll() {
    balls.recognition.unlocked = unlockedLevel;
    balls.recognition.rebuildDerived();
    balls.production.rebuildDerived();
  }

  function load() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (!raw) return false;
    activeMode = raw.activeMode || "recognition";
    if (raw.settings) settings = raw.settings;
    migrateSettings();
    states.clear(); lastQuiz.clear();
    if (raw.schemaVersion >= 3 && raw.states) {
      for (var idx in raw.states) states.set(+idx, raw.states[idx]);
      if (raw.lastQuizzedAt) for (var k in raw.lastQuizzedAt) lastQuiz.set(+k, raw.lastQuizzedAt[k]);
      unlockedLevel = raw.unlockedLevel || 1;
      progress = raw.progress && raw.progress.dailyStages ? raw.progress : { dailyStages: {} };
    } else if (raw.schemaVersion >= 2 && raw.states) {
      for (var idx2 in raw.states) states.set(+idx2, raw.states[idx2]);
      if (raw.lastQuizzedAt) for (var k2 in raw.lastQuizzedAt) lastQuiz.set(+k2, raw.lastQuizzedAt[k2]);
      unlockedLevel = (raw.reading && raw.reading.unlockedLevel) || 1;
      progress = { dailyStages: {} };    // old ball-size curve is dropped
    } else if (raw.modes) {
      migrateV1(raw);
    } else {
      return false;
    }
    rebuildAll();
    return true;
  }

  // Fold the old two-ball save (schema 1: independent recognition/production
  // states) into the single linear path. Any writing progress implies reading
  // mastery, so a production state maps straight onto the writing segment.
  function migrateV1(raw) {
    var rec = (raw.modes.recognition || {}), pro = (raw.modes.production || {});
    var rs = rec.states || {}, ps = pro.states || {};
    var rlast = rec.lastQuizzedAt || {}, plast = pro.lastQuizzedAt || {};
    var seen = {};
    function put(idx) {
      if (seen[idx]) return; seen[idx] = 1;
      var p = ps[idx], r = rs[idx], st, t;
      if (p === "mastered") { st = W_MASTERED; }
      else if (p === "learned") { st = W_LEARNED; }
      else if (p === "learning") { st = W_LEARNING; }
      else if (r === "mastered") { st = R_MASTERED; }
      else if (r === "learned") { st = R_LEARNED; }
      else if (r === "learning") { st = R_LEARNING; }
      else return;                         // no progress on this word
      states.set(+idx, st);
      t = (p != null && plast[idx] != null) ? plast[idx] : rlast[idx];
      if (t != null) lastQuiz.set(+idx, t);
    }
    for (var a in rs) put(a);
    for (var b in ps) put(b);
    unlockedLevel = rec.unlockedLevel || 1;
    progress = { dailyStages: {} };
  }

  function save() {
    var st = {}, last = {};
    states.forEach(function (s, idx) { st[idx] = s; });
    lastQuiz.forEach(function (t, idx) { if (states.has(idx)) last[idx] = t; });
    var out = {
      schemaVersion: 3, activeMode: activeMode, settings: settings,
      states: st, lastQuizzedAt: last,
      unlockedLevel: balls.recognition.unlocked, progress: progress
    };
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch (e) {}
  }

  function ball() { return balls[activeMode]; }

  // ------------------------------------------------------------------- rounds
  // A round = 2 retention + 1 acquisition. We present one card at a time.
  var queue = [];            // pending cards this round: {idx, kind}

  function buildRound() {
    var b = ball();
    b.maybeUnlock();
    queue = [];
    var roundExclude = new Set();
    for (var i = 0; i < 2; i++) {
      var r = b.pickRetention(roundExclude);
      if (r == null) break;
      roundExclude.add(r);
      queue.push({ idx: r, kind: "retention" });
    }
    var a = b.chooseAcquire();
    if (a != null) {
      // "new word" = presented for the very first time (never graded yet).
      var isNew = (b.last.get(a) || 0) <= 0;
      queue.push({ idx: a, kind: "acquisition", isNew: isNew });
    }
  }

  function nextCard() {
    if (!queue.length) buildRound();
    if (!queue.length) return null;    // nothing to do (shouldn't happen)
    return queue.shift();
  }

  function grade(card, g) {            // g: 'know'|'good'|'hard'
    var b = ball(), idx = card.idx;
    if (g === "know") b.enterBall(idx, "mastered");
    else if (g === "good") b.enterBall(idx, "learned");
    else b.toLearning(idx);            // hard
    b.last.set(idx, Date.now());
    recordDailyStages();               // snapshot per-stage counts for the curve
    save();
  }

  // ------------------------------------------------------------------- UI
  var current = null, step = 0;   // reveal step: recognition 0..1, production 0..2

  function $(id) { return document.getElementById(id); }
  function h(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  function render() {
    renderHud();
    var view = $("view");
    if (currentTab === "progress") { renderProgress(view); return; }
    renderCard(view);
  }

  // Simple counts of words at each stage of the single linear path (§6). Shown
  // identically in both views. mastered_reading folds in learning_writing, so the
  // five buckets partition every started word:
  //   learning_reading | learned_reading | mastered_reading(+learning_writing)
  //   | learned_writing | mastered_writing
  function stageCounts() {
    var c = { rl: 0, rd: 0, rm: 0, wl: 0, wd: 0, wm: 0 };
    states.forEach(function (st, idx) {
      // "read learning" = words in the reading pool that have actually been
      // quizzed at least once. Unqueried pool words (lastQuiz === 0) are just
      // capacity under the max cap and shouldn't inflate the count.
      if (st === R_LEARNING) { if ((lastQuiz.get(idx) || 0) !== 0) c.rl++; }
      else if (st === R_LEARNED) c.rd++;
      else if (st === R_MASTERED) c.rm++;
      else if (st === W_LEARNING) c.wl++;
      else if (st === W_LEARNED) c.wd++;
      else if (st === W_MASTERED) c.wm++;
    });
    return c;
  }

  function renderHud() {
    var c = stageCounts();
    $("sRL").textContent = c.rl;
    $("sRD").textContent = c.rd;
    $("sRM").textContent = c.rm + c.wl;   // mastered reading, pending writing
    $("sWD").textContent = c.wd;
    $("sWM").textContent = c.wm;
    var prog = currentTab === "progress";
    $("modeRead").classList.toggle("on", !prog && activeMode === "recognition");
    $("modeWrite").classList.toggle("on", !prog && activeMode === "production");
    $("modeProgress").classList.toggle("on", prog);
    $("lvl").textContent = "L" + balls.recognition.unlocked;
  }

  // Progress curve = end-of-day snapshot of every stage count. Overwriting the
  // day's entry on each grade leaves the last (end-of-day) value per day.
  function recordDailyStages() {
    var c = stageCounts();
    progress.dailyStages[ymdOf(Date.now())] =
      { rl: c.rl, rd: c.rd, rm: c.rm + c.wl, wd: c.wd, wm: c.wm };
  }

  function renderCard(view) {
    view.innerHTML = "";
    if (!current) current = nextCard();
    if (!current) {
      var msg = (activeMode === "production")
        ? "No words to write yet \u2014 master some words in read mode first."
        : "Nothing to quiz yet.";
      view.appendChild(h("div", "empty", msg));
      return;
    }
    var w = WORDS[current.idx];
    var card = h("div", "card");
    if (current.isNew) card.appendChild(h("div", "newtag", "new word"));

    var front = h("div", "front");
    if (activeMode === "recognition") {
      front.appendChild(h("div", "jp big", w.s));
    } else {
      // production: prompt is the meaning; reading then kanji are revealed in steps
      front.appendChild(glossEls(w));
    }
    card.appendChild(front);

    var back = h("div", "back");
    if (activeMode === "recognition") {
      if (step >= 1) {                       // one reveal: reading + meaning
        back.appendChild(h("div", "reading", w.r));
        back.appendChild(glossEls(w));
      }
    } else {
      if (step === 1) back.appendChild(h("div", "reading big", w.r)); // 1: hiragana only
      if (step >= 2) back.appendChild(h("div", "jp big", w.s));       // 2: kanji only
    }
    card.appendChild(back);
    view.appendChild(card);

    // grades appear only once everything is revealed (recognition: step 1,
    // production: step 2). Before that, a single "reveal" button advances a step.
    var lastStep = (activeMode === "recognition") ? 1 : 2;
    var actions = h("div", "actions");
    if (step < lastStep) {
      var label = (activeMode === "recognition") ? "Show answer"
                : (step === 0) ? "Show hiragana" : "Show kanji";
      var show = h("button", "show", label);
      show.onclick = function () { step++; render(); };
      actions.appendChild(show);
    } else {
      actions.appendChild(gradeBtn("Know it", "know g-know"));
      actions.appendChild(gradeBtn("Pretty good", "good g-good"));
      actions.appendChild(gradeBtn("Not yet", "hard g-hard"));
    }
    view.appendChild(actions);

    // Read mode only: under the grade buttons, offer an on-demand example
    // sentence (generated via OpenAI, see below). Shown once the answer is
    // revealed so the furigana reading doesn't spoil the recall task.
    if (activeMode === "recognition" && step >= lastStep) {
      var exWrap = h("div", "examplewrap");
      renderExample(exWrap, w);
      view.appendChild(exWrap);
    }
  }

  // ---- example sentences (app.md "Example sentences")
  var exampleState = null;   // transient: {idx, status:'loading'|'error', error}
  // Persisted cache of generated sentences, keyed by surface\u0001reading so it
  // survives reloads and works fully offline once a word has been queried once.
  var EXAMPLES_KEY = "ballGame.examples.v1";
  var exampleCache = {};     // { "surface\u0001reading": sentenceObj }

  function exKey(w) { return w.s + "\u0001" + w.r; }
  function loadExamples() {
    try {
      var raw = JSON.parse(localStorage.getItem(EXAMPLES_KEY));
      if (raw && raw.items && typeof raw.items === "object") exampleCache = raw.items;
    } catch (e) { /* ignore corrupt cache */ }
  }
  function saveExamples() {
    try {
      localStorage.setItem(EXAMPLES_KEY,
        JSON.stringify({ schemaVersion: 1, items: exampleCache }));
    } catch (e) { /* quota/full: keep in memory only */ }
  }

  function renderExample(container, w) {
    var st = (exampleState && exampleState.idx === current.idx) ? exampleState : null;
    var cached = exampleCache[exKey(w)] || null;
    var loading = !!(st && st.status === "loading");
    var data = cached;                                   // cache-first (offline)
    // A word that has been queried before shows its saved sentence instantly and
    // the button offers a fresh generation; otherwise it's a first-time fetch.
    var btn = h("button", "exbtn", data ? "New example sentence" : "Get example sentence");
    btn.disabled = loading;
    btn.onclick = function () { fetchExample(current.idx, w); };
    container.appendChild(btn);
    if (loading) { container.appendChild(h("div", "exmsg", "Generating\u2026")); }
    else if (st && st.status === "error") {
      container.appendChild(h("div", "exmsg err", st.error || "Failed to get example."));
    }
    if (data) container.appendChild(exampleCard(data));  // show saved even on error
  }

  // OpenAI is called DIRECTLY from the browser using the user's own key (stored
  // on-device in settings.openaiKey). This lets the example button work from
  // file:// on a phone with no server. If no key is set we fall back to the
  // local server proxy (serve_app.py) so desktop dev still works.
  var OPENAI_URL = "https://api.openai.com/v1/chat/completions";
  var OPENAI_MODEL_DEFAULT = "gpt-4o-mini";
  // System prompt mirrors app.md "Example sentences" (and scripts/serve_app.py).
  var EX_SYSTEM = [
    "You write Japanese example sentences for intermediate learners. Output MUST be a single JSON object only (no markdown fences, no commentary before or after). Schema:",
    "{",
    '  "japanese": string,',
    '  "japanese_char_count": number,',
    '  "furigana": [ { "kanji_span": string, "reading_hiragana": string } ],',
    '  "english": string,',
    '  "finnish": string',
    "}",
    "Rules:",
    '1. "japanese" MUST contain the target substring from the user message verbatim (identical Unicode sequence), used naturally in context.',
    "2. Textbook/register: neutral-modern written Japanese (textbook or short news tone). No spoken colloquialisms, no youth/internet slang, no net abbreviations (e.g. \u3084\u3063\u3071, \u30de\u30b8, w, \u8349).",
    '3. "japanese" must be at most 50 Unicode scalar values (code points) long. Count only "japanese", not translations. "japanese_char_count" must equal that length.',
    '4. "furigana": ordered left-to-right. Each "kanji_span" is a non-empty substring of "japanese" consisting only of Han (kanji) characters as used in that sentence. Spans must not overlap, must appear in order. CRITICAL: annotate EVERY kanji in "japanese" \u2014 the spans together must cover every single kanji code point, including common/easy words (e.g. \u90e8\u5c4b, \u4e2d, \u79c1, \u65e5\u672c, \u898b). Do NOT annotate only one word and leave the rest bare; partial coverage is wrong. "reading_hiragana" is the hiragana for that span in this sentence (correct compound readings; okurigana kana stay outside the span). If "japanese" contains no kanji, use [].',
    '5. "english" and "finnish": full-sentence translations of "japanese".',
    'Example: for "japanese" = "\u90e8\u5c4b\u306e\u4e2d\u306b\u306f\u660e\u304b\u308a\u304c\u706f\u3063\u3066\u3044\u308b", "furigana" MUST cover every kanji: [{"kanji_span":"\u90e8\u5c4b","reading_hiragana":"\u3078\u3084"},{"kanji_span":"\u4e2d","reading_hiragana":"\u306a\u304b"},{"kanji_span":"\u660e","reading_hiragana":"\u3042"},{"kanji_span":"\u706f","reading_hiragana":"\u3068\u3082"}] \u2014 not just one of them.'
  ].join("\n");

  function exUserPrompt(target, reading) {
    return "Target word/phrase to include verbatim in the Japanese sentence: " + target +
      "\nOptional reading hint (hiragana): " + (reading || "") +
      "\n\nGenerate one example sentence JSON as specified in the system message.";
  }

  // Validate + normalize (furigana kept lenient: it is display-only, and models
  // often include okurigana in a span or skip a kanji). Returns clean obj or null.
  function exValidate(obj, target) {
    if (!obj || typeof obj !== "object") return null;
    var jp = obj.japanese;
    if (typeof jp !== "string" || !jp) return null;
    if (jp.indexOf(target) < 0) return null;                 // target verbatim
    if (Array.from(jp).length > 50) return null;             // <=50 code points
    var fur = Array.isArray(obj.furigana) ? obj.furigana : [];
    var clean = [];
    for (var i = 0; i < fur.length; i++) {
      var it = fur[i];
      if (it && typeof it.kanji_span === "string" && it.kanji_span &&
          jp.indexOf(it.kanji_span) >= 0 && typeof it.reading_hiragana === "string") {
        clean.push({ kanji_span: it.kanji_span, reading_hiragana: it.reading_hiragana });
      }
    }
    return { japanese: jp, japanese_char_count: Array.from(jp).length,
      furigana: clean, english: obj.english || "", finnish: obj.finnish || "" };
  }

  // Effective key/model: a value typed into Settings wins; otherwise fall back
  // to the embedded per-device config (app/config.js -> window.__CONFIG__).
  function cfg() { return window.__CONFIG__ || {}; }
  function apiKey() { return ((settings.openaiKey || cfg().openaiKey) || "").trim(); }
  function apiModel() { return ((settings.openaiModel || cfg().openaiModel) || "").trim() || OPENAI_MODEL_DEFAULT; }

  function openaiDirect(target, reading) {
    var key = apiKey();
    var model = apiModel();
    var body = { model: model, temperature: 0.7, response_format: { type: "json_object" },
      messages: [ { role: "system", content: EX_SYSTEM },
                  { role: "user", content: exUserPrompt(target, reading) } ] };
    return fetch(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error((j && j.error && j.error.message) || ("OpenAI HTTP " + r.status));
        var c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        return JSON.parse(c);
      });
    });
  }

  // Direct call with a single retry on failed validation.
  function generateExampleDirect(target, reading) {
    return openaiDirect(target, reading).then(function (o) {
      var v = exValidate(o, target);
      if (v) return v;
      return openaiDirect(target, reading).then(function (o2) {
        var v2 = exValidate(o2, target);
        if (v2) return v2;
        throw new Error("The model's sentence didn't pass the checks. Try again.");
      });
    });
  }

  function fetchExample(idx, w) {
    exampleState = { idx: idx, status: "loading" };
    render();
    var hasKey = !!apiKey();
    var p;
    if (hasKey) {
      p = generateExampleDirect(w.s, w.r);
    } else {
      p = fetch("api/example", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: w.s, reading: w.r })
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.error) || "Failed to get example.");
          return j;
        });
      });
    }
    p.then(function (data) {
      exampleCache[exKey(w)] = data;                          // cache + persist
      saveExamples();
      if (!exampleState || exampleState.idx !== idx) return;   // card moved on
      exampleState = null;                                     // saved sentence now shows from cache
      render();
    }).catch(function (e) {
      if (!exampleState || exampleState.idx !== idx) return;
      var msg = hasKey ? (e && e.message ? e.message : "Request failed.")
        : "Add your OpenAI API key in Settings (Progress tab) to use this on your phone.";
      exampleState = { idx: idx, status: "error", error: msg };
      render();
    });
  }

  function exampleCard(d) {
    var box = h("div", "example");
    box.appendChild(furiganaEl(d.japanese, d.furigana || []));
    if (d.english) box.appendChild(h("div", "ex-en", d.english));
    if (settings.showFinnish && d.finnish) box.appendChild(h("div", "ex-fi", d.finnish));
    return box;
  }

  // Interleave kanji spans (as <ruby>) with plain kana, in order.
  function furiganaEl(jp, fur) {
    var wrap = h("div", "jp ex-jp");
    var pos = 0;
    for (var i = 0; i < fur.length; i++) {
      var span = fur[i] && fur[i].kanji_span, read = fur[i] && fur[i].reading_hiragana;
      if (!span) continue;
      var at = jp.indexOf(span, pos);
      if (at < 0) continue;
      if (at > pos) wrap.appendChild(document.createTextNode(jp.slice(pos, at)));
      var ruby = document.createElement("ruby");
      ruby.appendChild(document.createTextNode(span));
      var rt = document.createElement("rt"); rt.textContent = read || "";
      ruby.appendChild(rt);
      wrap.appendChild(ruby);
      pos = at + span.length;
    }
    if (pos < jp.length) wrap.appendChild(document.createTextNode(jp.slice(pos)));
    return wrap;
  }

  function gradeBtn(label, cls) {
    var b = h("button", "grade " + cls, label);
    var g = cls.indexOf("know") >= 0 ? "know" : cls.indexOf("good") >= 0 ? "good" : "hard";
    b.onclick = function () { grade(current, g); current = null; step = 0; render(); };
    return b;
  }

  var GLOSS_SHOWN = 3;  // collapse translations beyond this many
  // Render a translation string, showing only the first few senses with a
  // "+N more" toggle when there are many (keeps the answer box compact).
  function glossLine(text, cls) {
    var parts = text.split(/\s*[;,]\s*/).filter(Boolean);
    var el = h("div", cls);
    if (parts.length <= GLOSS_SHOWN) { el.textContent = parts.join(", "); return el; }
    var head = parts.slice(0, GLOSS_SHOWN).join(", ");
    var span = h("span", null, head + " ");
    var btn = h("button", "morebtn", "+" + (parts.length - GLOSS_SHOWN) + " more");
    var open = false;
    btn.onclick = function (e) {
      e.stopPropagation();
      open = !open;
      span.textContent = (open ? parts.join(", ") : head) + " ";
      btn.textContent = open ? "less" : "+" + (parts.length - GLOSS_SHOWN) + " more";
    };
    el.appendChild(span);
    el.appendChild(btn);
    return el;
  }
  function glossEls(w) {
    var box = h("div", "gloss");
    if (w.e) box.appendChild(glossLine(w.e, "en"));
    if (settings.showFinnish && w.f) box.appendChild(glossLine(w.f, "fi"));
    return box;
  }

  // distinct kanji a ball has "at least learned" (its count map only holds words
  // that reached learned/mastered in that phase).
  function distinctKanji(b) { var n = 0; b.count.forEach(function (c) { if (c > 0) n++; }); return n; }
  function stat(v, label, cls) {
    var e = h("div", "stat" + (cls ? " " + cls : ""));
    e.appendChild(h("div", "num", "" + v));
    e.appendChild(h("div", "lbl", label));
    return e;
  }

  // ---- backup & restore -----------------------------------------------------
  // Progress lives only in this browser's localStorage, so give the user a way
  // to save it to a file and move/restore it. The file bundles the progress
  // blob plus the cached example sentences.
  function exportBackup() {
    var payload = { app: "jukugo", type: "backup", version: 1,
      exportedAt: new Date().toISOString(), data: null, examples: null };
    try { payload.data = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    try { payload.examples = JSON.parse(localStorage.getItem(EXAMPLES_KEY)); } catch (e) {}
    if (!payload.data) { alert("No progress to export yet."); return; }
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    var name = "jukugo-backup-" + d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + ".json";
    var blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var obj;
      try { obj = JSON.parse(reader.result); } catch (e) { alert("Not a valid backup file."); return; }
      // accept either a wrapped backup or a bare progress blob
      var appBlob = (obj && obj.data) ? obj.data : obj;
      if (!appBlob || typeof appBlob !== "object" || !appBlob.schemaVersion) {
        alert("This doesn't look like a Jukugo backup."); return;
      }
      if (!confirm("Restore this backup? It will REPLACE the progress currently on this device.")) return;
      try { localStorage.setItem(KEY, JSON.stringify(appBlob)); } catch (e) {}
      if (obj && obj.examples) {
        try { localStorage.setItem(EXAMPLES_KEY, JSON.stringify(obj.examples)); } catch (e) {}
      }
      location.reload();
    };
    reader.readAsText(file);
  }

  // ---- progress view (single, shared; the per-stage counts live in the HUD)
  function renderProgress(view) {
    view.innerHTML = "";
    var kstats = h("div", "statgrid");
    kstats.appendChild(stat(distinctKanji(balls.recognition), "read kanji", "st-rm"));
    kstats.appendChild(stat(distinctKanji(balls.production), "write kanji", "st-wm"));
    view.appendChild(kstats);
    view.appendChild(h("h3", null, "Daily cumulative words at each stage"));
    view.appendChild(chart(progress.dailyStages));
    view.appendChild(legend());

    // --- settings: separate learning-pool caps for reading and writing
    view.appendChild(h("h3", null, "Settings"));
    view.appendChild(poolRow("Max words learning (read)", true));
    view.appendChild(poolRow("Max words learning (write)", false));
    view.appendChild(h("div", "sethint",
      "How many words you can be actively learning at once (max " + POOL_MAX + ", min " + POOL_MIN +
      ") before reaching the learned level. Set separately for reading and writing."));
    view.appendChild(gapRow());
    view.appendChild(h("div", "sethint",
      "Minimum spacing before a word you're learning is shown again. A word that hasn't been seen " +
      "for this long is reviewed before any new word; new words are introduced only when nothing is " +
      "due and you're below the max above. Range " + ACQUIRE_GAP_MIN_H + "\u2013" + ACQUIRE_GAP_MAX_H + " h."));

    // --- settings: OpenAI key/model for the "Get example sentence" button
    view.appendChild(h("h3", null, "Example sentences (OpenAI)"));
    var keyRow = h("div", "setrow col");
    keyRow.appendChild(h("span", "setlbl", "OpenAI API key"));
    var keyIn = h("input", "setinput");
    keyIn.type = "password";
    keyIn.placeholder = cfg().openaiKey ? "using built-in key (type to override)" : "sk-\u2026";
    keyIn.value = settings.openaiKey || "";
    keyIn.autocomplete = "off"; keyIn.spellcheck = false; keyIn.autocapitalize = "off";
    keyIn.onchange = function () { settings.openaiKey = keyIn.value.trim(); save(); };
    keyRow.appendChild(keyIn);
    view.appendChild(keyRow);

    var modRow = h("div", "setrow col");
    modRow.appendChild(h("span", "setlbl", "Model"));
    var modIn = h("input", "setinput");
    modIn.type = "text"; modIn.placeholder = apiModel();
    modIn.value = settings.openaiModel || "";
    modIn.autocomplete = "off"; modIn.spellcheck = false; modIn.autocapitalize = "off";
    modIn.onchange = function () { settings.openaiModel = modIn.value.trim(); save(); };
    modRow.appendChild(modIn);
    view.appendChild(modRow);

    view.appendChild(h("div", "sethint",
      "Your key is stored only on this device and sent directly to OpenAI (never to any other server). " +
      "Needed for the \u201cGet example sentence\u201d button when running from a file on your phone. " +
      "Default model: " + OPENAI_MODEL_DEFAULT + "."));

    // --- backup & restore
    view.appendChild(h("h3", null, "Backup & restore"));
    var bkRow = h("div", "btnrow");
    var expBtn = h("button", "linkbtn", "Export backup");
    expBtn.onclick = exportBackup;
    var impBtn = h("button", "linkbtn", "Restore backup");
    var fileIn = h("input"); fileIn.type = "file"; fileIn.accept = "application/json,.json";
    fileIn.style.display = "none";
    fileIn.onchange = function () { if (fileIn.files && fileIn.files[0]) importBackup(fileIn.files[0]); };
    impBtn.onclick = function () {
      // Where supported (Chromium), open the picker in the Downloads folder,
      // since that's where the exported backup lands by default. Elsewhere fall
      // back to the normal file input (browser chooses the starting folder).
      if (window.showOpenFilePicker) {
        window.showOpenFilePicker({
          startIn: "downloads", multiple: false,
          types: [{ description: "Jukugo backup", accept: { "application/json": [".json"] } }]
        }).then(function (hs) { return hs[0].getFile(); })
          .then(function (f) { importBackup(f); })
          .catch(function () {});   // user cancelled
      } else {
        fileIn.click();
      }
    };
    bkRow.appendChild(expBtn); bkRow.appendChild(impBtn); bkRow.appendChild(fileIn);
    view.appendChild(bkRow);
    view.appendChild(h("div", "sethint",
      "Export saves ALL your progress to a file you can keep or move to another device. " +
      "Restore replaces the progress on this device with a backup file. " +
      "Do this regularly \u2014 progress is stored only in this browser and can be lost if its data is cleared."));

    // --- help
    view.appendChild(h("h3", null, "Help"));
    var helpRow = h("div", "btnrow");
    var howBtn = h("button", "linkbtn", "How to play");
    howBtn.onclick = showIntro;
    helpRow.appendChild(howBtn);
    view.appendChild(helpRow);
  }

  // The five stage series and their colours (must match the HUD / styles.css).
  var STAGE_SERIES = [
    { key: "rl", label: "read learning", color: "#f4b740" },
    { key: "rd", label: "read learned", color: "#35c26b" },
    { key: "rm", label: "read mastered", color: "#6ea8fe" },
    { key: "wd", label: "write learned", color: "#a78bfa" },
    { key: "wm", label: "write mastered", color: "#ec4faf" }
  ];

  function poolRow(label, reading) {
    var row = h("div", "setrow");
    row.appendChild(h("span", "setlbl", label));
    var ctl = h("div", "stepper");
    var minus = h("button", "stepbtn", "\u2212");
    var val = h("span", "setval", "" + poolTarget(reading));
    var plus = h("button", "stepbtn", "+");
    minus.onclick = function () { setPoolTarget(reading, poolTarget(reading) - 1); };
    plus.onclick = function () { setPoolTarget(reading, poolTarget(reading) + 1); };
    ctl.appendChild(minus); ctl.appendChild(val); ctl.appendChild(plus);
    row.appendChild(ctl);
    return row;
  }
  function setPoolTarget(reading, n) {
    n = Math.max(POOL_MIN, Math.min(POOL_MAX, n | 0));
    var key = reading ? "poolTargetRead" : "poolTargetWrite";
    if (n === settings[key]) return;
    settings[key] = n;
    var b = reading ? balls.recognition : balls.production;
    b.trimLearning(n);   // shrink surplus (no-op when increasing; new words flow in over time)
    save();
    render();
  }
  function gapRow() {
    var row = h("div", "setrow");
    row.appendChild(h("span", "setlbl", "Repeat a learning word after (hours)"));
    var ctl = h("div", "stepper");
    var minus = h("button", "stepbtn", "\u2212");
    var val = h("span", "setval", "" + acquireGapHours());
    var plus = h("button", "stepbtn", "+");
    minus.onclick = function () { setAcquireGap(acquireGapHours() - 1); };
    plus.onclick = function () { setAcquireGap(acquireGapHours() + 1); };
    ctl.appendChild(minus); ctl.appendChild(val); ctl.appendChild(plus);
    row.appendChild(ctl);
    return row;
  }
  function setAcquireGap(n) {
    n = Math.max(ACQUIRE_GAP_MIN_H, Math.min(ACQUIRE_GAP_MAX_H, n | 0));
    if (n === acquireGapHours()) return;
    settings.acquireGapHours = n;
    save();
    render();
  }

  function legend() {
    var wrap = h("div", "legend");
    STAGE_SERIES.forEach(function (s) {
      var item = h("span", "legitem");
      var dot = h("span", "legdot"); dot.style.background = s.color;
      item.appendChild(dot); item.appendChild(h("span", null, s.label));
      wrap.appendChild(item);
    });
    return wrap;
  }

  // Multi-line chart: one coloured line per stage over the days played. Each
  // day's value is the end-of-day snapshot recorded in progress.dailyStages.
  function chart(dailyStages) {
    var days = Object.keys(dailyStages).sort();
    var wpx = 320, hpx = 170, pad = 24;
    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 " + wpx + " " + hpx);
    svg.setAttribute("class", "chart");
    if (!days.length) {
      var t = document.createElementNS(svgNS, "text");
      t.setAttribute("x", 12); t.setAttribute("y", 24);
      t.textContent = "No data yet - play to grow the curves."; t.setAttribute("fill", "#888");
      svg.appendChild(t); return svg;
    }
    var max = 1;
    days.forEach(function (d) {
      STAGE_SERIES.forEach(function (s) { var v = dailyStages[d][s.key] || 0; if (v > max) max = v; });
    });
    var n = days.length;
    var x = function (i) { return pad + (n === 1 ? (wpx - 2 * pad) / 2 : i * (wpx - 2 * pad) / (n - 1)); };
    var y = function (v) { return hpx - pad - v / max * (hpx - 2 * pad); };
    STAGE_SERIES.forEach(function (s) {
      var pts = days.map(function (d, i) { return x(i) + "," + y(dailyStages[d][s.key] || 0); }).join(" ");
      var poly = document.createElementNS(svgNS, "polyline");
      poly.setAttribute("points", pts); poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", s.color); poly.setAttribute("stroke-width", "2.5");
      poly.setAttribute("stroke-linejoin", "round"); poly.setAttribute("stroke-linecap", "round");
      svg.appendChild(poly);
      days.forEach(function (d, i) {
        var c = document.createElementNS(svgNS, "circle");
        c.setAttribute("cx", x(i)); c.setAttribute("cy", y(dailyStages[d][s.key] || 0));
        c.setAttribute("r", 2.5); c.setAttribute("fill", s.color); svg.appendChild(c);
      });
    });
    return svg;
  }

  // ---- top-bar view switching: Read | Write | Progress
  var currentTab = "play";               // "play" (read/write card) | "progress"
  function setMode(m) {                   // enter Read or Write
    currentTab = "play";
    if (activeMode !== m) { activeMode = m; current = null; step = 0; queue = []; ball().initIfEmpty(); }
    save(); render();
  }
  function showProgress() { currentTab = "progress"; render(); }

  // Welcome / how-to-play overlay. Shown on first launch (settings.seenIntro)
  // and re-openable from Progress > Help. Static, trusted markup.
  function showIntro() {
    var prev = $("intro"); if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
    var o = document.createElement("div");
    o.id = "intro"; o.className = "intro";
    o.innerHTML =
      '<h1>Jukugo</h1>' +
      '<div class="tag">Learn common Japanese words \u2014 first to read them, then to write them.</div>' +
      '<ol>' +
        '<li>See a word, tap <b>Show answer</b>, then rate yourself: <b>Know it</b>, ' +
          '<b>Pretty good</b>, or <b>Not yet</b>. Your rating decides how soon it comes back.</li>' +
        '<li>Each word climbs these stages:' +
          '<div class="flow">' +
            '<span class="chip2" style="background:#f4b740">learning</span>' +
            '<span class="arrow">\u2192</span>' +
            '<span class="chip2" style="background:#35c26b">learned</span>' +
            '<span class="arrow">\u2192</span>' +
            '<span class="chip2" style="background:#6ea8fe">mastered</span>' +
            '<span class="arrow">\u2192</span>' +
            '<span class="chip2" style="background:#a78bfa">write learned</span>' +
            '<span class="arrow">\u2192</span>' +
            '<span class="chip2" style="background:#ec4faf">write mastered</span>' +
          '</div>' +
        '</li>' +
        '<li>Use the top bar to switch <b>Read</b> / <b>Write</b> / <b>Progress</b>. ' +
          'Writing unlocks once a word is mastered in reading.</li>' +
      '</ol>' +
      '<div class="tip">Tip: back up your progress from <b>Progress \u2192 Backup &amp; restore</b>.</div>' +
      '<button class="startbtn" id="introStart">Start learning</button>';
    document.body.appendChild(o);
    $("introStart").onclick = function () {
      settings.seenIntro = true; save();
      if (o.parentNode) o.parentNode.removeChild(o);
    };
  }

  // ------------------------------------------------------------------- boot
  function boot() {
    console.log("Jukugo version " + VERSION);
    var v = $("ver"); if (v) v.textContent = "v" + VERSION;
    load();
    loadExamples();
    // Ask the browser to keep our data (reduces the chance of eviction). Granted
    // more readily once the app is installed to the home screen. Best-effort.
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    balls.recognition.initIfEmpty();
    balls.production.initIfEmpty();
    save();

    $("modeRead").onclick = function () { setMode("recognition"); };
    $("modeWrite").onclick = function () { setMode("production"); };
    $("modeProgress").onclick = function () { showProgress(); };
    var fi = $("fiToggle");
    fi.checked = settings.showFinnish;
    fi.onchange = function () { settings.showFinnish = fi.checked; save(); render(); };

    render();
    if (!settings.seenIntro) showIntro();
  }

  if (typeof document !== "undefined" && document.getElementById) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  // Headless test hook (Node): exposes engine internals without booting the UI.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      Ball: Ball, WORDS: WORDS, SEED: SEED, balls: balls,
      setActive: function (m) { activeMode = m; },
      stateOf: function (idx) { return states.get(idx); },
      ball: ball, buildRound: buildRound, nextCard: nextCard, grade: grade,
      getQueue: function () { return queue; }, load: load, save: save
    };
  }
})();

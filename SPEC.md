# Jukugo — design & algorithm spec

This document describes how the app works internally. For install/deploy
instructions see `README.md`. The implementation is a single vanilla-JS file
(`app.js`) with no build step; this spec is the source of truth for behavior.

## 1. Overview

Jukugo teaches common Japanese vocabulary. Each word walks a **single linear
path**: you first learn to **read** it, and only after mastering reading do you
learn to **write** it. There are two card views (Read / Write) over one shared
per-word state.

## 2. Word states (the linear path)

Every word is in exactly one state (or `none`). The order is:

```
none → r_learning → r_learned → r_mastered → w_learning → w_learned → w_mastered
```

- `r_*` = reading phase, `w_*` = writing phase.
- A word becomes a **writing candidate** when it reaches `r_mastered`.
- State is stored once per word in a shared `states` map; the two phase "balls"
  (`recognition`, `production`) are just views/derivations over that map.

## 3. Grading

Each card is graded with one of three buttons. A single grade moves the word:

| Button        | Effect                                             |
|---------------|----------------------------------------------------|
| **Know it**   | → `*_mastered`                                     |
| **Pretty good** | → `*_learned`                                    |
| **Not yet**   | stays / returns to `*_learning`                    |

`*` is the current phase (`r_` in Read view, `w_` in Write view). Each grade
stamps the word's `lastQuiz` with the current time.

## 4. The learning pool

The **learning pool** for a phase = the words currently in `*_learning` **that
have actually been quizzed at least once**. There is no pre-filled buffer of
unquizzed words: a word enters the pool only at the moment it is first presented.

- `poolTargetRead` / `poolTargetWrite` (Settings) cap the pool size per phase
  (min 4, max 200, default 8). The cap limits how many words you are actively
  learning at once before they graduate to `learned`.
- The HUD "read learning" count therefore equals the number of quizzed words in
  `r_learning` (a freshly introduced word that hasn't been graded yet is not
  counted until graded).
- **Lowering the cap** trims the pool down to the new size, evicting
  **not-yet-quizzed words first**, then hardest (highest level, then rarest).
  Quizzed words are never dropped while the pool is at/under the new cap.

## 5. Rounds

The game runs endless **rounds**. Each round = **2 retention + 1 acquisition**
(presented one card at a time).

### Retention (×2)
- Drawn only from the current phase's `learned` set (not `mastered`).
- Skips any word quizzed within the last **24 h** (cooldown) so freshly-learned
  words aren't re-asked immediately. Early on there may be 0–1 available.

### Acquisition (×1) — `chooseAcquire()`
Decides between introducing a brand-new word and re-drilling an existing
learning word:

- **Introduce a NEW word** when the pool is **below the cap** *and* your most
  recent quiz was within the **activity gap** (`acquireGapHours`, default 3 h) —
  i.e. you're in an active session.
  - Reading: the new word is chosen by the priority picker (§6).
  - Writing: the next writing candidate (oldest-mastered `r_mastered` word).
- **Otherwise re-drill** the oldest (least-recently-seen) learning word. This
  covers both "pool is full" and "returning after a break" (warm-up on return).

A word shown for the very first time (never graded) is flagged **`new word`**
and shows a badge on the card.

## 6. New-word priority (reading) — `pickNextWord()`

New reading words are pulled from the `none` pool within unlocked levels using a
kanji-connectivity + frequency priority (A > B > C):

- **Phase A** — consolidate a **common** word (rank ≤ `RARE_RANK` 30000) that
  introduces **no new kanji**.
- **Phase B** — introduce **one new kanji** (prefer fewer new kanji, earlier
  kanji in app order, more connections to known kanji).
- **Phase C** — consolidate a **rare** word (no new kanji), deferred until A/B
  are exhausted in the unlocked set.

Kanji already present in the learning pool count as "not new", so rare
repeated-kanji words aren't treated as fresh introductions.

## 7. Level unlocking — `maybeUnlock()`

Reading has curriculum levels (from the data). A level unlocks when either
~80% of its words are in the ball, or the "common pool" for the unlocked levels
is exhausted (rare Phase-C words don't block progression). Writing has no
separate levels; it follows reading mastery.

## 8. Counts & progress

- **HUD** shows five per-stage counts (right-to-left): read learning / read
  learned / read mastered / write learned / write mastered. "read mastered"
  visually folds in `w_learning` (mastered for reading, pending writing).
- **Progress view** shows distinct-kanji stats ("read kanji" / "write kanji"),
  a multi-line daily-cumulative chart (one colored line per stage), a legend,
  and Settings.
- `recordDailyStages()` writes an end-of-day snapshot of every stage count to
  `progress.dailyStages[YYYY-MM-DD]` on each grade (last write of the day wins).

## 9. Settings

- **Max words learning (read / write)** — the per-phase pool caps (§4).
- **New words: active within (hours)** — the acquisition activity gap (§5),
  1–48 h, default 3.
- **Show Finnish (FI)** — toggle Finnish glosses.
- **OpenAI key / model** — for the "Get example sentence" button (§12).

Long translation lists are collapsed after 3 senses behind a "+N more" toggle.

## 10. Persistence

Everything is stored in `localStorage` under `ballGame.v1` (schema v3):

```jsonc
{
  "schemaVersion": 3,
  "activeMode": "recognition",
  "states": { "123": "r_learned", ... },
  "lastQuizzedAt": { "123": 1699999999999, ... },
  "unlockedLevel": 3,
  "progress": { "dailyStages": { "2026-08-03": { "rl":8,"rd":20,"rm":40,"wd":12,"wm":5 } } },
  "settings": { "showFinnish": true, "poolTargetRead": 8, "poolTargetWrite": 8, "acquireGapHours": 3 }
}
```

- `lastQuizzedAt` is the acquisition/review ordering key. For a word introduced
  into a pool it is (re)set to the presentation time; `0`/absent means
  "not yet quizzed"; the reading seed (一) uses `-1` to sort first.
- Old saves migrate: a single `poolTarget` → `poolTargetRead`/`poolTargetWrite`;
  missing `acquireGapHours` → default 3.
- On boot the app requests `navigator.storage.persist()` to reduce eviction.

## 11. Backup & restore

Because progress lives only in the browser, Settings offers **Export backup**
(downloads a JSON file bundling the `ballGame.v1` blob + cached example
sentences) and **Restore backup** (validates and replaces local progress, then
reloads). Restore opens the Downloads folder where the File System Access API is
available (desktop Chromium); elsewhere it uses the standard file picker.

## 12. Example sentences (OpenAI)

The Read card offers "Get example sentence": a direct browser call to the OpenAI
Chat Completions API using the per-device key (from Settings, or a built-in key
in `config.js` if present). Responses are validated (complete furigana coverage)
and cached in `localStorage` (`ballGame.examples.v1`) keyed by surface+reading,
so a word's sentence is instant and available offline after first fetch.

## 13. Offline / PWA

`sw.js` is a service worker that precaches the app shell (`index.html`,
`app.js`, `data.js`, `styles.css`, `config.js`, manifest, icon) for full offline
use. Strategy: cache-first for same-origin assets, network fallback to the
cached shell for navigations; cross-origin (OpenAI) requests are never
intercepted or cached. Bump the `CACHE` version string in `sw.js` on every
release so clients refresh; `index.html` auto-reloads once when a new worker
takes control.

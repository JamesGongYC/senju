---
name: web-wordle-play
description: Use when asked to play Wordle (an unofficial free clone, not NYT) in Chrome via a browser worker, alone or alongside other web games.
revision: 5
updated: 2026-11-14
---

# web-wordle-play

Plan shape: one browser worker (browser server only) per game, spawned in the same turn as the other games (e.g. with Minesweeper, see web-minesweeper-play). No sign-in or user help is needed. Two runs lost or nearly lost (6/6) by guessing candidates one at a time after finding a pattern like _AUNT or _E_AL. Put the probe rule below in the worker goal explicitly, in a sentence, not only via the skill.

Site that worked: wordleunlimited.org (unofficial clone, no account).
- The help dialog on first load is closed when the page opens. If one is still there, click `.close-icon`.
- The person wants to watch. For every guess, click each letter on the on-screen keyboard (browser_click, target `button[data-key="s"]`, one key per call), then the Enter key (`button[data-key="↵"]`).
- Read the result after each row with one read-only browser_evaluate: `() => [...document.querySelector('game-app').shadowRoot.querySelectorAll('game-row')].map(r => r.getAttribute('letters') + ':' + [...r.shadowRoot.querySelectorAll('game-tile')].map(t => t.getAttribute('evaluation')).join(','))`. Tiles are correct / present / absent. Put browser_wait_for time 2 before it, as the last calls of the same reply as the row's clicks.

Method:
- Guess 1: SLATE. Guess 2: five other common letters (e.g. CRONY/POINT-style) to test as many new letters as possible, even if not a candidate. Do not play guess 2 as a near-repeat of guess 1 (EARLY after SLATE reused A, L, E and learned little).
- Before each later guess, write out ALL words fitting the feedback (greens, yellows not in tried spot, grays absent, repeats), including less common ones.
- If more than 2 candidates remain, NEVER guess them one at a time. Build a probe word (need not be a candidate) that contains the distinguishing letters of the candidates, placed in non-green positions, and filler letters that are known-gray are fine. Examples: _AUNT (D,G,H,J,T,V) -> probe like "JIHAD"/"VOMIT"; _E_AL (candidates DECAL, MEDAL, LEGAL, PENAL, METAL, FERAL...) -> probe using D, M, G, C, F together, e.g. "FUDGY"/"MUCID"-style words. After the probe, guess the answer.
- With 1-2 candidates left, guess the likelier, more common word.
- Hard-mode is not enforced on this clone, so probes are legal.

Report the answer and guess count.

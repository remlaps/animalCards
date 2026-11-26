# ADR 0001 — Split the codebase into Protocol / Game / Presentation layers

**Status:** Proposed
**Date:** 2026-11-25

## Context
The project mixes deterministic card-distribution rules with game data and web presentation.
Today `card-resolver.js` (resolution) and `difficulty.js` (RABD) are already single-source-of-
truth modules, but the *award rule* (who gets a card, and the downgrade for non-winners) and
all display logic live in the page scripts. A third-party developer cannot currently reuse the
distribution rules without copying page code.

## Decision (proposed)
Adopt three layers with a one-way dependency direction:

1. **Protocol (engine):** pure, deterministic, game-agnostic. Inputs → outputs. No DOM/network/files.
2. **Game (definition):** `cards-config.json` + validators/tests (the catalogue and its knobs).
3. **Presentation:** pages/UX. Multiple front-ends (web, bot, mobile) may exist per game.

Dependency direction: Presentation → Game → Protocol. Never upward.

## Consequences
- Engine can be reused across games (e.g. "SpaceCards") with zero code duplication.
- The award rule and any other "who gets what" logic must move out of page scripts into the engine.
- Distribution can be packaged as a reusable module (git submodule or package; see REARCHITECTURE.md).

## Open questions
- Packaging: separate repo + submodule vs. npm package vs. a `lib/` folder?
- Where does config load from for Node vs. browser consumers?

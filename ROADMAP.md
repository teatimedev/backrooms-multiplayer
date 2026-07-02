# THE BACKROOMS: MULTIPLAYER — Design Roadmap

The north star: **a co-op descent campaign that people tell stories about
afterwards.** Not "we played the backrooms game", but "and then Kiah picked up
the fuel can and it STARTED SLOSHING and the thing heard it from across the
map". Every feature below is judged by one question: *does it create a story?*

---

## PHASE 1 — THE CAMPAIGN (in progress)

Each level stops being a palette swap and gets its **own objective language**:

| Level | Objective | The twist |
|---|---|---|
| **LEVEL 0 · lobby** | Pull 3 breakers (as now) | The tutorial act. Learn the light, the map, the monster. |
| **LEVEL 1 · garage** | Find 3 **fuel canisters**, carry them to **THE GENERATOR** | Carrying fuel makes you *loud* — it sloshes, and the entity prioritises carriers. Drop it (`G`) to run silent, but someone has to come back for it. Downed carriers drop the can where they fall. |
| **THE POOLROOMS** | Two **drain valves**, far apart, must be held **simultaneously** until the water drains | The game's cruellest ask: split up, on the deepest level, with the fastest entity — and hold still while it comes. |

Plus, this phase:
- **Noise**: sprinting, splashing, carrying — all raise a noise stat the
  entity's targeting can hear. Walking quietly is now a real tactic.
- **Corpses persist**: die, and next round (same session) your body is still
  there, name scrawled beside it, in the *new* maze. The backrooms keep what
  they take.
- **Volumetric beams**: visible light cones for every flashlight and headlamp.
- Entity is drawn toward valve-holders and fuel-carriers. Objectives = bait.

## PHASE 2 — THE BESTIARY

One monster is a mechanic; a bestiary is a mythology.

- **THE SKINSTEALER (poolrooms)**: sometimes what's standing at the end of the
  hall wearing your friend's colour and name tag… has the wrong gait. Uses
  real player avatars as its disguise at long range; drops it when close.
  Voice mimicry gets teeth: it can answer proximity chat with garbled replays
  of things people actually said this session.
- **THE CRAWLER (garage)**: lives above the ceiling tiles. You hear it
  skittering overhead, tiles bounce, dust falls — it only drops when someone
  stands still too long under it. Anti-camping monster.
- **The Stalker learns**: counters per session (times repelled by light,
  times juked) subtly shift its approach vectors — flank more, stare longer.

## PHASE 3 — HANDS, ITEMS, ROLES

- **First-person body**: visible hands, flashlight in fist, look down and see
  your own legs (and the water you're standing in).
- **Loadout pick** at round start, 1 of 3: **Flare** (thrown, 25s repel zone),
  **Radio** (talk to anyone anywhere — but it crackles, and it can hear the
  crackle), **Camera** (flash stuns; each photo reveals map around the spot).
- **Drag revive**: hold E while moving to drag a downed friend out of the
  kill zone before picking them up.

## PHASE 4 — THE WORLD THAT REMEMBERS

- **Shifting walls**: mid-round, a distant rumble — a block's walls re-roll.
  The map you drew is now partly a lie (synced deterministically via salt).
- **Anomaly rooms**: the corridor that never ends, the room where the hum
  plays backwards, an exact copy of your spawn room somewhere it shouldn't be.
- **Wanderer logs**: procedural notes from "previous crews" seeded around the
  maze; occasionally they quote *your own past runs*.
- **Daily Descent**: one global seed per day, personal bests, in-memory
  leaderboard. Same maze as every other crew on Earth, that day only.
- **Run share-card**: end screen renders your route, deaths, stats onto a
  downloadable image. The "and THEN—" artifact for the group chat.

## Always-on quality bar

Every phase ships with: bot-verified (dirtest/objtest/prodtest green),
60fps, deployed to Fly + Vercel, README current. No feature lands untested.

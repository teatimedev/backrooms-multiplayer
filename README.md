# THE BACKROOMS: MULTIPLAYER

**▶ PLAY NOW: https://backrooms-beryl.vercel.app** — host a session, send the
code to friends. (Game server: `backrooms-mp.fly.dev`, sleeps when idle; the
first connect of the day may take a few seconds to wake it.)

A browser-based co-op horror game. You and up to 7 friends have noclipped into
an infinite, procedurally generated labyrinth of mono-yellow office rooms.
Find each other. Pull the **three breaker panels** to power the dead exit.
Leave **together** — the doorway only counts if every living player stands in
it. Something in the walls hunts whoever wanders off alone, it gets angry when
the power comes on, and the only thing it hates is your flashlight.

Everything — textures, audio, the maze itself — is generated procedurally at
runtime. There are no asset downloads; the whole game is ~150 kB gzipped.

## Play in 60 seconds (local)

```bash
npm install
npm run dev
```

Open http://localhost:5314 in **two browser tabs**. In tab one, hit
**HOST A DESCENT** and note the code (e.g. `MOIST-7431`). In tab two, enter the
code and **JOIN**. You'll spawn scattered in the same maze — go find yourself.

> Tip: browsers only allow microphone + audio autoplay on `localhost` and
> HTTPS, so voice chat works locally and on any deployed HTTPS URL.

## How to survive

| Thing | What it means |
|---|---|
| **The code** | Seeds the world. Everyone with the same code generates the *identical* infinite maze, deterministically. |
| **The entity** | Driven by an AI Director: calm → build → peak → guaranteed breathing room, with a hunger that shortens the quiet as the round goes on. It prefers the most isolated player, remembers its last victim and picks on someone else next, and its **first appearance each round is only a warning** — it closes in, stares, and leaves. Lights die around it; the hum goes silent near it. |
| **Going down** | Getting caught doesn't kill you — you're **downed**: crawling, bleeding out (60s). A teammate holding `E` next to you for 4s brings you back. Downed alone with nobody left? You have 12 seconds to make peace. It always retreats after a takedown — the rescue window is real. |
| **Blackouts** | Sometimes, when it commits, every light in the world dies with it. |
| **Breakers** | Three panels, scattered in different directions (they spit audible sparks). `E` to pull. All three → the exit powers on → the entity stops being patient. Split up to cover ground, or stay safe and slow? |
| **The light** | Hold your flashlight beam on the entity: it slows. Keep it lit up during a hunt for a few seconds: it flees shrieking. Your only weapon. |
| **Glimpses** | Sometimes it's just… standing there, far down a hall. Sometimes it isn't there at all. Low sanity blurs the difference. |
| **Chalk** (hold `C`, flick mouse, release) | Draw arrows/symbols on walls and floors. Synced to everyone, persistent for the session. Navigate — or gaslight. |
| **Mental map** (hold `TAB`) | A chalk sketch of everywhere *you* have personally been — scroll to zoom. Shows the crew's chalk marks, landmarks you've found, breakers, the exit once seen, where people died, and edge arrows toward everything off-screen. |
| **Almond water** | Restores sanity and gives you an 8-second sense of the exit's direction (check your map). |
| **Sanity** | Drains alone, in the dark, near the entity. Low sanity means whispers, visual decay, and things that aren't there. Company heals it. |
| **Echoes** | The dead become spectators. They can't speak — but every 25s they can press `F` to stutter the lights near them. Near the entity, that flicker *stuns it*. Guide the living. Or troll them. |
| **Audio mimicry** | Late in a round, the entity borrows footsteps and voices and plays them from the wrong direction. Trust nothing you can't see. |
| **Voice chat** | Proximity-based WebRTC. Voices fade with distance, muffle through walls, and *corrupt* when the entity is near. Push `V` to talk. |

Controls: `WASD` move · `SHIFT` sprint (stamina) · `F` flashlight (echo: light-flicker) ·
`C` hold = chalk · `TAB` hold = map · `V` hold = talk · `ENTER` chat · `ESC` menu.

## Deploying it for your friends

**It's already deployed** (see the top). The current production setup:

- **Game server** (rooms + entity + a fallback copy of the client) on Fly.io:
  app `backrooms-mp`, region `lhr`, scale-to-zero. Update with:
  ```bash
  fly deploy
  ```
- **Client** on Vercel (project `backrooms` → backrooms-beryl.vercel.app),
  built against the Fly WebSocket URL. Update with:
  ```bash
  cd client && VITE_WS_URL=wss://backrooms-mp.fly.dev/ws npx vite build
  rm -rf ../.deploy-vercel && mkdir ../.deploy-vercel && cp -r dist/* ../.deploy-vercel/
  cd ../.deploy-vercel && vercel deploy --prod --yes
  ```
  (https://backrooms-mp.fly.dev also serves the game directly if Vercel is ever down.)

If you'd rather run it elsewhere, the whole game — static client **and**
WebSocket rooms — is one Node process, so you deploy exactly one thing.
No database, no required environment variables.

### Render (single-service alternative, free)

1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New → Web Service** → pick the repo.
3. Set:
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
4. Create the service. That's it — share `https://<your-app>.onrender.com`
   and a room code.

Free-tier note: the instance sleeps after ~15 min idle, so the *first* person
to open it may wait ~40s for a cold start. Everyone after that is instant.

### Railway / Fly.io (alternatives)

Both work with zero config changes: they run `npm install && npm run build`
then `npm start`, and inject `PORT`, which the server respects.

- Railway: **New Project → Deploy from GitHub repo**, set the build/start
  commands above under Settings if not auto-detected.
- Fly: `fly launch` (Node builder), set `internal_port` to match `PORT`.

Vercel/Netlify alone won't work — they don't host long-lived WebSocket
servers. If you must use Vercel for the client, deploy `client/dist` there and
run the server on Render, then point the client at it (change the WS URL in
`client/src/net.ts`).

## Why this networking stack (and not X)

**Plain `ws` WebSockets with a server-authoritative room model.** Considered:

- **PeerJS / WebRTC-P2P host-authoritative** — free hosting (no server), but
  NAT traversal fails for a meaningful slice of home networks without a TURN
  server (which isn't free), and the host leaving kills the session or forces
  hairy host migration. Rejected for reliability.
- **Colyseus / PartyKit** — excellent, but they add a framework and (for
  PartyKit) a platform dependency for what is here ~300 lines of room logic.
  Rejected for deployability-simplicity: one `npm start` process wins.
- **Socket.IO** — adds fallbacks (long-polling) we don't need in 2026 and a
  fatter wire format. Plain `ws` is smaller and does the job.

Consequences of server-authority: there is no privileged "host" client — the
code creator is just player #1 — so **anyone can disconnect (including the
host) and the session lives on**. No host migration needed by design. The
entity AI runs on the server, so all players share one coherent monster.
WebRTC *is* used, but only for voice, with the WebSocket as signalling.

Sync details: clients send position at 12.5 Hz; the server rebroadcasts room
state at 10 Hz; remote players render 150 ms in the past with snapshot
interpolation (no teleporting, no jitter). The world needs no sync at all —
it's a pure function of the seed.

## Architecture

```
shared/src/     worldgen.ts   deterministic infinite maze (walls, archetypes,
                              exit, pickups, spawns, collision, line-of-sight)
                protocol.ts   the complete wire protocol (typed)
                rng.ts        hashing — the universe derives from this
server/src/     index.ts      http static host + ws upgrade + room registry
                room.ts       sessions: join/leave, relay, win/wipe, rounds
                entity.ts     the hunter: A* pathing, isolation targeting
                testbot.ts    headless test player (see below)
client/src/     game.ts       the conductor
                world.ts      chunked renderer, instanced meshes, light pool
                player.ts     movement, stamina, head-bob, flashlight
                avatars.ts    remote players, headlamps, occlusion nametags
                entityView.ts the thing, client-side
                audio.ts      100% synthesized: hum, footsteps, dread
                voice.ts      proximity WebRTC voice + entity interference
                fx.ts         bloom + grain/grade/aberration/VHS shader
                chalk.ts      synced wall marks
                map.ts        the TAB mental map
                ui.ts         title/HUD/overlays
```

Level 0 is an infinite grid of 4 m cells in 32 m blocks: always-open hall
lattice every 8 cells (so the maze is provably connected), block interiors
filled per-archetype — open plains, random-walled rooms, pillar halls,
cubicle farms (low walls the entity steps over), tiled pool blocks, and rare
landmark blocks (a lone chair, filing cabinets, scrawled writing, almond-water
shrines, and somewhere out there: the exit).

Performance: instanced meshes per chunk, a pool of 10 real point lights
assigned to the nearest fixtures each frame, chunk load/unload around the
player, fog-bounded draw distance. Targets 60 fps at 8 players.

## Testing multiplayer without friends

```bash
# with `npm run dev` running and a hosted room:
npx tsx server/src/testbot.ts MOIST-7431 60
```

A headless player joins your room for 60s, walks in circles, drops a chalk
mark, says hello (proximity chat — you'll only see it if you're close), and
logs everything the server tells it, including entity activity.

## Rounds

Win (everyone through the exit) or wipe (everyone taken), then **GO BACK IN**:
same crew, same code, a *new* maze (the seed is `code:round`). Chalk resets;
grudges persist.

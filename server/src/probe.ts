// One-off design probes: findability, sparseness, trap bugs.
import { spawnPoint, breakerSpots, blockArchetype, almondAt, shelfAt, CELL } from '../../shared/src/worldgen.js';

let worst = 0, sum = 0, n = 0;
for (let seed = 1; seed <= 40; seed++) {
  for (let i = 0; i < 4; i++) {
    const sp = spawnPoint(seed, i);
    const d = Math.min(...breakerSpots(seed).map((b) => Math.hypot(b.x - sp.x, b.z - sp.z)));
    sum += d; n++; worst = Math.max(worst, d);
  }
}
console.log(`spawn→nearest breaker: avg ${(sum / n).toFixed(0)}m, worst ${worst.toFixed(0)}m (spark audio radius: 24m!)`);

let plainRuns = 0, checked = 0;
for (let seed = 1; seed <= 20; seed++) {
  for (let bx = -6; bx < 6; bx++) {
    for (let bz = -6; bz < 6; bz++) {
      checked++;
      if (blockArchetype(seed, bx, bz) === 'plain' && blockArchetype(seed, bx + 1, bz) === 'plain') plainRuns++;
    }
  }
}
console.log(`adjacent plain-plain pairs: ${(plainRuns / checked * 100).toFixed(1)}% of blocks (64m of nothing each)`);

let trapped = 0, total = 0;
for (let seed = 1; seed <= 300; seed++) {
  for (let bx = -5; bx < 5; bx++) {
    for (let bz = -5; bz < 5; bz++) {
      const a = almondAt(seed, bx, bz);
      if (!a) continue;
      total++;
      if (shelfAt(seed, Math.floor(a.x / CELL), Math.floor(a.z / CELL))) trapped++;
    }
  }
}
console.log(`almond bottles trapped inside shelves: ${trapped}/${total} (${(trapped / total * 100).toFixed(1)}%)`);

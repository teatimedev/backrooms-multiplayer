const WORDS = [
  'MOIST', 'DAMP', 'YELLOW', 'HUM', 'BUZZ', 'CARPET', 'NOCLIP', 'LIMINAL',
  'ALMOND', 'FLUOR', 'VACANT', 'HOLLOW', 'PALE', 'MURK', 'DRONE', 'STATIC',
  'ECHO', 'DRIFT', 'LOOP', 'GLARE', 'SODIUM', 'OFFICE', 'LOBBY', 'POOL',
  'TILE', 'WANDER', 'LOST', 'DEEP', 'STALE', 'FLICKER', 'VOID', 'MONO',
];

export function makeCode(taken: (c: string) => boolean): string {
  for (let i = 0; i < 200; i++) {
    const w = WORDS[Math.floor(Math.random() * WORDS.length)];
    const n = 1000 + Math.floor(Math.random() * 9000);
    const code = `${w}-${n}`;
    if (!taken(code)) return code;
  }
  return `LOST-${Date.now() % 10000}`;
}

export const normalizeCode = (c: string): string => c.trim().toUpperCase().replace(/\s+/g, '-');

/**
 * WEAPONS's ballistics shot file. Owned by WEAPONS and by nobody else.
 *
 * MUST PROVE: tracer over distance, penetration through a wall, ricochet off steel.
 * The first of those to land is the one the lane was blocked on — a bullet
 * DAMAGING the wall rather than merely passing through it.
 *
 * `ballistics_breach` is not a posed frame. It arms `weapons/proving.ts` through
 * the seed channel, which picks a REAL destructible out of HARBOUR REACH, stands
 * the local player 7.5 m in front of it, and holds the trigger down through the
 * whole capture using the same fire-control state machine a human's mouse
 * drives. Everything the frame shows — the impacts, the spall, the shards — is
 * the consequence of rounds that were actually fired.
 *
 * THE FRAME IS THE WEAKER HALF OF THE PROOF, and deliberately so. Run
 *
 *     CAPTURE_VERBOSE=1 ./tools/shoot.sh ballistics_breach
 *
 * and the `[weapons.proving]` lines report which wall was chosen, its authored
 * health, the health fraction falling per burst, the tick the breach landed on,
 * and a before/after raycast showing the sightline the collapse opened. A number
 * that moves is the proof; the PNG is the illustration.
 *
 * Camera poses elsewhere in this repo are literal coordinates because
 * `ShotContext` cannot reach a service. This one cannot be, because the target
 * is chosen at runtime from LEVEL's own collider list — so the camera is posed
 * from the shot's own knowledge of nothing at all: it is left unposed, and the
 * capture therefore renders the PLAYER'S view, which is exactly the view a human
 * shooting this wall would have.
 */
import { registerShot } from '@/engine/harness';
import { SEED_BREACH } from '@/weapons/proving';
import { forceWeaponState } from '@/weapons/system';

/**
 * Both shots stage the SAME wall the same way, and differ only in what is in the
 * player's hands. That is the whole point of the pair: the wall is a constant,
 * the weapon is the variable, and the two frames are the two halves of the
 * brief — "chip and crack sandstone over several hits, not delete a wall", and
 * "eventually breaches it".
 */
function stage(ctx: Parameters<Parameters<typeof registerShot>[0]['setup']>[0]): void {
  // 0x5745_0001 — 'WE' + scenario 1: arm the breach proving ground. This runs
  // the reset chain, so it must come before anything else that poses state, and
  // any other seed tears the staging back down.
  ctx.seed(SEED_BREACH);
  ctx.setTimeOfDay(17.4);
  ctx.setWeather(0.06, { wind: 4.5, fog: 0.0032 });
  // Viewmodel on, HUD off: the weapon in frame is the point — these are the
  // player's own rounds — and a reticle over the wall is not.
  ctx.setOverlays({ viewmodel: true, hud: false });
}

registerShot({
  name: 'ballistics_wall_chip',
  description:
    'One 30-round magazine of 5.56 into a real HARBOUR REACH brick wall from 7.6 m. ' +
    'The wall is pocked, dusty and STILL STANDING — masonry shrugs off rifle rounds, ' +
    'and each one takes a measured 12.2 hp off 1197. See the [weapons.proving] lines.',
  // 150 ticks at 720 rpm is exactly one magazine and stops short of the 2.95 s
  // reload, so the frame is "what one magazine does" and nothing else.
  frames: 150,
  setup(ctx) {
    stage(ctx);
    // The trigger the fire-control system reads, held for the whole capture.
    // ADS so the cone is 0.19° rather than 2.35° and every round lands on the
    // wall — a damage measurement that half-missed would be measuring spread.
    forceWeaponState({ weapon: 'ar_service', trigger: true, ads: true, adsSettled: true });
  },
});

registerShot({
  name: 'ballistics_breach',
  description:
    'The same wall under the support gun: a 100-round belt at 3.4 kJ a round opens it. ' +
    'Voronoi shards, dust and the sightline it just made — all of it caused by rounds ' +
    'a player fired, through DestructionService. See the [weapons.proving] lines.',
  // The LMG carries 3432 J against the AR's 1549, so it takes 27.3 off brick
  // rather than 12.2 and needs 69 of its 100-round belt for the 1868-hp wall the
  // staging picks. 69 rounds at 650 rpm is 380 ticks; the rest is the collapse.
  // Frames, never wall-clock — this is the same contract every other shot keeps.
  frames: 420,
  setup(ctx) {
    stage(ctx);
    forceWeaponState({ weapon: 'lmg_support', trigger: true, ads: true, adsSettled: true });
  },
});

/**
 * The six viewmodel materials. WEAPONS owns this file.
 *
 * Six is the entire budget. `MaterialFactory.permutationCap` is 24–40 for the
 * whole game and fifteen other lanes are drawing from it, so a weapon that
 * wants twelve materials is a weapon that gets cut. The split is by SHADING
 * BEHAVIOUR, not by part: everything that is a painted-aluminium receiver
 * shades identically whether it is the upper, the rail or the optic housing.
 *
 * Colour choice is doing real work here. A weapon rendered in pure black has no
 * shading information anywhere — it is a silhouette — and a weapon rendered in
 * mid-grey looks like untextured clay. Real service weapons are a very dark
 * desaturated green-grey with a slight warm cast, which keeps enough value
 * range for the golden-hour key to model the form.
 */
import type * as THREE from 'three';
import { MaterialFeature, SurfaceId, type MaterialFactory } from '@/engine/types';
import type { PartRole } from '@/weapons/models/build';

export type RoleMaterials = Readonly<Record<PartRole, THREE.Material>>;

export function buildViewmodelMaterials(materials: MaterialFactory): RoleMaterials {
  const layer = (id: string, surface: SurfaceId): number => {
    const tex = materials.textures(surface);
    return materials.allocateLayer(id, tex.albedoHeight, tex.normalRoughAo);
  };

  // Cerakoted aluminium. Not metal in the PBR sense — the paint is a dielectric
  // over metal, so a low metalness with a tight roughness reads far closer than
  // metalness 1, which would make every unlit face pure black.
  const receiver = materials.create({
    id: 'weapon.receiver',
    surface: SurfaceId.PaintedMetal,
    layer: layer('weapon.receiver', SurfaceId.PaintedMetal),
    features: MaterialFeature.DetailNormal | MaterialFeature.WearMask,
    baseColor: 0x33362f,
    roughness: 0.44,
    metalness: 0.18,
    detailScale: 42,
    wearBias: 0.35,
  });

  // Bare phosphated steel: barrel, bolt, pins, muzzle device. Genuinely metal,
  // and rough enough that the golden-hour key gives it a broad soft highlight
  // rather than a mirror of the sky.
  const steel = materials.create({
    id: 'weapon.steel',
    surface: SurfaceId.BareMetal,
    layer: layer('weapon.steel', SurfaceId.BareMetal),
    features: MaterialFeature.DetailNormal | MaterialFeature.WearMask,
    baseColor: 0x4a4a4c,
    roughness: 0.31,
    metalness: 1.0,
    detailScale: 60,
    wearBias: 0.55,
  });

  // Glass-filled nylon: grip, handguard, magazine, stock furniture. Slightly
  // warmer and lighter than the receiver so the two read as different
  // materials at a glance, which is most of what sells a weapon as assembled.
  const polymer = materials.create({
    id: 'weapon.polymer',
    surface: SurfaceId.Rubber,
    layer: layer('weapon.polymer', SurfaceId.Rubber),
    features: MaterialFeature.DetailNormal,
    baseColor: 0x3c3a33,
    roughness: 0.68,
    metalness: 0.0,
    detailScale: 90,
  });

  // Optic glass. Transparent and DEPTH-WRITE OFF, so the reticle behind it and
  // the world through it both composite correctly. A faint warm tint, because
  // every coated lens has one and a perfectly neutral window reads as a hole.
  const glass = materials.create({
    id: 'weapon.glass',
    surface: SurfaceId.Glass,
    layer: layer('weapon.glass', SurfaceId.Glass),
    features: MaterialFeature.None,
    baseColor: 0x2a3a34,
    roughness: 0.06,
    metalness: 0.0,
    transparent: true,
    depthWrite: false,
    blending: 'alpha',
  });

  // The reticle. This is the one thing in the game that genuinely EMITS, which
  // is what makes additive blending correct here and a defect almost anywhere
  // else. Emissive intensity is well above 1 so it survives the tonemap as a
  // hot dot instead of a dull red smudge.
  const reticle = materials.create({
    id: 'weapon.reticle',
    surface: SurfaceId.Glass,
    layer: layer('weapon.reticle', SurfaceId.Glass),
    features: MaterialFeature.Emissive,
    baseColor: 0x120000,
    emissive: 0xff2a12,
    emissiveIntensity: 14,
    roughness: 1,
    metalness: 0,
    blending: 'additive',
    transparent: true,
    depthWrite: false,
  });

  // Tactical glove. Dead matte, dark, and slightly warmer than the weapon so
  // the hands separate from the receiver instead of merging into one shape.
  const glove = materials.create({
    id: 'weapon.glove',
    surface: SurfaceId.Fabric,
    layer: layer('weapon.glove', SurfaceId.Fabric),
    features: MaterialFeature.DetailNormal,
    baseColor: 0x2e2a25,
    roughness: 0.88,
    metalness: 0.0,
    detailScale: 140,
  });

  return { receiver, steel, polymer, glass, reticle, glove };
}

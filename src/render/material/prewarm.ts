/**
 * Shader prewarm.
 *
 * OWNER: RCORE.
 *
 * A program compiled lazily on first sight costs 20–120 ms on the main thread.
 * Under the capture harness that lands INSIDE a shot's frame budget, so the
 * first few frames of a capture render with a different set of programs than
 * the last few and the PNG changes between runs — the single most expensive
 * class of bug on a project reviewed through screenshots.
 *
 * The compile runs against the REAL scene, not a probe rig, and that is
 * load-bearing: three bakes the light counts into every program
 * (`NUM_DIR_LIGHTS`, `NUM_HEMI_LIGHTS`, shadow map count), so compiling a
 * material under a two-light probe warms a program the frame will never use and
 * the real one still compiles lazily. The probe scene below is the fallback for
 * the case where the scene graph is genuinely empty.
 */
import * as THREE from 'three';
import type { Services } from '@/engine/types';

export async function prewarmMaterials(
  renderer: THREE.WebGLRenderer,
  cache: ReadonlyMap<string, THREE.Material>,
  services: Services | undefined,
): Promise<void> {
  if (cache.size === 0) return;

  const scene = services?.scene.root;
  const camera = services?.camera.state.world;
  if (scene && camera && scene.children.length > 0) {
    renderer.compile(scene, camera);
  }

  // Anything created but not yet placed in the scene — VFX pools, viewmodel
  // parts built before the rig is attached, materials a lane holds for a state
  // it has not entered — still has to be compiled or it hitches on first use.
  const probe = new THREE.Scene();
  if (scene) {
    // Mirror the real light rig so the permutation matches. Copying the lights
    // themselves (rather than inventing a directional + hemisphere pair) is what
    // keeps this from warming the wrong program.
    scene.traverse((o) => {
      const light = o as THREE.Light;
      if (light.isLight) probe.add(light.clone());
    });
  }
  if (probe.children.length === 0) {
    probe.add(new THREE.DirectionalLight(0xffffff, 1));
    probe.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1));
  }
  const probeCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 10);
  probeCamera.position.set(0, 0, 3);
  const geometry = new THREE.PlaneGeometry(1, 1);
  for (const material of cache.values()) {
    probe.add(new THREE.Mesh(geometry, material));
  }
  renderer.compile(probe, probeCamera);
  geometry.dispose();
}

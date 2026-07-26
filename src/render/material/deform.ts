/**
 * THE VERTEX-DEFORM REGISTRY — the motion-vector contract, one level down.
 *
 * OWNER: RCORE.
 *
 * A lane that animates a vertex in a shader registers ONE `DeformChunk` here
 * and names it from `MaterialSpec.deform`. The identical GLSL is then injected
 * into the FORWARD material (`iron-material.ts`), the DEPTH/SHADOW variant and
 * the VELOCITY variant (`variants.ts`), which is what makes it structurally
 * impossible for a palm frond to cast a shadow from where it was last frame or
 * for TAA to treat a moving vertex as static.
 *
 * The registry validates on the way in rather than on the way out: a chunk with
 * an empty `prevPosition`, or one that put statements where an expression
 * belongs, is a shader-compile failure at boot for SIXTEEN lanes at once, and
 * the resulting error message names three's chunk assembler rather than the
 * lane that wrote it.
 */
import type { DeformChunk } from '@/engine/types';

export class DeformChunkRegistry {
  private readonly chunks = new Map<string, DeformChunk>();

  register(name: string, chunk: DeformChunk): void {
    const existing = this.chunks.get(name);
    if (existing !== undefined) {
      if (
        existing.common !== chunk.common ||
        existing.displace !== chunk.displace ||
        existing.prevPosition !== chunk.prevPosition
      ) {
        throw new Error(`MaterialFactory: deform chunk "${name}" registered twice with different GLSL`);
      }
      return;
    }
    if (chunk.displace.trim().length === 0) {
      throw new Error(`MaterialFactory: deform chunk "${name}" has an empty \`displace\` — it moves nothing.`);
    }
    if (chunk.prevPosition.trim().length === 0) {
      throw new Error(
        `MaterialFactory: deform chunk "${name}" has an empty \`prevPosition\`. It must be a vec3 ` +
          `EXPRESSION giving this vertex under last frame's uniforms — write \`position\` if the ` +
          `vertex genuinely does not move, but do not leave it blank: the velocity pass would write ` +
          `zero and TAA would treat moving geometry as static.`,
      );
    }
    if (chunk.prevPosition.includes(';')) {
      throw new Error(
        `MaterialFactory: deform chunk "${name}" \`prevPosition\` contains ';' — it is an EXPRESSION, ` +
          `not statements. Put helpers in \`common\`.`,
      );
    }
    this.chunks.set(name, chunk);
  }

  get(name: string): DeformChunk | undefined {
    return this.chunks.get(name);
  }

  has(name: string): boolean {
    return this.chunks.has(name);
  }

  get all(): ReadonlyMap<string, DeformChunk> {
    return this.chunks;
  }
}

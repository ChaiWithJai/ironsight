/**
 * The service registry. CORE owns this file.
 *
 * Typed fields rather than string lookups, so a missing dependency is a COMPILE
 * error and not a runtime `undefined` three lanes downstream.
 *
 * Reading a service before it has been constructed throws with a message that
 * names the fix — add it to your `SubsystemDescriptor.dependsOn`. That turns the
 * single most likely boot mistake (a factory reaching for a service that has not
 * been built yet) into an immediate, self-explaining failure instead of a
 * `Cannot read properties of undefined` in someone else's file.
 */
import type { ServiceKey, ServiceRegistry, Services } from '@/engine/types';
import { isNullInstance } from '@/bootstrap/nulls';

/**
 * Every key in `Services`, in a fixed order. This is the only place the key
 * list is written out; `Services` itself is the type-level source of truth and
 * TypeScript verifies the two agree via the `satisfies` check below.
 */
export const SERVICE_KEYS = [
  'clock', 'rng', 'quality', 'profiler', 'input', 'events', 'fx', 'entities', 'scene',
  'assets', 'materials',
  'renderer', 'graph', 'camera', 'lighting',
  'sky', 'terrain', 'water', 'vegetation', 'level',
  'physics', 'destruction',
  'weapons', 'ballistics', 'viewmodel',
  'vfx', 'audio', 'hud',
  'nav', 'ai', 'player', 'mode', 'debug',
] as const satisfies readonly ServiceKey[];

// If a lane adds a service to `Services` without adding it here, this line stops
// compiling — which is exactly when we want to find out.
type _AllKeysListed = Exclude<ServiceKey, (typeof SERVICE_KEYS)[number]> extends never ? true : never;
const _allKeysListed: _AllKeysListed = true;
void _allKeysListed;

export class EngineServiceRegistry implements ServiceRegistry {
  private readonly backing = new Map<ServiceKey, unknown>();
  readonly all: Services;

  constructor() {
    const view = {} as Record<ServiceKey, unknown>;
    for (const key of SERVICE_KEYS) {
      Object.defineProperty(view, key, {
        enumerable: true,
        get: () => {
          const value = this.backing.get(key);
          if (value === undefined) {
            throw new Error(
              `service "${key}" was read before it was constructed. ` +
                `Add "${key}" to your SubsystemDescriptor.dependsOn, or defer the read to a tick/render system.`,
            );
          }
          return value;
        },
      });
    }
    this.all = view as unknown as Services;
  }

  get<K extends ServiceKey>(key: K): Services[K] {
    return this.all[key];
  }

  tryGet<K extends ServiceKey>(key: K): Services[K] | undefined {
    return this.backing.get(key) as Services[K] | undefined;
  }

  provide<K extends ServiceKey>(key: K, impl: Services[K]): void {
    if (impl === undefined || impl === null) {
      throw new Error(`service "${key}" was provided as ${String(impl)}`);
    }
    this.backing.set(key, impl);
  }

  /**
   * True while `key` still resolves to a null implementation from
   * `src/bootstrap/nulls.ts`. A lane's stub wraps its null in `trackNull()`;
   * when the lane ships and replaces the body of that file, the wrapper goes
   * with it and this answer becomes correct with nothing to maintain.
   */
  isNull(key: ServiceKey): boolean {
    return isNullInstance(this.backing.get(key));
  }

  has(key: ServiceKey): boolean {
    return this.backing.has(key);
  }

  /** Keys still resolving to a null, for the debug overlay and the boot log. */
  nullKeys(): ServiceKey[] {
    return SERVICE_KEYS.filter((k) => this.isNull(k));
  }
}

export function createServiceRegistry(): EngineServiceRegistry {
  return new EngineServiceRegistry();
}

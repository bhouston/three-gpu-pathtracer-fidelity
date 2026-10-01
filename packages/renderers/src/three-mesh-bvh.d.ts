// Exports of three-mesh-bvh/webgpu that its type declarations lack.
import 'three-mesh-bvh/webgpu'; // makes this file a module, so the declarations below augment instead of replace
declare module 'three-mesh-bvh/webgpu' {
  export const rayStruct: unknown;
  export const rayIntersectionResultStruct: unknown;
  // oxlint-disable-next-line typescript/no-explicit-any -- returns a TSL function node called with node arguments
  export function wgslTagFn(strings: TemplateStringsArray, ...values: unknown[]): (...args: unknown[]) => any;
}

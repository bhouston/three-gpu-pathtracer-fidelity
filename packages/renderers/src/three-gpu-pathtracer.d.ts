// Exports of three-gpu-pathtracer that its type declarations lack.
import type { ShaderMaterial } from 'three';
import 'three-gpu-pathtracer'; // makes this file a module, so the declarations below augment instead of replace
declare module 'three-gpu-pathtracer' {
  export class PhysicalPathTracingMaterial extends ShaderMaterial {}
  export class AmbientOcclusionMaterial extends ShaderMaterial {
    constructor(parameters?: { radius?: number });
  }
}

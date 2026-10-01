This viewer validates the new WebGPU-based [three-gpu-pathtracer](https://github.com/bhouston/three-gpu-pathtracer) against two references: [Blender Cycles](https://www.blender.org/) and the established WebGL implementation of the same path tracer. Every scene is rendered by each renderer, then diffed and scored.

**Available renderers:**

- `blender` — Reference — [Blender Cycles](https://www.blender.org/), an independent production path tracer.
- `webgl-legacy` — Reference — **WebGL Legacy**: the established WebGL `WebGLPathTracer` of three-gpu-pathtracer.
- `webgpu-new` — Under test — **WebGPU New**: the new WebGPU `WebGPUPathTracer` of three-gpu-pathtracer.

Use the viewer controls to choose the reference renderer, Blender or WebGL Legacy, to compare against. Select a scene for a closer look. Delta images and error metrics show where WebGPU New departs from the reference; some renderers may not have results for every scene yet.

The two reference renderers are not identical either, so differences between WebGPU New and one reference are most meaningful when the other reference agrees with it.

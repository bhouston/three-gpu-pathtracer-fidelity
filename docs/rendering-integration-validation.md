# Fidelity-kit integration validation

The suite pins `fidelity-kit-blender` and `fidelity-kit-three-gpu-pathtracer` as submodules and consumes them as
workspace packages. The latter uses the suite's existing pathtracer fork, not its nested development checkout.
Both are built before the suite. Root tests include both adapters' unit tests; their optional GPU/Blender tests
remain opt-in. The single-Three.js resolution test covers both new packages.

## Actual render checks

Test renders were written outside the committed baseline, under `/tmp/fidelity-kit-adoption-renders`.
The following scenes produced decodable, nonconstant AVIF images in **both Blender and legacy WebGL**, at 16 spp:

| Scene                      | Dimensions | Exercises                                                |
| -------------------------- | ---------- | -------------------------------------------------------- |
| `gi-room-low-albedo`       | 480 × 360  | Point lighting, weak indirect transport, no tone mapping |
| `gi-room-high-albedo`      | 480 × 360  | Strong multibounce indirect transport                    |
| `khronos-BoxTextured`      | 768 × 768  | glTF material textures and HDR environment               |
| `khronos-TransmissionTest` | 768 × 700  | Physical transmission materials and texture export       |

```sh
pnpm build
pnpm cli render --scenes 'gi-room-*,khronos-BoxTextured,khronos-TransmissionTest' \
  --renderers 'blender,webgl-legacy' --samples 16 --output /tmp/fidelity-kit-adoption-renders
```

A separate 64 × 64 sphere render exercised a procedural `RoomEnvironment` and explicit linear gradient background
in both integrations at 16 spp. Both produced opaque, lit sphere images with the gradient visible. A 4 spp
`webgpu-new` render of `gi-room-low-albedo` also succeeded after the shared geometry utility replacement.
`model-flight-helmet` rendered successfully in WebGL at 16 spp.

Images were decoded, dimensions and channel statistics checked, and visually inspected. The room, box and
transmission pairs have matching framing and recognizable materials, with visible brightness/transport differences.
These are smoke tests, not a high-sample fidelity certification or a claim of pixel identity.

## Optional adapter features and staged-scene checks

Upstream PR [fidelity-kit-blender #8](https://github.com/bhouston/fidelity-kit-blender/pull/8) added optional area-light,
physical-camera depth-of-field and independent background-image translations. Both upstream CI runs passed and
the PR was merged; the suite pins that merged commit and enables all three features by default.

The standalone adapter passes build, types, lint, Python compilation, unit tests with coverage and a clean audit.
With `BLENDER_INTEGRATION=1`, all 25 tests passed, including real CPU renders demonstrating proportional area-light
radiance, elliptical emission, actual defocus and independent background rotation. Line coverage was 89.89%.

Initially, staged models failed on separate background textures and `gi-basic` failed on finite light cutoffs.
The feature extension resolves the background limitation. This suite deliberately warns and ignores ambient lights
and finite light cutoffs, matching the reference pathtracer. Other unsupported features remain strict errors.

CPU smoke renders at 4 spp succeeded for `gi-basic`, `model-flight-helmet`, `model-tropical-island` and
`model-coffee-maker`, preserving their independent background images. `model-sasha-ring` (area-light stage)
and `model-magie-noire-perfume` (area lights plus physical-camera depth of field) also rendered at 4 spp on CPU. GPU smoke renders succeeded earlier for
the flight helmet and island; subsequent runs hit Metal out-of-memory errors while other GPU work was active.
The new `--blender-device cpu` flag allows explicit CPU selection; `auto` remains the default.

Custom shaders, nonphysical decay, blurred/GPU-only backgrounds and anamorphic depth of field remain unsupported.
Animated skin/morph matching and advanced glTF extension behavior need further visual validation.
Existing committed images still come from the previous pipeline; regenerate them without `--missing-only`,
then process metrics and deltas together.

## Existing CI fixture repairs

The baseline `main` CI already failed on DOM-dependent Collada image loading and unresolved embedded LDraw
subparts. Collada images now decode to readable RGBA DataTextures in Node, and their decodes finish before the
scene returns. Embedded LDraw FILE names now use the same normalized path keys as references. Small regression
fixtures and the existing Apollo/B-wing registry scenarios pass. Large registry scenarios have a 300-second
per-scene timeout, accounting for coverage overhead without skipping them.

## Dependency audit

The audit reported three high-severity advisories in the existing pathtracer development dependency chain:
`extract-zip@2.0.1` (two symlink traversal/write advisories) and `basic-ftp@5.3.1` (directory-listing parser denial
of service), reached through Puppeteer. These versions were already present in the baseline lockfile; the new
adapters did not introduce them. CI retains its existing audit-warning policy.

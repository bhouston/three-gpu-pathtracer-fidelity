# Active development moved to three-fidelity

The canonical project is https://github.com/bhouston/three-fidelity and its viewer is https://three-fidelity.ben3d.ca/. The migration accounts for all 200 scene definitions and 545 saved images from snapshot 2521bd4978e59c173946e3816bdf21915d2d2bb9, with explicit scene/renderer mappings, original dimensions and SHA-256 hashes in migration/pathtracer-history.json.

Legacy scene queries, renderer selections, reference IDs and comparison hashes are mapped to the canonical viewer. The old landing page opens imported path-tracer comparisons. All original data/<scene>/beauty/<renderer>.avif URLs remain available from the retired site with exact bytes. Original code, captures, licenses and asset pins remain in this repository. Per-image generator revisions/sample counts were not recorded and are not inferred from the saved snapshot.

The old application build/quality pipeline is manual archival validation. Active CI and deployment build/test the redirect site without the old rendering dependencies. Historical DockerGrid/software-GPU documentation is retained as history; use the unified project's current distributed capture instructions and real hardware GPU validation.

Validate with node --test scripts/legacy-links.test.mjs and build with node scripts/build-legacy-redirect.mjs --source --out site/. Retirement is merged only after the unified deployment exposes the migrated scenes and images.

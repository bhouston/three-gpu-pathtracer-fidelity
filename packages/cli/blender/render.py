# Renders a scene exported by packages/cli/src/blender.ts with Cycles into a linear, premultiplied RGBA EXR.
# Usage: blender --background --factory-startup --python render.py -- job.json
import json
import sys

import bpy

job = json.load(open(sys.argv[sys.argv.index("--") + 1]))

bpy.ops.wm.read_factory_settings(use_empty=True)
# COMPAT: three.js units (sun W/m² = lux, point W = cd * 4π)
bpy.ops.import_scene.gltf(filepath=job["glb"], export_import_convert_lighting_mode="COMPAT")
scene = bpy.context.scene
scene.camera = bpy.data.objects["ss_fidelity_camera"]
scene.camera.data.clip_end = 1e6  # the pathtracer has no far plane
for light in bpy.data.lights:  # glTF (and three.js) lights are punctual
    light.shadow_soft_size = 0
    if light.type == "SUN":
        light.angle = 0

# three.js culls back faces of single-sided materials (and the pathtracer skips them): make them transparent
for material in bpy.data.materials:
    if not material.use_backface_culling or not material.node_tree:
        continue
    tree = material.node_tree
    surface = next(node for node in tree.nodes if node.type == "OUTPUT_MATERIAL").inputs["Surface"]
    shader = surface.links[0].from_socket
    mix = tree.nodes.new("ShaderNodeMixShader")
    tree.links.new(tree.nodes.new("ShaderNodeNewGeometry").outputs["Backfacing"], mix.inputs["Fac"])
    tree.links.new(shader, mix.inputs[1])
    tree.links.new(tree.nodes.new("ShaderNodeBsdfTransparent").outputs["BSDF"], mix.inputs[2])
    tree.links.new(mix.outputs["Shader"], surface)

world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
background = world.node_tree.nodes["Background"]
environment = job.get("environment")
if environment:
    texture = world.node_tree.nodes.new("ShaderNodeTexEnvironment")
    texture.image = bpy.data.images.load(environment["path"])
    world.node_tree.links.new(texture.outputs["Color"], background.inputs["Color"])
    background.inputs["Strength"].default_value = environment["intensity"]
else:
    background.inputs["Color"].default_value = (0, 0, 0, 1)

scene.render.engine = "CYCLES"
cycles = scene.cycles
cycles.samples = job["samples"]
# adaptive sampling only stops sampling a pixel early once it has converged within the threshold: free speed, no bias
cycles.use_adaptive_sampling = True
cycles.adaptive_threshold = 0.01
cycles.use_denoising = False
bounces = job["bounces"]
cycles.max_bounces = bounces
cycles.diffuse_bounces = bounces
cycles.glossy_bounces = bounces
cycles.transmission_bounces = bounces
if bounces == 0:  # direct: like the pathtracer, emissive surfaces are seen (camera rays) but light nothing
    for material in bpy.data.materials:
        tree = material.node_tree
        for node in list(tree.nodes) if tree else []:
            strength = node.inputs.get("Emission Strength") if node.type == "BSDF_PRINCIPLED" else None
            if strength is None or strength.is_linked:
                continue
            multiply = tree.nodes.new("ShaderNodeMath")
            multiply.operation = "MULTIPLY"
            multiply.inputs[1].default_value = strength.default_value
            tree.links.new(tree.nodes.new("ShaderNodeLightPath").outputs["Is Camera Ray"], multiply.inputs[0])
            tree.links.new(multiply.outputs["Value"], strength)
# unbiased, like the pathtracer (filterGlossyFactor 0, no clamping), box-filtered pixels
cycles.sample_clamp_direct = 0
cycles.sample_clamp_indirect = 0
cycles.blur_glossy = 0
cycles.caustics_reflective = True
cycles.caustics_refractive = True
cycles.pixel_filter_type = "BOX"
cycles.filter_width = 1

preferences = bpy.context.preferences.addons["cycles"].preferences
for device_type in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
    try:
        preferences.compute_device_type = device_type
    except TypeError:
        continue
    preferences.get_devices()
    if any(device.type == device_type for device in preferences.devices):
        for device in preferences.devices:
            device.use = True
        cycles.device = "GPU"
        break

render = scene.render
render.film_transparent = job["transparent"]
render.resolution_x = job["width"]
render.resolution_y = job["height"]
render.resolution_percentage = 100
render.image_settings.file_format = "OPEN_EXR"
render.image_settings.color_depth = "32"
render.image_settings.color_mode = "RGBA"
render.filepath = job["output"]
bpy.ops.render.render(write_still=True)

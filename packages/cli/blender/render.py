# Renders a scene exported by packages/cli/src/blender.ts with Cycles into a linear, premultiplied RGBA EXR.
# Usage: blender --background --factory-startup --python render.py -- job.json
import json
import math
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

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

# area lights, from three.js world space: Y up -> Z up as the glTF importer does; both emit along local -Z
Y_UP_TO_Z_UP = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
for i, area in enumerate(job["areaLights"]):
    light = bpy.data.lights.new(f"ss_fidelity_area_{i}", "AREA")
    light.shape = "ELLIPSE" if area["circular"] else "RECTANGLE"
    light.size = area["width"]
    light.size_y = area["height"]
    light.color = area["color"]
    # Cycles: radiance = power / (pi * area); the pathtracer's radiance is color * intensity
    surface = area["width"] * area["height"] * (math.pi / 4 if area["circular"] else 1)
    light.energy = area["intensity"] * surface * math.pi
    obj = bpy.data.objects.new(light.name, light)
    obj.visible_camera = False  # the pathtracer's lights are hit only by bounced rays
    x, y, z, w = area["quaternion"]
    rotation = Y_UP_TO_Z_UP @ Quaternion((w, x, y, z)).to_matrix()
    obj.matrix_world = Matrix.Translation(Y_UP_TO_Z_UP @ Vector(area["position"])) @ rotation.to_4x4()
    bpy.context.scene.collection.objects.link(obj)

dof = job.get("dof")
if dof:
    camera = scene.camera.data
    camera.dof.use_dof = True
    camera.dof.focus_distance = dof["focusDistance"]
    # Cycles' aperture radius is lens / (2 * fstop) (lens in mm): the pathtracer's is bokehSize / 2 mm
    camera.dof.aperture_fstop = camera.lens / dof["bokehSize"]

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
backdrop = job.get("background")
if backdrop:
    # like the pathtracer, camera rays and rays that only passed through transmission see the background
    nodes, links = world.node_tree.nodes, world.node_tree.links
    texture = nodes.new("ShaderNodeTexEnvironment")
    texture.image = bpy.data.images.load(backdrop["path"])
    shader = nodes.new("ShaderNodeBackground")
    links.new(texture.outputs["Color"], shader.inputs["Color"])
    shader.inputs["Strength"].default_value = backdrop["intensity"]
    # Cycles counts the miss itself as a bounce: Ray Depth is 1 for a camera ray, 1 + transmission depth through glass
    path = nodes.new("ShaderNodeLightPath")
    depth = nodes.new("ShaderNodeMath")
    depth.operation = "SUBTRACT"
    links.new(path.outputs["Ray Depth"], depth.inputs[0])
    links.new(path.outputs["Transmission Depth"], depth.inputs[1])
    seen = nodes.new("ShaderNodeMath")
    seen.operation = "COMPARE"
    seen.inputs[1].default_value = 1
    seen.inputs[2].default_value = 0.5
    links.new(depth.outputs["Value"], seen.inputs[0])
    mix = nodes.new("ShaderNodeMixShader")
    links.new(seen.outputs["Value"], mix.inputs["Fac"])
    links.new(background.outputs["Background"], mix.inputs[1])
    links.new(shader.outputs["Background"], mix.inputs[2])
    links.new(mix.outputs["Shader"], nodes["World Output"].inputs["Surface"])

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

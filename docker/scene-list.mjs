import { existsSync } from 'node:fs';
import { listSceneNames } from '../packages/scenes/dist/index.js';
const full = existsSync('submodules/glTF-Sample-Assets/Models') && existsSync('submodules/3d-demo-data/models');
console.log(JSON.stringify(listSceneNames().filter((name) => full || name.startsWith('gi-'))));

import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { allEmoteAssetFiles } from '../src/shared/emotes';
import { allSoundNames, allTextureNames } from '../src/shared/pings';

/**
 * Vite copies all of assets/ (publicDir) into the build. This removes the textures and sounds that no ping uses,
 * such as the colourblind icons and the unused SRP sounds, and any emote file the catalog doesn't list, so they don't
 * ship in the installer or on the site.
 */
export function pruneAssets(): Plugin {
  let outDir = '';
  return {
    name: 'lolping-prune-assets',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const keep: Record<string, Set<string>> = {
        textures: new Set(allTextureNames().map((n) => `${n}.png`)),
        sounds: new Set(allSoundNames().map((n) => `${n}.wav`)),
        emotes: new Set(allEmoteAssetFiles().map((f) => f.slice('emotes/'.length))),
      };
      for (const [dir, names] of Object.entries(keep)) {
        for (const file of readdirSync(join(outDir, dir))) {
          if (!names.has(file)) rmSync(join(outDir, dir, file));
        }
      }
    },
  };
}

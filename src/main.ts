import Phaser from 'phaser';
import mapUrl from '../assets/maps/processed/misleny-kozpont.json?url';
import { loadGameMap } from './game/maps/GameMap';
import { pickPpm, VIEW_METERS } from './game/quality';
import { GameScene } from './game/scenes/GameScene';
import { setupFullscreen } from './game/ui/fullscreen';

async function start(): Promise<void> {
  setupFullscreen();
  const map = await loadGameMap(mapUrl);
  const { ppm } = pickPpm();

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    // A látómező 160 × 90 méter; a belső felbontás a részletességtől függ
    // (12 pixel/méternél Full HD). Más ablakméretnél a kép arányosan méreteződik.
    width: VIEW_METERS.width * ppm,
    height: VIEW_METERS.height * ppm,
    backgroundColor: '#101418',
    antialias: true, // textúraszűrés a forgatott sprite-okhoz
    antialiasGL: false, // teljes képernyős élsimítás (MSAA) nem kell: fölösleges teher a videokártyának
    roundPixels: true,
    powerPreference: 'high-performance', // két videokártyás gépen az erősebbet kérjük
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    audio: { noAudio: true }, // a hangokat saját Web Audio szintetizátor adja
  });
  game.scene.add('game', GameScene, true, { map, ppm });

  // hibakereséshez és automata tesztekhez
  (window as unknown as { __TANK__: Phaser.Game }).__TANK__ = game;
}

start().catch((err: unknown) => {
  console.error(err);
  const loading = document.getElementById('loading');
  if (loading) loading.textContent = `Hiba a pálya betöltésekor: ${err instanceof Error ? err.message : String(err)}`;
});

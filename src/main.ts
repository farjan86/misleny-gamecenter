// Belépési pont: betölti a pályát, megnyitja a menüt, és amikor a szerver
// elindít egy meccset, elindítja a játékjelenetet. A meccs végén az eredmény a
// játék képe fölött jelenik meg; a menübe visszatérve az oldal újratöltődik,
// így minden meccs tiszta állapotból indul.

import Phaser from 'phaser';
import mapUrl from '../assets/maps/processed/misleny-kozpont.json?url';
import { loadGameMap } from './game/maps/GameMap';
import { ClientWorld } from './game/net/ClientWorld';
import { NetClient } from './game/net/NetClient';
import type { ServerMessage } from './game/net/protocol';
import { pickPpm, VIEW_METERS } from './game/quality';
import { GameScene, type GameSceneData } from './game/scenes/GameScene';
import { loadSettings } from './game/settings';
import { Menu } from './game/ui/Menu';

async function start(): Promise<void> {
  const map = await loadGameMap(mapUrl);
  const net = new NetClient();
  const menu = new Menu(map, net, loadSettings());
  let game: Phaser.Game | null = null;
  let world: ClientWorld | null = null;
  let finished = false;

  const startGame = (message: Extract<ServerMessage, { t: 'start' }>): void => {
    if (game) return;
    const { settings } = message.room;
    // a pálya a meccs beállításai szerint: játéktér és időjárás
    map.setArea(settings.area);
    map.weather = settings.weather;
    world = new ClientWorld(map, net, message.room, message.tank, message.players);
    menu.hide();

    const { ppm } = pickPpm();
    game = new Phaser.Game({
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
    const data: GameSceneData = {
      map,
      ppm,
      world,
      keys: loadSettings().keys,
      onLeave: () => net.send({ t: 'leave' }),
    };
    game.scene.add('game', GameScene, true, data);
    // hibakereséshez és automata tesztekhez
    (window as unknown as { __TANK__: Phaser.Game }).__TANK__ = game;
  };

  net.on((message) => {
    switch (message.t) {
      case 'start':
        startGame(message);
        break;
      case 'snap':
        world?.receive(message, performance.now());
        break;
      case 'ev':
        world?.receiveEvents(message.e);
        break;
      case 'over':
        finished = true;
        menu.showResults(message.winner, message.standings, net.id);
        break;
      case 'left':
        // meccs közben kilépett: vissza a játékok listájához
        if (game && !finished) Menu.reloadTo('lobby');
        break;
    }
  });
  net.onStatus((status) => {
    if (status !== 'offline' || !game || finished) return;
    menu.error('Megszakadt a kapcsolat a szerverrel.');
    window.setTimeout(() => Menu.reloadTo('main'), 2500);
  });
}

start().catch((err: unknown) => {
  console.error(err);
  const status = document.getElementById('server-status');
  if (status) status.textContent = `Hiba a pálya betöltésekor: ${err instanceof Error ? err.message : String(err)}`;
});

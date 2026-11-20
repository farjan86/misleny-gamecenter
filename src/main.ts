// Belépési pont: betölti a pályát, megnyitja a menüt, és amikor a szerver
// elindít egy meccset, elindítja a játékjelenetet. A meccs végén az eredmény a
// játék képe fölött jelenik meg; a menübe visszatérve az oldal újratöltődik,
// így minden meccs tiszta állapotból indul.

import Phaser from 'phaser';
import mapUrl from '../assets/maps/processed/misleny-kozpont.json?url';
import { loadGameMap } from './game/maps/GameMap';
import { ClientWorld } from './game/net/ClientWorld';
import { LocalGame, type GameLink } from './game/net/LocalGame';
import { NetClient } from './game/net/NetClient';
import type { ServerMessage } from './game/net/protocol';
import { pickPpm, canvasSize } from './game/quality';
import { GameScene, type GameSceneData } from './game/scenes/GameScene';
import { loadSettings } from './game/settings';
import { Voice } from './game/systems/voice';
import { GameChat } from './game/ui/GameChat';
import { guardLeave } from './game/ui/leaveGuard';
import { VERSION } from './game/version';
import { Menu } from './game/ui/Menu';

// a verziószám a sarokban: ebből látszik, hogy a böngésző a legfrissebb játékot tölti-e be
const versionBox = document.getElementById('version');
if (versionBox) versionBox.textContent = `v${VERSION}`;

async function start(): Promise<void> {
  const map = await loadGameMap(mapUrl);
  const net = new NetClient();
  const menu = new Menu(map, net, loadSettings());
  let game: Phaser.Game | null = null;
  let world: ClientWorld | null = null;
  let finished = false;
  /** üzenetek és hang a meccsen (csak többjátékos játékban) */
  let chat: GameChat | null = null;
  let voice: Voice | null = null;
  /** a helyi (egyjátékos) játék, ha az fut */
  let local: LocalGame | null = null;

  const startGame = (message: Extract<ServerMessage, { t: 'start' }>, link: GameLink): void => {
    if (game) return;
    const { settings } = message.room;
    // a pálya a meccs beállításai szerint: játéktér és időjárás
    map.setArea(settings.area);
    map.weather = settings.weather;
    world = new ClientWorld(map, link, message.room, message.tank, message.players, message.workshops);
    // meccs közben a böngésző megerősítést kér a lap bezárása előtt (a Ctrl+W ellen)
    guardLeave(true);
    // többjátékos meccsen: üzenetek a többieknek és hang gombnyomásra (a saját szerveren át)
    if (message.players.length > 1) {
      const settings = loadSettings();
      voice = new Voice((d) => link.send({ t: 'voice', d }));
      voice.setVolume(settings.volume / 100);
      chat = new GameChat(settings.keys, (text) => link.send({ t: 'chat', text }), voice);
    }
    menu.hide();

    const { ppm } = pickPpm();
    const size = canvasSize(ppm, window.innerWidth, window.innerHeight);
    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game',
      // A látómező az ablak képarányához igazodik (16:9-en 160 × 90 méter, szélesebb
      // képernyőn oldalra több látszik); a belső felbontás a részletességtől függ.
      width: size.width,
      height: size.height,
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
      volume: loadSettings().volume / 100,
      onLeave: () => link.send({ t: 'leave' }),
    };
    game.scene.add('game', GameScene, true, data);
    // az ablak átméretezésekor (teljes képernyő, másik monitor) a látómező követi az új képarányt
    let resizeTimer = 0;
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const next = canvasSize(ppm, window.innerWidth, window.innerHeight);
        if (game && (next.width !== game.scale.width || next.height !== game.scale.height)) game.scale.setGameSize(next.width, next.height);
      }, 120);
    });
    // hibakereséshez és automata tesztekhez
    (window as unknown as { __TANK__: Phaser.Game }).__TANK__ = game;
  };

  /** A meccs üzenetei – a szerverről és a helyi játékból ugyanúgy érkeznek. */
  const onGameMessage = (message: ServerMessage, link: GameLink, myId: string): void => {
    switch (message.t) {
      case 'start':
        startGame(message, link);
        break;
      case 'snap':
        world?.receive(message, performance.now());
        break;
      case 'ev':
        world?.receiveEvents(message.e);
        break;
      case 'chat':
        chat?.add(message.from, message.text, message.me === true);
        break;
      case 'voice':
        voice?.receive(message.from, message.d);
        break;
      case 'over':
        finished = true;
        guardLeave(false);
        chat?.dispose();
        menu.showResults(message.winner, message.standings, myId);
        break;
      case 'left':
        // meccs közben kilépett: vissza a játékok listájához (egyjátékos módból a főképernyőre)
        if (game && !finished) Menu.reloadTo(menu.afterMatch);
        break;
    }
  };
  net.on((message) => {
    if (!local) onGameMessage(message, net, net.id);
  });

  // Egyjátékos mód: a meccs a böngészőben fut, szerver nélkül.
  menu.onSingle = (settings, name) => {
    if (game || local) return;
    const single = new LocalGame(map.data, name);
    local = single;
    // diagnosztikához és az automata próbákhoz (mint a __TANK__)
    (window as unknown as { __TANK_LOCAL__: LocalGame }).__TANK_LOCAL__ = single;
    menu.afterMatch = 'main';
    single.on((message) => onGameMessage(message, single, single.id));
    single.start(settings, loadSettings().look);
    // a szerver statisztikája innen tudja, hogy egyjátékos meccs megy (a meccs maga a böngészőben fut)
    net.send({ t: 'solo' });
  };

  net.onStatus((status) => {
    // a helyi játékot nem érinti, ha a szerver elérhetetlen
    if (status !== 'offline' || !game || finished || local) return;
    menu.error('Megszakadt a kapcsolat a szerverrel.');
    window.setTimeout(() => Menu.reloadTo('main'), 2500);
  });
}

start().catch((err: unknown) => {
  console.error(err);
  const status = document.getElementById('server-status');
  if (status) status.textContent = `Hiba a pálya betöltésekor: ${err instanceof Error ? err.message : String(err)}`;
});

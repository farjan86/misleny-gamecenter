// Az útburkolatra festett utcanevek megjelenítése. A feliratok helye előre
// kiszámolt (roadLabels.ts), de a szövegobjektum – és a hozzá tartozó textúra –
// csak akkor jön létre, amikor a felirat a kamera közelébe kerül, és törlődik,
// ha messzire kerül. Így a pálya összes felirata helyett egyszerre csak néhány él.

import Phaser from 'phaser';
import type { GameMap } from './GameMap';
import { placeRoadLabels, type RoadLabel } from './roadLabels';

/** betűmagasság méterben */
const HEIGHT_M = 2.1;
/** ennyi pixellel a látómezőn túl jön létre, illetve ennek kétszeresén túl törlődik a felirat */
const MARGIN_PX = 300;
/** ennyi képkockánként vizsgáljuk újra */
const CHECK_EVERY = 10;

interface Entry {
  label: RoadLabel;
  x: number;
  y: number;
  text: Phaser.GameObjects.Text | null;
}

export class RoadLabelLayer {
  private readonly entries: Entry[];
  private frame = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    map: GameMap,
    private readonly ppm: number,
  ) {
    this.entries = placeRoadLabels(map).map((label) => ({ label, x: label.x * ppm, y: label.y * ppm, text: null }));
  }

  get count(): number {
    return this.entries.length;
  }

  update(view: Phaser.Geom.Rectangle): void {
    if (this.frame++ % CHECK_EVERY !== 0) return;
    for (const e of this.entries) {
      const dx = Math.max(view.x - e.x, 0, e.x - view.right);
      const dy = Math.max(view.y - e.y, 0, e.y - view.bottom);
      if (!e.text && dx < MARGIN_PX && dy < MARGIN_PX) {
        e.text = this.scene.add
          .text(e.x, e.y, e.label.text.toUpperCase(), {
            fontFamily: '"Arial Narrow", "Roboto Condensed", Arial, sans-serif',
            fontStyle: 'bold',
            fontSize: `${Math.round(HEIGHT_M * this.ppm)}px`,
            color: '#efecdc',
          })
          .setOrigin(0.5)
          .setRotation(e.label.angle)
          .setAlpha(0.72)
          .setDepth(1);
      } else if (e.text && (dx > MARGIN_PX * 2 || dy > MARGIN_PX * 2)) {
        e.text.destroy();
        e.text = null;
      }
    }
  }
}

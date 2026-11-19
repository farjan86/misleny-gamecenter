// Az útburkolatra írt utcanevek helyének kiszámítása: utcánként bizonyos
// távolságonként egy felirat, mindig egy elég egyenes útszakaszra, az út
// irányában. Tiszta számítás (nincs Phaser-függés).

import type { GameMap } from './GameMap';

export interface RoadLabel {
  text: string;
  /** a felirat közepe méterben */
  x: number;
  y: number;
  /** a szöveg iránya radiánban, mindig olvasható (−90°..90°) állásban */
  angle: number;
}

export interface RoadLabelOptions {
  /** két felirat távolsága ugyanazon az úton, méterben */
  spacing: number;
  /** egy betű becsült szélessége méterben */
  charWidth: number;
}

const LABELLED = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian']);
/** Felezővonalas utak: itt a felirat az egyik sáv közepére kerül. */
const CENTRE_LINE = new Set(['primary', 'secondary', 'tertiary']);

function pointAt(pts: ArrayLike<number>, cum: number[], dist: number): [number, number] {
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < dist) i++;
  const seg = cum[i + 1] - cum[i];
  const t = seg > 0 ? (dist - cum[i]) / seg : 0;
  return [pts[i * 2] + (pts[i * 2 + 2] - pts[i * 2]) * t, pts[i * 2 + 1] + (pts[i * 2 + 3] - pts[i * 2 + 1]) * t];
}

export function placeRoadLabels(map: GameMap, options: RoadLabelOptions = { spacing: 110, charWidth: 1.25 }): RoadLabel[] {
  const labels: RoadLabel[] = [];
  const { roads, crossings } = map.data;
  // a hosszabb útdarabok kapnak először feliratot
  const lengths = roads.map((road) => {
    const cum = [0];
    for (let i = 0; i + 3 < road.pts.length; i += 2) {
      cum.push(cum[cum.length - 1] + Math.hypot(road.pts[i + 2] - road.pts[i], road.pts[i + 3] - road.pts[i + 1]));
    }
    return cum;
  });
  const order = roads.map((_, i) => i).sort((a, b) => lengths[b][lengths[b].length - 1] - lengths[a][lengths[a].length - 1]);

  for (const index of order) {
    const road = roads[index];
    if (!road.name || !LABELLED.has(road.kind)) continue;
    const cum = lengths[index];
    const total = cum[cum.length - 1];
    const textLen = road.name.length * options.charWidth;
    if (total < textLen + 6) continue;
    const count = Math.max(1, Math.round(total / options.spacing));

    for (let k = 0; k < count; k++) {
      const wanted = (total * (k + 0.5)) / count;
      for (const shift of [0, 8, -8, 16, -16, 24, -24]) {
        const mid = wanted + shift;
        const from = mid - textLen / 2;
        const to = mid + textLen / 2;
        if (from < 3 || to > total - 3) continue;
        const [ax, ay] = pointAt(road.pts, cum, from);
        const [bx, by] = pointAt(road.pts, cum, to);
        const span = Math.hypot(bx - ax, by - ay);
        if (span < 1) continue;
        // elég egyenes-e az út a felirat hosszán?
        let straight = true;
        for (const q of [0.25, 0.5, 0.75]) {
          const [qx, qy] = pointAt(road.pts, cum, from + textLen * q);
          const off = Math.abs((qx - ax) * (by - ay) - (qy - ay) * (bx - ax)) / span;
          if (off > 0.8) straight = false;
        }
        if (!straight) continue;

        let angle = Math.atan2(by - ay, bx - ax);
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle <= -Math.PI / 2) angle += Math.PI;
        let x = (ax + bx) / 2;
        let y = (ay + by) / 2;
        if (CENTRE_LINE.has(road.kind)) {
          // a szöveg „alatti" sáv közepére
          x += -Math.sin(angle) * (road.width / 4);
          y += Math.cos(angle) * (road.width / 4);
        }
        if (crossings.some((cr) => Math.hypot(cr.x - x, cr.y - y) < textLen / 2 + 4)) continue;
        if (labels.some((l) => l.text === road.name && Math.hypot(l.x - x, l.y - y) < options.spacing * 0.6)) continue;
        labels.push({ text: road.name, x, y, angle });
        break;
      }
    }
  }
  return labels;
}
